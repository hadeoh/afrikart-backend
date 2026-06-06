import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { TimelineService } from './timeline.service';

@ApiTags('Timeline')
@Controller('timeline')
export class TimelineController {
  constructor(private readonly service: TimelineService) {}

  @Get('transactions/:ref')
  @ApiOperation({ summary: 'Full transaction lifecycle', description: 'Merges the collection timeline with all linked payout timelines, sorted chronologically.' })
  @ApiParam({ name: 'ref', description: 'Transaction internalRef' })
  @ApiResponse({ status: 200, description: 'Chronological event log for the transaction and its payouts' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  async transactionTimeline(@Param('ref') ref: string) {
    const data = await this.service.getTransactionTimeline(ref);
    return { success: true, data };
  }

  @Get('payouts/:customerReference')
  @ApiOperation({ summary: 'Payout lifecycle', description: 'Returns the payout document with its full state-transition timeline.' })
  @ApiParam({ name: 'customerReference', description: 'Caller-supplied payout idempotency key' })
  @ApiResponse({ status: 200, description: 'Payout document with sorted timeline' })
  @ApiResponse({ status: 404, description: 'Payout not found' })
  async payoutTimeline(@Param('customerReference') ref: string) {
    const data = await this.service.getPayoutTimeline(ref);
    return { success: true, data };
  }

  @Get('provider-events')
  @ApiOperation({ summary: 'Provider event log', description: "Fetches events from the provider's own event log for cross-referencing." })
  @ApiQuery({ name: 'event', required: false, description: 'Filter by event type, e.g. collection.successful' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max results (default 50)' })
  @ApiResponse({ status: 200, description: 'Provider event entries' })
  async providerEvents(
    @Query('event') event?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.service.getProviderEvents(event, limit ? +limit : 50);
    return { success: true, data };
  }

  @Get('wallet-logs')
  @ApiOperation({ summary: 'Wallet balance log', description: 'Returns wallet debit/credit entries from the provider — use providerPayoutId to match payout records.' })
  @ApiQuery({ name: 'currency', required: false, example: 'NGN' })
  @ApiQuery({ name: 'type', required: false, enum: ['debit', 'credit'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 20' })
  @ApiResponse({ status: 200, description: 'Wallet log entries' })
  async walletLogs(
    @Query('currency') currency?: string,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.service.getWalletLogs(
      currency,
      type,
      page ? +page : 1,
      limit ? +limit : 20,
    );
    return { success: true, data };
  }
}
