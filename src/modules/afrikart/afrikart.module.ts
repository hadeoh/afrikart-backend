import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AfrikartService } from './afrikart.service';

@Module({
  imports: [ConfigModule],
  providers: [AfrikartService],
  exports: [AfrikartService],
})
export class AfrikartModule {}
