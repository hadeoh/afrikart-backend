import { Controller, Get, Param, Query } from '@nestjs/common';
import { TimelineService } from './timeline.service';

@Controller('timeline')
export class TimelineController {
  constructor(private readonly service: TimelineService) {}

  // GET /timeline/transactions/:ref
  // Full lifecycle for a collection + all linked payouts — one call answers
  // "what happened to order X?"
  @Get('transactions/:ref')
  async transactionTimeline(@Param('ref') ref: string) {
    const data = await this.service.getTransactionTimeline(ref);
    return { success: true, data };
  }

  // GET /timeline/payouts/:customerReference
  // Payout state machine history for a single payout
  @Get('payouts/:customerReference')
  async payoutTimeline(@Param('customerReference') ref: string) {
    const data = await this.service.getPayoutTimeline(ref);
    return { success: true, data };
  }

  // GET /timeline/provider-events?event=payout.successful&limit=50
  // Proxies Fincra's GET /events — provider-side view of what was sent
  @Get('provider-events')
  async providerEvents(
    @Query('event') event?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.service.getProviderEvents(event, limit ? +limit : 50);
    return { success: true, data };
  }

  // GET /timeline/wallet-logs?currency=NGN&type=debit
  // Proxies Fincra's GET /wallets/logs — money-movement ledger
  @Get('wallet-logs')
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
