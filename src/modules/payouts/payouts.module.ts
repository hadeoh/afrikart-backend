import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Payout, PayoutSchema } from './schemas/payout.schema';
import { PayoutsService } from './payouts.service';
import { PayoutsController } from './payouts.controller';
import { AfrikartModule } from '../afrikart/afrikart.module';
import { CollectionsModule } from '../collections/collections.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Payout.name, schema: PayoutSchema }]),
    AfrikartModule,
    CollectionsModule,
  ],
  providers: [PayoutsService],
  controllers: [PayoutsController],
  exports: [PayoutsService, MongooseModule],
})
export class PayoutsModule {}
