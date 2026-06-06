import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Payout, PayoutDocument, PayoutStatus } from './schemas/payout.schema';
import { AfrikartService } from '../afrikart/afrikart.service';
import { AfrikartApiError } from '../../common/utils/retry.util';
import { CreatePayoutDto } from './dto/create-payout.dto';

// ─── State machine ────────────────────────────────────────────────────────────
// ALLOWED_TRANSITIONS: what states a given state may advance TO.
const ALLOWED_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
  verification_pending: ['verification_failed', 'processing'],
  verification_failed: [],
  processing: ['successful', 'failed', 'uncertain'],
  successful: [],
  failed: [],
  uncertain: ['successful', 'failed'],
};

// ALLOWED_FROM: which states may precede a given target state.
// Derived by inverting ALLOWED_TRANSITIONS — used to build atomic DB filters
// so concurrent writes can't move state backward or skip steps.
const ALLOWED_FROM: Record<PayoutStatus, PayoutStatus[]> = {
  verification_pending: [],
  verification_failed: ['verification_pending'],
  processing: ['verification_pending'],
  successful: ['processing', 'uncertain'],
  failed: ['processing', 'uncertain'],
  uncertain: ['processing'],
};

@Injectable()
export class PayoutsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PayoutsService.name);
  private readonly uncertaintyThresholdMs: number;
  private recoveryIntervalHandle: NodeJS.Timeout;

  constructor(
    @InjectModel(Payout.name) private readonly payoutModel: Model<PayoutDocument>,
    private readonly afrikart: AfrikartService,
    private readonly config: ConfigService,
  ) {
    this.uncertaintyThresholdMs = this.config.get<number>('payoutUncertaintyThresholdMs');
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────
  // On startup: immediately recover any payouts that were stuck in PROCESSING
  // before the last restart, then keep a 30s poll running for new ones.
  async onModuleInit() {
    await this.recoverUncertainPayouts();
    this.recoveryIntervalHandle = setInterval(
      () => this.recoverUncertainPayouts(),
      30_000,
    );
  }

  async onModuleDestroy() {
    clearInterval(this.recoveryIntervalHandle);
  }

  async createPayout(dto: CreatePayoutDto): Promise<PayoutDocument> {
    const existing = await this.payoutModel.findOne({
      customerReference: dto.customerReference,
    });
    if (existing) {
      this.logger.log(`Idempotent payout return: ${dto.customerReference}`);
      return existing;
    }

    const payout = await this.payoutModel.create({
      customerReference: dto.customerReference,
      sourceTransactionRef: dto.sourceTransactionRef ?? null,
      provider: dto.provider ?? 'afrikart',
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

    let verifiedName: string | null = null;
    try {
      const verifyRes: any = await this.afrikart.verifyAccountNumber({
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

      const recipientNorm = dto.recipient.name.toLowerCase().replace(/\s+/g, '');
      const verifiedNorm = verifiedName.toLowerCase().replace(/\s+/g, '');
      if (!verifiedNorm.includes(recipientNorm) && !recipientNorm.includes(verifiedNorm)) {
        this.logger.warn(
          `Name mismatch on ${dto.customerReference}: expected "${dto.recipient.name}", got "${verifiedName}"`,
        );
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
      return this.transition(payout, 'verification_failed', 'system', {
        reason: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    await this.payoutModel.findByIdAndUpdate(payout._id, {
      $set: { 'recipient.verifiedName': verifiedName },
    });

    const afterVerify = await this.transition(payout, 'processing', 'system', {
      verifiedName,
    });

    await this.submitToProvider(afterVerify, dto);

    return this.payoutModel.findById(afterVerify._id);
  }

  async getByCustomerRef(customerReference: string): Promise<PayoutDocument> {
    const p = await this.payoutModel.findOne({ customerReference });
    if (!p) throw new NotFoundException(`Payout ${customerReference} not found`);
    return p;
  }

  async list(status?: string): Promise<any[]> {
    const filter = status ? { status } : {};
    return this.payoutModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  // ─── Webhook handler (called by WebhooksService) ──────────────────────────
  // Uses findOneAndUpdate with the status filter as an atomic guard — if a
  // concurrent delivery already advanced state, the update matches nothing
  // and we log a warning rather than moving state backward.
  async applyPayoutWebhook(
    customerReference: string,
    status: 'successful' | 'failed',
    data: Record<string, unknown>,
  ) {
    const targetStatus: PayoutStatus = status === 'successful' ? 'successful' : 'failed';
    const allowedFrom = ALLOWED_FROM[targetStatus]; 

    const updated = await this.payoutModel.findOneAndUpdate(
      { customerReference, status: { $in: allowedFrom } },
      {
        $set: {
          status: targetStatus,
          ...(targetStatus === 'failed'
            ? {
                failureReason: (data.reason as string) ?? 'Payout failed',
                // Funds were submitted before the webhook arrived, so Afrikart
                // has credited the wallet back. Record when so reconciliation
                // can match this against the balance log without manual lookup.
                walletCreditAt: new Date(),
              }
            : {}),
        },
        $push: {
          timeline: {
            at: new Date(),
            from: allowedFrom[0], // processing or uncertain — both are valid prior states
            to: targetStatus,
            actor: 'webhook',
            detail: data,
          },
        },
      },
      { new: true },
    );

    if (!updated) {
      this.logger.warn(
        `Payout ${customerReference}: ignoring ${targetStatus} webhook — already in terminal state`,
      );
      return;
    }

    if (targetStatus === 'failed') {
      this.logger.warn(
        `Payout ${customerReference} failed — provider has restored the wallet balance`,
      );
    } else {
      this.logger.log(`Payout ${customerReference} → ${targetStatus}`);
    }
  }

  // Finds every payout that has been PROCESSING longer than the threshold and
  // atomically moves each one to UNCERTAIN. The findOneAndUpdate filter includes
  // `status: 'processing'` so a concurrent webhook that already settled the
  // payout will cause the update to match nothing — no backward movement.
  async recoverUncertainPayouts() {
    const cutoff = new Date(Date.now() - this.uncertaintyThresholdMs);
    const stale: any[] = await this.payoutModel
      .find({ status: 'processing', submittedToProviderAt: { $lt: cutoff } })
      .lean();

    await Promise.all(
      stale.map(async (p) => {
        const updated = await this.payoutModel.findOneAndUpdate(
          { _id: p._id, status: 'processing' },
          {
            $set: { status: 'uncertain' },
            $push: {
              timeline: {
                at: new Date(),
                from: 'processing',
                to: 'uncertain',
                actor: 'system',
                detail: {
                  reason: 'No webhook received within threshold',
                  thresholdMs: this.uncertaintyThresholdMs,
                },
              },
            },
          },
          { new: true },
        );
        if (updated) {
          this.logger.warn(`Recovered uncertain payout: ${p.customerReference}`);
        }
      }),
    );
  }

  // ─── State machine transition (used inside createPayout only) ────────────
  // createPayout is sequential — no concurrent writes during the creation
  // flow — so a simple findByIdAndUpdate is safe here.
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
      $push: { timeline: { at: new Date(), from, to, actor, detail } },
    };

    if (to === 'failed' && detail.reason) {
      update.$set.failureReason = detail.reason as string;
    }

    return this.payoutModel.findByIdAndUpdate(payout._id, update, { new: true });
  }

  private async submitToProvider(payout: PayoutDocument, dto: CreatePayoutDto) {
    try {
      const res: any = await this.afrikart.createPayout(
        {
          amount: dto.amount,
          sourceCurrency: dto.sourceCurrency ?? 'NGN',
          destinationCurrency: dto.destinationCurrency ?? dto.sourceCurrency ?? 'NGN',
          customerReference: dto.customerReference,
          narration: dto.narration ?? 'Afrikart payout',
          quoteReference: dto.quoteReference,
          recipient: dto.recipient,
        },
        payout.customerReference,
      );

      const payoutData = res?.data ?? res;
      await this.payoutModel.findByIdAndUpdate(payout._id, {
        $set: {
          providerPayoutReference: payoutData?.reference ?? null,
          providerPayoutId: payoutData?.id ?? null,
          fee: payoutData?.fee ?? null,
          rate: payoutData?.rate ?? null,
          submittedToProviderAt: new Date(), // recovery scan uses this timestamp
        },
        $push: {
          timeline: {
            at: new Date(),
            from: 'processing',
            to: 'processing',
            actor: 'system',
            detail: {
              note: 'Submitted to provider',
              provider: payout.provider,
              providerRef: payoutData?.reference,
              providerId: payoutData?.id,
            },
          },
        },
        $inc: { attemptCount: 1 },
      });
    } catch (err) {
      // Deterministic provider rejection — the request was definitively refused,
      // no funds moved, no webhook will ever arrive.
      if (err instanceof AfrikartApiError && err.errorType === 'INSUFFICIENT_FUNDS') {
        this.logger.warn(
          `Payout ${payout.customerReference} rejected: insufficient balance`,
        );
        await this.transition(payout, 'failed', 'system', {
          reason: 'Insufficient balance',
          errorType: err.errorType,
        });
        throw new UnprocessableEntityException({
          error: 'Insufficient balance',
          errorType: 'INSUFFICIENT_FUNDS',
        });
      }

      // Transient or unknown error — the request may or may not have reached
      // the provider. Leave in PROCESSING; the recovery scan will mark it
      // UNCERTAIN if no webhook arrives within the threshold.
      this.logger.error(
        `Payout submission failed for ${payout.customerReference}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.payoutModel.findByIdAndUpdate(payout._id, {
        $set: { submittedToProviderAt: new Date() },
        $push: {
          timeline: {
            at: new Date(),
            from: 'processing',
            to: 'processing',
            actor: 'system',
            detail: {
              note: 'Provider submission error — recovery scan will mark UNCERTAIN if no webhook arrives',
              error: err instanceof Error ? err.message : String(err),
            },
          },
        },
        $inc: { attemptCount: 1 },
      });
    }
  }
}
