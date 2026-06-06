import { Controller, Post, Headers, Req, HttpCode } from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { WebhooksService } from './webhooks.service';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly service: WebhooksService) {}

  @Post('fincra')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive a Fincra webhook event',
    description: 'Validates the HMAC-SHA512 signature, deduplicates by event ID, then routes to the appropriate domain service. Safe to replay — duplicate deliveries are detected and ignored.',
  })
  @ApiHeader({ name: 'x-fincra-signature', description: 'HMAC-SHA512 hex digest of the raw request body', required: true })
  @ApiResponse({ status: 200, description: 'Event accepted (processed:true) or skipped as duplicate (processed:false)' })
  @ApiResponse({ status: 401, description: 'Missing or invalid signature' })
  @ApiResponse({ status: 400, description: 'Malformed body or missing required fields' })
  handleFincra(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-fincra-signature') signature: string,
  ) {
    return this.service.processIncoming(req.rawBody, signature);
  }
}
