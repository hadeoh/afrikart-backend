import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Afrikart Payment API')
    .setDescription(
      'Payment collection (checkout & virtual account), payouts with account verification, ' +
      'HMAC-signed webhook processing, and transaction timeline.',
    )
    .setVersion('1.0')
    .addTag('Collections', 'Initiate checkouts and virtual-account collections')
    .addTag('Payouts', 'Create and track outbound payouts')
    .addTag('Webhooks', 'Receive and process provider webhook events')
    .addTag('Timeline', 'Transaction and payout lifecycle views')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  Logger.log(`Afrikart backend listening on port ${port}`, 'Bootstrap');
  Logger.log(`Swagger UI → http://localhost:${port}/api-docs`, 'Bootstrap');
}

bootstrap();
