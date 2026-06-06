import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProcessedWebhookDocument = HydratedDocument<ProcessedWebhook>;

@Schema({ collection: 'processed_webhooks' })
export class ProcessedWebhook {
  @Prop({ required: true, unique: true, index: true })
  eventId: string;

  @Prop({ required: true })
  eventType: string;

  @Prop({ default: null })
  externalPaymentId: string | null;

  @Prop({ required: true, default: () => new Date() })
  processedAt: Date;
}

export const ProcessedWebhookSchema = SchemaFactory.createForClass(ProcessedWebhook);

// Auto-expire records after 30 days — keeps the collection bounded
ProcessedWebhookSchema.index({ processedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
