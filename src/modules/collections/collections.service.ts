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
    private readonly afrikart: AfrikartService,
  ) {}

  private async guardOrderId(orderId: string | undefined) {
    if (!orderId) return;
    const conflict = await this.txnModel.findOne({ orderId }).lean();
    if (conflict) {
      throw new ConflictException(
        `Order "${orderId}" already has an active payment. Cancel it before opening a new one.`,
      );
    }
  }

  async initiateCheckout(dto: InitiateCheckoutDto) {
    const internalRef = dto.reference ?? generateRef('ord');

    await this.guardOrderId(dto.orderId);

    const existing = await this.txnModel.findOne({ internalRef }).lean() as any;
    if (existing) {
      this.logger.log(`Checkout idempotent hit: ${internalRef}`);
      return {
        idempotent: true,
        collectionMethod: 'checkout' as const,
        internalRef: existing.internalRef,
        checkoutUrl: existing.checkoutUrl ?? null,
        status: existing.status,
        externalPaymentId: existing.externalPaymentId ?? null,
      };
    }

    const afrikartRes: any = await this.afrikart.initiateCheckout({
      ...dto,
      reference: internalRef,
    });

    const payment = afrikartRes.data?.payment ?? {};

    const txn = await this.txnModel.create({
      internalRef,
      orderId: dto.orderId ?? null,
      collectionMethod: 'checkout',
      externalPaymentId: payment.id ?? null,
      amount: dto.amount,
      currency: dto.currency ?? 'NGN',
      customer: dto.customer,
      metadata: dto.metadata ?? {},
      status: 'pending',
      checkoutUrl: afrikartRes.data?.checkoutUrl ?? null,
      timeline: [
        {
          at: new Date(),
          event: 'checkout.initiated',
          actor: 'system',
          detail: {
            amount: dto.amount,
            currency: dto.currency ?? 'NGN',
            externalPaymentId: payment.id ?? null,
          },
        },
      ],
    });

    this.logger.log(`Checkout initiated: ${internalRef}`);
    return {
      idempotent: false,
      collectionMethod: 'checkout' as const,
      internalRef: txn.internalRef,
      checkoutUrl: txn.checkoutUrl,
      status: txn.status,
      externalPaymentId: txn.externalPaymentId ?? null,
    };
  }

  async getByRef(internalRef: string): Promise<any> {
    const txn = await this.txnModel.findOne({ internalRef }).lean();
    if (!txn) throw new NotFoundException(`Transaction ${internalRef} not found`);
    return txn;
  }

  async syncCollectionStatus(internalRef: string): Promise<{ synced: boolean; data: any }> {
    const txn = await this.txnModel.findOne({ internalRef }).lean() as any;
    if (!txn) throw new NotFoundException(`Transaction ${internalRef} not found`);

    if (txn.status !== 'pending') {
      return { synced: false, data: txn };
    }

    const providerRes: any = await this.afrikart.getPaymentByReference(internalRef);
    const payment = providerRes?.data ?? providerRes;
    const providerStatus: string = payment?.status;

    if (providerStatus !== 'successful' && providerStatus !== 'failed') {
      return { synced: false, data: txn };
    }

    await this.applyCollectionWebhook(internalRef, providerStatus, {
      id: payment.id,
      paymentSource: payment.channel ?? null,
      fee: payment.fee ?? null,
      vat: payment.vat ?? null,
    });

    this.logger.log(`Collection ${internalRef} synced from provider: ${providerStatus}`);
    const updated = await this.txnModel.findOne({ internalRef }).lean();
    return { synced: true, data: updated };
  }

  async applyCollectionWebhook(
    internalRef: string,
    status: 'successful' | 'failed',
    webhookData: Record<string, unknown>,
  ) {
    const newStatus = status === 'successful' ? 'successful' : 'failed';
    const update = await this.txnModel.findOneAndUpdate(
      { internalRef, status: 'pending' },
      {
        $set: {
          status: newStatus,
          channel: webhookData.paymentSource as string ?? null,
          feeAmount: webhookData.fee as number ?? null,
          vatAmount: webhookData.vat as number ?? null,
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
      this.logger.warn(
        `Collection webhook for ${internalRef} had no effect (already settled or not found)`,
      );
    } else {
      this.logger.log(`Collection ${internalRef} -> ${newStatus}`);
    }
  }
}
