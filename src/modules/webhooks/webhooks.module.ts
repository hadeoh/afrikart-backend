import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProcessedWebhook, ProcessedWebhookSchema } from './schemas/processed-webhook.schema';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { CollectionsModule } from '../collections/collections.module';
import { PayoutsModule } from '../payouts/payouts.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ProcessedWebhook.name, schema: ProcessedWebhookSchema },
    ]),
    CollectionsModule,
    forwardRef(() => PayoutsModule), // circular: PayoutsModule also imports CollectionsModule
  ],
  providers: [WebhooksService],
  controllers: [WebhooksController],
  exports: [WebhooksService],
})
export class WebhooksModule {}
