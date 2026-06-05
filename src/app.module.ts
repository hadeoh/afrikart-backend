import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import configuration from './common/config/configuration';
import { AfrikartModule } from './modules/afrikart/afrikart.module';
import { CollectionsModule } from './modules/collections/collections.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { PayoutsModule } from './modules/payouts/payouts.module';
import { TimelineModule } from './modules/timeline/timeline.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: '.env',
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('mongoUri'),
      }),
    }),
    AfrikartModule,
    CollectionsModule,
    WebhooksModule,
    PayoutsModule,
    TimelineModule,
  ],
})
export class AppModule {}
