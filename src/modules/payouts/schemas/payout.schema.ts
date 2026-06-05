import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PayoutStatus =
  | 'verification_pending'
  | 'verification_failed'
  | 'processing'
  | 'successful'
  | 'failed'
  | 'uncertain';

// Every state transition appended here — the full state machine is auditable
// without reading app logs.
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
  // ─── Our identifiers ──────────────────────────────────────────────────────

  // Caller-supplied stable key — idempotency lock for payout creation.
  // Unique index: a second request with the same customerReference returns
  // the existing payout instead of creating a new one.
  @Prop({ required: true, unique: true, index: true })
  customerReference: string;

  // Sent to Fincra as x-idempotency-key — == customerReference so Fincra
  // also deduplicates if we retry after a timeout.
  @Prop({ required: true })
  idempotencyKey: string;

  // Links back to the collection that triggered this payout (optional)
  @Prop({ default: null })
  sourceTransactionRef: string;

  // ─── Fincra identifiers (populated after successful API call) ─────────────
  @Prop({ default: null })
  fincraPayoutReference: string; // payout.reference returned by Fincra

  @Prop({ default: null })
  fincraPayoutId: string; // payout.id (po_...) — links to balance-log debits

  // ─── Financials ──────────────────────────────────────────────────────────
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

  // ─── Recipient ───────────────────────────────────────────────────────────
  @Prop({ type: Object, required: true })
  recipient: {
    name: string;
    accountNumber: string;
    bankCode: string;
    email?: string;
    verifiedName?: string; // name returned by identity/verify-account-number
  };

  // ─── State machine ───────────────────────────────────────────────────────
  @Prop({
    required: true,
    enum: ['verification_pending', 'verification_failed', 'processing', 'successful', 'failed', 'uncertain'],
    default: 'verification_pending',
  })
  status: PayoutStatus;

  @Prop({ default: null })
  failureReason: string;

  // Append-only state-transition log
  @Prop({ type: [Object], default: [] })
  timeline: PayoutEvent[];

  // ─── Retry tracking ──────────────────────────────────────────────────────
  @Prop({ default: 0 })
  attemptCount: number;

  @Prop({ default: null })
  nextRetryAt: Date;
}

export const PayoutSchema = SchemaFactory.createForClass(Payout);
