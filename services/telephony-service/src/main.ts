import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
    rawBody: true, // Needed for Twilio webhook signature validation
  });

  // Use raw WebSocket adapter (not Socket.IO) for Twilio Media Streams
  app.useWebSocketAdapter(new WsAdapter(app));

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // CORS
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-User-ID',
      'X-User-Role',
      'X-Twilio-Signature',
    ],
  });

  app.enableShutdownHooks();

  const port = process.env.PORT || 3009;
  await app.listen(port, '::');

  logger.log(`Telephony Service listening on port ${port}`);
  logger.log(`Webhooks: http://localhost:${port}/telephony/webhooks/voice/incoming`);
  logger.log(`Tokens:   http://localhost:${port}/telephony/tokens/voice`);
  logger.log(`Media WS: ws://localhost:${port}/telephony/media-stream`);
}

bootstrap().catch((err) => {
  console.error('Failed to start telephony-service:', err);
  process.exit(1);
});
