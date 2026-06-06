import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { ProcessedWebhook, ProcessedWebhookDocument } from './schemas/processed-webhook.schema';
import { CollectionsService } from '../collections/collections.service';
import { PayoutsService } from '../payouts/payouts.service';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @InjectModel(ProcessedWebhook.name)
    private readonly processedModel: Model<ProcessedWebhookDocument>,
    private readonly config: ConfigService,
    private readonly collections: CollectionsService,
    private readonly payouts: PayoutsService,
  ) {}

  async processIncoming(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<{ success: boolean; processed: boolean; reason?: string }> {
    if (!signature) {
      throw new UnauthorizedException('Missing x-fincra-signature header');
    }
    if (!rawBody) {
      throw new BadRequestException('Raw body unavailable — check server rawBody config');
    }

    if (!this.verifySignature(rawBody, signature)) {
      this.logger.warn('Webhook rejected: invalid signature');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let envelope: { event: string; data: Record<string, unknown> };
    try {
      envelope = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Malformed JSON body');
    }

    const { event, data } = envelope;
    if (!event || !data) {
      throw new BadRequestException('Missing event or data field');
    }

    const eventId =
      (data.id as string) ??
      (data.reference
        ? `${event}:${data.reference}`
        : `sha256:${createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}`);

    const result = await this.handleEvent(eventId, event, data);
    return { success: true, ...result };
  }

  // ─── Signature verification ──────────────────────────────────────────────
  // The sandbox signs JSON.stringify({event, data}) with HMAC-SHA512.
  // We receive those exact bytes in rawBody and compare with timingSafeEqual
  // to prevent timing attacks.
  verifySignature(rawBody: Buffer, signature: string): boolean {
    const secret = this.config.get<string>('afrikart.webhookSecret');
    if (!secret) return false;
    const expected = createHmac('sha512', secret)
      .update(rawBody)
      .digest('hex');
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  async handleEvent(
    eventId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<{ processed: boolean; reason?: string }> {
    // Attempt atomic insert. A MongoServerError with code 11000 means the
    // unique index on fincraEventId fired — this is a duplicate delivery.
    try {
      await this.processedModel.create({
        eventId: eventId,
        eventType,
        externalPaymentId: (data.id as string) ?? null,
        processedAt: new Date(),
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        this.logger.warn(`Duplicate webhook ignored: ${eventId} (${eventType})`);
        return { processed: false, reason: 'duplicate' };
      }
      throw err;
    }

    // Route to the appropriate domain service
    await this.dispatch(eventType, data);
    this.logger.log(`Webhook processed: ${eventId} → ${eventType}`);
    return { processed: true };
  }

  private async dispatch(eventType: string, data: Record<string, unknown>) {
    switch (eventType) {
      case 'collection.successful':
        await this.collections.applyCollectionWebhook(
          data.reference as string,
          'successful',
          data,
        );
        break;

      case 'collection.failed':
        await this.collections.applyCollectionWebhook(
          data.reference as string,
          'failed',
          data,
        );
        break;

      case 'charge.successful':
        // charge webhooks carry a Payment object; reference is data.reference
        await this.collections.applyCollectionWebhook(
          data.reference as string,
          'successful',
          data,
        );
        break;

      case 'charge.failed':
        await this.collections.applyCollectionWebhook(
          data.reference as string,
          'failed',
          data,
        );
        break;

      case 'payout.successful':
        await this.payouts.applyPayoutWebhook(
          data.customerReference as string,
          'successful',
          data,
        );
        break;

      case 'payout.failed':
        await this.payouts.applyPayoutWebhook(
          data.customerReference as string,
          'failed',
          data,
        );
        break;

      default:
        this.logger.log(`Unhandled webhook type: ${eventType} — stored, not dispatched`);
    }
  }
}
