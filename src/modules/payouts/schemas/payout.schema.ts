import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PayoutStatus =
  | 'verification_pending'
  | 'verification_failed'
  | 'processing'
  | 'successful'
  | 'failed'
  | 'uncertain';

export class PayoutEvent {
  @Prop({ required: true })
  at: Date;

  @Prop({ required: true })
  from: string;

  @Prop({ required: true })
  to: string;

  @Prop({ required: true, enum: ['system', 'webhook', 'operator'] })
  actor: string;

  @Prop({ type: Object, default: {} })
  detail: Record<string, unknown>;
}

export type PayoutDocument = HydratedDocument<Payout>;

@Schema({ timestamps: true, collection: 'payouts' })
export class Payout {
  @Prop({ required: true, unique: true, index: true })
  customerReference: string;

  @Prop({ default: null })
  sourceTransactionRef: string;

  @Prop({ default: null })
  providerPayoutReference: string; // payout.reference returned by provider

  @Prop({ default: null })
  providerPayoutId: string; // links to balance-log debits

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true, default: 'NGN' })
  sourceCurrency: string;

  @Prop({ required: true, default: 'NGN' })
  destinationCurrency: string;

  @Prop({ default: null })
  fee: number;

  @Prop({ default: null })
  rate: number;

  @Prop({ default: null })
  narration: string;

  @Prop({ default: null })
  quoteReference: string;

  @Prop({ type: Object, required: true })
  recipient: {
    name: string;
    accountNumber: string;
    bankCode: string;
    email?: string;
    verifiedName?: string; // name returned by identity/verify-account-number
  };

  @Prop({
    required: true,
    enum: ['verification_pending', 'verification_failed', 'processing', 'successful', 'failed', 'uncertain'],
    default: 'verification_pending',
  })
  status: PayoutStatus;

  @Prop({ default: null })
  failureReason: string;

  @Prop({ type: [Object], default: [] })
  timeline: PayoutEvent[];

  @Prop({ default: 0 })
  attemptCount: number;

  @Prop({ default: null })
  nextRetryAt: Date;

  // Set when the provider API call is first attempted. The recovery scan uses
  // this to find payouts stuck in processing after a process restart.
  @Prop({ default: null })
  submittedToProviderAt: Date | null;

  // Set when status transitions to 'failed' after funds were submitted —
  // i.e., Arikart confirmed failure and credited the wallet back.
  // Null for verification_failed (funds were never debited in the first place).
  // Use this to join against Afrikart's balance log: the corresponding credit
  // entry will appear at or shortly after this timestamp.
  @Prop({ default: null })
  walletCreditAt: Date | null;

  @Prop({ required: true, default: 'afrikart' })
  provider: string;
}

export const PayoutSchema = SchemaFactory.createForClass(Payout);
