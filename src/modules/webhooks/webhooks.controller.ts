import {
  Controller,
  Post,
  Headers,
  Req,
  HttpCode,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { createHash } from 'crypto';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly service: WebhooksService) {}

  // POST /webhooks/fincra
  // The sandbox sends to WEBHOOK_TARGET_URL; we point that to this endpoint.
  @Post('fincra')
  @HttpCode(200)
  async handleFincra(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-fincra-signature') signature: string,
  ) {
    // 1. Signature check — uses raw bytes, not re-serialized body
    if (!signature) {
      throw new UnauthorizedException('Missing x-fincra-signature header');
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException('Raw body unavailable — check server rawBody config');
    }

    const valid = this.service.verifySignature(rawBody, signature);
    if (!valid) {
      this.logger.warn('Webhook rejected: invalid signature');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // 2. Parse the envelope — rawBody is the authoritative source
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

    // 3. Event ID comes from the sandbox's event log entry id.
    // Fallback: SHA-256 of the raw body — deterministic for the same payload,
    // so a replay of an event with no id still deduplicates correctly.
    // Date.now() would be non-deterministic and let duplicates through.
    const fincraEventId =
      (data.id as string) ??
      (data.reference as string
        ? `${event}:${data.reference}`
        : `sha256:${createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}`);

    // 4. Idempotency + dispatch
    const result = await this.service.handleEvent(fincraEventId, event, data);

    return {
      success: true,
      processed: result.processed,
      reason: result.reason,
    };
  }
}
