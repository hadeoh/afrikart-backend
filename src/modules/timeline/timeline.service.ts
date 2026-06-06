import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Transaction, TransactionDocument } from '../collections/schemas/transaction.schema';
import { Payout, PayoutDocument } from '../payouts/schemas/payout.schema';
import { AfrikartService } from '../afrikart/afrikart.service';

@Injectable()
export class TimelineService {
  constructor(
    @InjectModel(Transaction.name) private readonly txnModel: Model<TransactionDocument>,
    @InjectModel(Payout.name) private readonly payoutModel: Model<PayoutDocument>,
    private readonly afrikart: AfrikartService,
  ) {}

  // ─── Full transaction lifecycle ───────────────────────────────────────────
  // Returns one chronological view that answers "what happened to order X?"
  // without reading app logs. Includes all linked payouts.
  async getTransactionTimeline(internalRef: string) {
    const txn = await this.txnModel.findOne({ internalRef }).lean();
    if (!txn) throw new NotFoundException(`Transaction ${internalRef} not found`);

    // Find all payouts linked to this transaction
    const payouts = await this.payoutModel
      .find({ sourceTransactionRef: internalRef })
      .lean();

    // Merge and sort all events chronologically
    const events = [
      ...txn.timeline.map((e) => ({ ...e, source: 'transaction' })),
      ...payouts.flatMap((p) =>
        p.timeline.map((e) => ({
          ...e,
          source: 'payout',
          payoutRef: p.customerReference,
          payoutStatus: p.status,
        })),
      ),
    ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    return {
      transaction: {
        internalRef: txn.internalRef,
        externalPaymentId: txn.externalPaymentId,
        amount: txn.amount,
        currency: txn.currency,
        customer: txn.customer,
        status: txn.status,
        channel: txn.channel,
      },
      payouts: payouts.map((p) => ({
        customerReference: p.customerReference,
        providerPayoutReference: p.providerPayoutReference,
        amount: p.amount,
        status: p.status,
        failureReason: p.failureReason,
        recipient: p.recipient,
      })),
      timeline: events,
    };
  }

  // ─── Payout lifecycle only ────────────────────────────────────────────────
  async getPayoutTimeline(customerReference: string) {
    const payout = await this.payoutModel.findOne({ customerReference }).lean();
    if (!payout) throw new NotFoundException(`Payout ${customerReference} not found`);

    return {
      payout: {
        customerReference: payout.customerReference,
        providerPayoutReference: payout.providerPayoutReference,
        providerPayoutId: payout.providerPayoutId,
        amount: payout.amount,
        status: payout.status,
        failureReason: payout.failureReason,
        recipient: payout.recipient,
        attemptCount: payout.attemptCount,
      },
      timeline: payout.timeline.sort(
        (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
      ),
    };
  }

  // ─── Provider event log (Fincra's side) ──────────────────────────────────
  async getProviderEvents(eventType?: string, limit = 50) {
    const res: any = await this.afrikart.getEvents(eventType, limit);
    return res?.data ?? res;
  }

  // ─── Wallet movement log (Fincra's side) ─────────────────────────────────
  async getWalletLogs(currency?: string, type?: string, page = 1, limit = 20) {
    const res: any = await this.afrikart.getWalletLogs(currency, type, page, limit);
    return res?.data ?? res;
  }
}
