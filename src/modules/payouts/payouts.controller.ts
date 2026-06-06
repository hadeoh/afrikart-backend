import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { PayoutsService } from './payouts.service';
import { CreatePayoutDto } from './dto/create-payout.dto';

@ApiTags('Payouts')
@Controller('payouts')
export class PayoutsController {
  constructor(private readonly service: PayoutsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a payout',
    description: 'Verifies the destination account, then submits to the provider. Idempotent — repeated calls with the same customerReference return the existing payout.',
  })
  @ApiResponse({ status: 201, description: 'Payout created (or idempotently returned)' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async create(@Body() dto: CreatePayoutDto) {
    const payout = await this.service.createPayout(dto);
    return { success: true, data: payout };
  }

  @Get()
  @ApiOperation({ summary: 'List payouts', description: 'Returns all payouts, optionally filtered by status.' })
  @ApiQuery({ name: 'status', required: false, enum: ['verification_pending', 'verification_failed', 'processing', 'successful', 'failed', 'uncertain'] })
  @ApiResponse({ status: 200, description: 'List of payouts' })
  async list(@Query('status') status?: string) {
    const payouts = await this.service.list(status);
    return { success: true, data: payouts };
  }

  @Get(':customerReference')
  @ApiOperation({ summary: 'Get a payout by customer reference' })
  @ApiParam({ name: 'customerReference', description: 'The caller-supplied idempotency key used when creating the payout' })
  @ApiResponse({ status: 200, description: 'Payout document' })
  @ApiResponse({ status: 404, description: 'Payout not found' })
  async getOne(@Param('customerReference') ref: string) {
    const payout = await this.service.getByCustomerRef(ref);
    return { success: true, data: payout };
  }
}
