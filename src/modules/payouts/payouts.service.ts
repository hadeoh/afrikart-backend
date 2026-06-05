import {
  Injectable,
  Logger,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Payout, PayoutDocument, PayoutStatus } from './schemas/payout.schema';
import { AfrikartService } from '../afrikart/afrikart.service';
import { AfrikartApiError } from '../../common/utils/retry.util';
import { CreatePayoutDto } from './dto/create-payout.dto';

// ─── Valid state transitions ─────────────────────────────────────────────────
// Enforced in transition() so no code path can move state backward or skip steps.
const ALLOWED_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
  verification_pending: ['verification_failed', 'processing'],
  verification_failed: [],
  processing: ['successful', 'failed', 'uncertain'],
  successful: [],
  failed: [],
  uncertain: ['successful', 'failed'], // ops can manually re-check and resolve
};

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);
  private readonly uncertaintyThresholdMs: number;

  constructor(
    @InjectModel(Payout.name) private readonly payoutModel: Model<PayoutDocument>,
    private readonly fincra: AfrikartService,
    private readonly config: ConfigService,
  ) {
    this.uncertaintyThresholdMs = this.config.get<number>('payoutUncertaintyThresholdMs');
  }

  // ─── Create (idempotent) ──────────────────────────────────────────────────
  async createPayout(dto: CreatePayoutDto): Promise<PayoutDocument> {
    // (b) Idempotency: if a payout with this customerReference already exists,
    // return it — no second API call to Fincra.
    const existing = await this.payoutModel.findOne({
      customerReference: dto.customerReference,
    });
    if (existing) {
      this.logger.log(`Idempotent payout return: ${dto.customerReference}`);
      return existing;
    }

    // 1. Verify destination account before touching any funds
    let verifiedName: string | null = null;
    const payout = await this.payoutModel.create({
      customerReference: dto.customerReference,
      idempotencyKey: dto.customerReference, // same key → Fincra also dedupes
      sourceTransactionRef: dto.sourceTransactionRef ?? null,
      amount: dto.amount,
      sourceCurrency: dto.sourceCurrency ?? 'NGN',
      destinationCurrency: dto.destinationCurrency ?? dto.sourceCurrency ?? 'NGN',
      narration: dto.narration ?? 'Afrikart payout',
      quoteReference: dto.quoteReference ?? null,
      recipient: { ...dto.recipient },
      status: 'verification_pending',
      timeline: [
        {
          at: new Date(),
          from: 'init',
          to: 'verification_pending',
          actor: 'system',
          detail: { amount: dto.amount, recipient: dto.recipient },
        },
      ],
    });

    try {
      const verifyRes: any = await this.fincra.verifyAccountNumber({
        accountNumber: dto.recipient.accountNumber,
        bankCode: dto.recipient.bankCode,
      });

      const resolved = verifyRes?.data?.resolved ?? verifyRes?.resolved;
      verifiedName = verifyRes?.data?.accountName ?? verifyRes?.accountName ?? null;

      if (!resolved || !verifiedName) {
        return this.transition(payout, 'verification_failed', 'system', {
          reason: 'Account not found',
        });
      }

      // Name mismatch check — warn but do not block (name formatting varies)
      const recipientNorm = dto.recipient.name.toLowerCase().replace(/\s+/g, '');
      const verifiedNorm = verifiedName.toLowerCase().replace(/\s+/g, '');
      if (!verifiedNorm.includes(recipientNorm) && !recipientNorm.includes(verifiedNorm)) {
        this.logger.warn(
          `Name mismatch on ${dto.customerReference}: expected "${dto.recipient.name}", got "${verifiedName}"`,
        );
        // Treat as verification failure — safe outcome: no funds move
        return this.transition(payout, 'verification_failed', 'system', {
          reason: `Name mismatch: expected "${dto.recipient.name}", resolved "${verifiedName}"`,
          verifiedName,
        });
      }
    } catch (err) {
      if (err instanceof AfrikartApiError && err.statusCode === 404) {
        return this.transition(payout, 'verification_failed', 'system', {
          reason: 'Account not found (404)',
        });
      }
      // Unexpected error during verification — fail safely
      return this.transition(payout, 'verification_failed', 'system', {
        reason: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 2. Account verified — update recipient with resolved name and advance state
    await this.payoutModel.findByIdAndUpdate(payout._id, {
      $set: { 'recipient.verifiedName': verifiedName },
    });

    const afterVerify = await this.transition(payout, 'processing', 'system', {
      verifiedName,
    });

    // 3. Submit to Fincra
    await this.submitToFincra(afterVerify, dto);

    // 4. Schedule uncertainty check
    this.scheduleUncertaintyCheck(afterVerify._id.toString());

    return this.payoutModel.findById(afterVerify._id);
  }

  private async submitToFincra(payout: PayoutDocument, dto: CreatePayoutDto) {
    try {
      const res: any = await this.fincra.createPayout(
        {
          amount: dto.amount,
          sourceCurrency: dto.sourceCurrency ?? 'NGN',
          destinationCurrency: dto.destinationCurrency ?? dto.sourceCurrency ?? 'NGN',
          customerReference: dto.customerReference,
          narration: dto.narration ?? 'Afrikart payout',
          quoteReference: dto.quoteReference,
          recipient: dto.recipient,
        },
        payout.idempotencyKey,
      );

      const payoutData = res?.data ?? res;
      await this.payoutModel.findByIdAndUpdate(payout._id, {
        $set: {
          fincraPayoutReference: payoutData?.reference ?? null,
          fincraPayoutId: payoutData?.id ?? null,
          fee: payoutData?.fee ?? null,
          rate: payoutData?.rate ?? null,
        },
        $push: {
          timeline: {
            at: new Date(),
            from: 'processing',
            to: 'processing',
            actor: 'system',
            detail: {
              note: 'Submitted to Fincra',
              fincraRef: payoutData?.reference,
              fincraId: payoutData?.id,
            },
          },
        },
        $inc: { attemptCount: 1 },
      });
    } catch (err) {
      // Chaos or network failure during submission — payout stays PROCESSING.
      // Idempotency key means a retry will return the cached result from Fincra
      // if it went through. If it didn't, the webhook never arrives and the
      // uncertainty timer fires.
      this.logger.error(
        `Fincra payout submission failed for ${payout.customerReference}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.payoutModel.findByIdAndUpdate(payout._id, {
        $push: {
          timeline: {
            at: new Date(),
            from: 'processing',
            to: 'processing',
            actor: 'system',
            detail: {
              note: 'Fincra submission error — webhook will confirm or uncertainty timer will fire',
              error: err instanceof Error ? err.message : String(err),
            },
          },
        },
        $inc: { attemptCount: 1 },
      });
    }
  }

  // ─── Webhook handler (called by WebhooksService) ─────────────────────────
  async applyPayoutWebhook(
    customerReference: string,
    status: 'successful' | 'failed',
    data: Record<string, unknown>,
  ) {
    const payout = await this.payoutModel.findOne({ customerReference });
    if (!payout) {
      this.logger.warn(`Payout webhook for unknown customerReference: ${customerReference}`);
      return;
    }

    const targetStatus: PayoutStatus = status === 'successful' ? 'successful' : 'failed';
    const allowed = ALLOWED_TRANSITIONS[payout.status] ?? [];

    if (!allowed.includes(targetStatus)) {
      // Already in a terminal state — idempotent, ignore
      this.logger.warn(
        `Payout ${customerReference}: ignoring ${targetStatus} webhook from ${payout.status}`,
      );
      return;
    }

    await this.transition(payout, targetStatus, 'webhook', {
      fincraData: data,
      reason: status === 'failed' ? (data.reason as string ?? 'Payout failed') : undefined,
    });

    if (targetStatus === 'failed') {
      this.logger.warn(
        `Payout ${customerReference} failed — Fincra has restored the wallet balance`,
      );
    }
  }

  // ─── Uncertainty check ───────────────────────────────────────────────────
  // Scheduled after submission; fires when no webhook has arrived within the threshold.
  private scheduleUncertaintyCheck(payoutId: string) {
    setTimeout(async () => {
      const payout = await this.payoutModel.findById(payoutId);
      if (!payout || payout.status !== 'processing') return;

      this.logger.warn(
        `Payout ${payout.customerReference} still PROCESSING after ${this.uncertaintyThresholdMs}ms — marking UNCERTAIN`,
      );
      await this.transition(payout, 'uncertain', 'system', {
        reason: `No webhook received within ${this.uncertaintyThresholdMs}ms threshold`,
        thresholdMs: this.uncertaintyThresholdMs,
      });
    }, this.uncertaintyThresholdMs);
  }

  // ─── State machine transition ─────────────────────────────────────────────
  private async transition(
    payout: PayoutDocument,
    to: PayoutStatus,
    actor: 'system' | 'webhook' | 'operator',
    detail: Record<string, unknown> = {},
  ): Promise<PayoutDocument> {
    const from = payout.status;
    const allowed = ALLOWED_TRANSITIONS[from] ?? [];

    if (!allowed.includes(to)) {
      throw new Error(
        `Invalid payout transition: ${from} → ${to} for ${payout.customerReference}`,
      );
    }

    const update: any = {
      $set: { status: to },
      $push: {
        timeline: { at: new Date(), from, to, actor, detail },
      },
    };

    if (to === 'failed' && detail.reason) {
      update.$set.failureReason = detail.reason as string;
    }

    return this.payoutModel.findByIdAndUpdate(payout._id, update, { new: true });
  }

  // ─── Queries ──────────────────────────────────────────────────────────────
  async getByCustomerRef(customerReference: string): Promise<PayoutDocument> {
    const p = await this.payoutModel.findOne({ customerReference });
    if (!p) throw new NotFoundException(`Payout ${customerReference} not found`);
    return p;
  }

  async list(status?: string): Promise<any[]> {
    const filter = status ? { status } : {};
    return this.payoutModel.find(filter).sort({ createdAt: -1 }).lean();
  }
}
