import { Module } from '@nestjs/common';
import { TimelineService } from './timeline.service';
import { TimelineController } from './timeline.controller';
import { CollectionsModule } from '../collections/collections.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { AfrikartModule } from '../afrikart/afrikart.module';

@Module({
  imports: [CollectionsModule, PayoutsModule, AfrikartModule],
  providers: [TimelineService],
  controllers: [TimelineController],
})
export class TimelineModule {}
