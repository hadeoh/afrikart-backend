import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

// Every state change appended to this embedded array — ops can replay the
// lifecycle without touching application logs.
export class TransactionEvent {
  @Prop({ required: true })
  at: Date;

  @Prop({ required: true })
  event: string; // e.g. 'checkout.initiated', 'webhook.collection.successful'

  @Prop({ required: true, enum: ['system', 'webhook', 'operator'] })
  actor: string;

  @Prop({ type: Object, default: {} })
  detail: Record<string, unknown>;
}

export type TransactionDocument = HydratedDocument<Transaction>;

@Schema({ timestamps: true, collection: 'transactions' })
export class Transaction {
  @Prop({ required: true, unique: true, index: true })
  internalRef: string;


  @Prop({ default: null, index: { unique: true, sparse: true } })
  orderId: string | null;

  @Prop({ required: true, enum: ['checkout', 'virtual_account'], default: 'checkout' })
  collectionMethod: string;

  @Prop({ default: null })
  externalPaymentId: string;

  @Prop({ type: Object, default: null })
  virtualAccountInfo: {
    id: string;
    accountNumber: string;
    accountName: string;
    bankName: string;
    bankCode: string;
    status: string;      // pending → approved
    expiresAt: string;
  } | null;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true, default: 'NGN' })
  currency: string;

  @Prop({ type: Object, required: true })
  customer: { name: string; email: string };

  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;

  @Prop({ required: true, enum: ['pending', 'successful', 'failed'], default: 'pending' })
  status: string;

  @Prop({ default: null })
  channel: string; // bank_transfer | card — populated by settlement webhook

  @Prop({ default: null })
  feeAmount: number;

  @Prop({ default: null })
  vatAmount: number;

  @Prop({ default: null })
  checkoutUrl: string;

  @Prop({ type: [Object], default: [] })
  timeline: TransactionEvent[];
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);
