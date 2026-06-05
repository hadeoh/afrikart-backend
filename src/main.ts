import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: true keeps a Buffer copy of the raw request body alongside the
  // parsed JSON. The webhook controller reads req.rawBody to verify the
  // HMAC-SHA512 signature over the exact bytes the sandbox sent, not a
  // re-serialized version (which would differ if key order changed).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );

  const port = process.env.PORT || 3000;
  await app.listen(port);
  Logger.log(`Afrikart backend listening on port ${port}`, 'Bootstrap');
}

bootstrap();
