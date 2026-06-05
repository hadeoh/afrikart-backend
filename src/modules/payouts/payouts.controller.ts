import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { PayoutsService } from './payouts.service';
import { CreatePayoutDto } from './dto/create-payout.dto';

@Controller('payouts')
export class PayoutsController {
  constructor(private readonly service: PayoutsService) {}

  @Post()
  async create(@Body() dto: CreatePayoutDto) {
    const payout = await this.service.createPayout(dto);
    return { success: true, data: payout };
  }

  @Get()
  async list(@Query('status') status?: string) {
    const payouts = await this.service.list(status);
    return { success: true, data: payouts };
  }

  @Get(':customerReference')
  async getOne(@Param('customerReference') ref: string) {
    const payout = await this.service.getByCustomerRef(ref);
    return { success: true, data: payout };
  }
}
