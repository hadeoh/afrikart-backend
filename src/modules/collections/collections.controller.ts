import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CollectionsService } from './collections.service';
import { InitiateCheckoutDto } from './dto/initiate-checkout.dto';

@Controller('collections')
export class CollectionsController {
  constructor(private readonly service: CollectionsService) {}

  @Post('checkout')
  async initiate(@Body() dto: InitiateCheckoutDto) {
    const result = await this.service.initiateCheckout(dto);
    return { success: true, data: result };
  }

  @Get(':ref')
  async getTransaction(@Param('ref') ref: string) {
    const txn = await this.service.getByRef(ref);
    return { success: true, data: txn };
  }
}
