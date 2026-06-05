import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Transaction, TransactionDocument } from './schemas/transaction.schema';
import { AfrikartService } from '../afrikart/afrikart.service';
import { InitiateCheckoutDto } from './dto/initiate-checkout.dto';
import { generateRef } from '../../common/utils/reference.util';

@Injectable()
export class CollectionsService {
  private readonly logger = new Logger(CollectionsService.name);

  constructor(
    @InjectModel(Transaction.name) private readonly txnModel: Model<TransactionDocument>,
    private readonly fincra: AfrikartService,
  ) {}

  async initiateCheckout(dto: InitiateCheckoutDto) {
    const internalRef = dto.reference ?? generateRef('ord');

    // UI double-submit guard: check before calling API 
    const existing = await this.txnModel.findOne({ internalRef }).lean();
    if (existing) {
      throw new ConflictException(
        `A transaction with reference "${internalRef}" already exists`,
      );
    }

    // Call sandbox — subject to chaos-mode 503; service retries up to 3x
    const fincraRes: any = await this.fincra.initiateCheckout({
      ...dto,
      reference: internalRef,
    });

    const payment = fincraRes.data?.payment ?? {};

    // Persist immediately so the timeline starts at the right moment
    const txn = await this.txnModel.create({
      internalRef,
      externalPaymentId: payment.id ?? null,
      amount: dto.amount,
      currency: dto.currency ?? 'NGN',
      customer: dto.customer,
      metadata: dto.metadata ?? {},
      status: 'pending',
      checkoutUrl: fincraRes.data?.checkoutUrl ?? null,
      timeline: [
        {
          at: new Date(),
          event: 'checkout.initiated',
          actor: 'system',
          detail: {
            amount: dto.amount,
            currency: dto.currency ?? 'NGN',
            fincraPaymentId: payment.id ?? null,
          },
        },
      ],
    });

    this.logger.log(`Checkout initiated: ${internalRef}`);
    return {
      internalRef: txn.internalRef,
      checkoutUrl: txn.checkoutUrl,
      status: txn.status,
      fincraPaymentId: txn.externalPaymentId,
    };
  }

  async getByRef(internalRef: string): Promise<any> {
    const txn = await this.txnModel.findOne({ internalRef }).lean();
    if (!txn) throw new NotFoundException(`Transaction ${internalRef} not found`);
    return txn;
  }

  // Called by WebhooksService when a collection webhook arrives
  async applyCollectionWebhook(
    internalRef: string,
    status: 'successful' | 'failed',
    webhookData: Record<string, unknown>,
  ) {
    const newStatus = status === 'successful' ? 'successful' : 'failed';
    const update = await this.txnModel.findOneAndUpdate(
      { internalRef, status: 'pending' }, // only advance from pending
      {
        $set: {
          status: newStatus,
          channel: webhookData.paymentSource as string ?? null,
          feeAmount: webhookData.fee as number ?? null,
          vatAmount: webhookData.vat as number ?? null,
          // Backfill fincraPaymentId if somehow missing from checkout response
          ...(webhookData.id ? { externalPaymentId: webhookData.id } : {}),
        },
        $push: {
          timeline: {
            at: new Date(),
            event: `webhook.collection.${status}`,
            actor: 'webhook',
            detail: webhookData,
          },
        },
      },
      { new: true },
    );

    if (!update) {
      // Transaction either doesn't exist or has already been settled — both
      // are fine: duplicate webhooks will hit this branch and be discarded.
      this.logger.warn(
        `Collection webhook for ${internalRef} had no effect (already settled or not found)`,
      );
    } else {
      this.logger.log(`Collection ${internalRef} → ${newStatus}`);
    }
  }
}
