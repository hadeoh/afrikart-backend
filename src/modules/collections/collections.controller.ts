import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { CollectionsService } from './collections.service';
import { InitiateCheckoutDto } from './dto/initiate-checkout.dto';

@ApiTags('Collections')
@Controller('collections')
export class CollectionsController {
  constructor(private readonly service: CollectionsService) {}

  @Post('checkout')
  @ApiOperation({
    summary: 'Initiate a checkout payment',
    description: 'Creates a hosted checkout session. Repeated calls with the same reference return the existing record with idempotent:true.',
  })
  @ApiResponse({ status: 201, description: 'Checkout initiated or idempotently returned' })
  @ApiResponse({ status: 409, description: 'orderId already has an active collection via a different method' })
  async initiate(@Body() dto: InitiateCheckoutDto) {
    const result = await this.service.initiateCheckout(dto);
    return { success: true, data: result };
  }

  @Get(':ref')
  @ApiOperation({ summary: 'Get a transaction by internal reference' })
  @ApiParam({ name: 'ref', description: 'The internalRef returned when the collection was created' })
  @ApiResponse({ status: 200, description: 'Transaction document' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  async getTransaction(@Param('ref') ref: string) {
    const txn = await this.service.getByRef(ref);
    return { success: true, data: txn };
  }

  @Post(':ref/sync')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sync collection status from provider',
    description: 'Polls the provider for the current payment status and applies it locally. No-op if the transaction is already settled. Use when a webhook was expected but never arrived.',
  })
  @ApiParam({ name: 'ref', description: 'The internalRef of the collection to sync' })
  @ApiResponse({ status: 200, description: 'synced:true if status was updated, synced:false if already settled or provider still pending' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  async syncStatus(@Param('ref') ref: string) {
    const result = await this.service.syncCollectionStatus(ref);
    return { success: true, ...result };
  }
}
