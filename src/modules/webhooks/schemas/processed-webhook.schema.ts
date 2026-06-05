import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProcessedWebhookDocument = HydratedDocument<ProcessedWebhook>;

@Schema({ collection: 'processed_webhooks' })
export class ProcessedWebhook {
  // Fincra's event ID (evt_...) — unique index is the idempotency lock.
  // A duplicate-key error on insert means we've already processed this event.
  @Prop({ required: true, unique: true, index: true })
  fincraEventId: string;

  @Prop({ required: true })
  eventType: string;

  @Prop({ required: true, default: () => new Date() })
  processedAt: Date;
}

export const ProcessedWebhookSchema = SchemaFactory.createForClass(ProcessedWebhook);

// Auto-expire records after 30 days — keeps the collection bounded
ProcessedWebhookSchema.index({ processedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
