import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Transaction, TransactionSchema } from './schemas/transaction.schema';
import { CollectionsService } from './collections.service';
import { CollectionsController } from './collections.controller';
import { AfrikartModule } from '../afrikart/afrikart.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Transaction.name, schema: TransactionSchema }]),
    AfrikartModule,
  ],
  providers: [CollectionsService],
  controllers: [CollectionsController],
  exports: [CollectionsService, MongooseModule],
})
export class CollectionsModule {}
