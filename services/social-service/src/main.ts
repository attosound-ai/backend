import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  // Global validation pipe for DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Enable CORS
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-User-ID',
      'X-User-Role',
    ],
  });

  // Enable graceful shutdown
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port, '::');

  logger.log(`Social Service HTTP server listening on port ${port}`);
  logger.log(`Health check: http://localhost:${port}/health`);
  logger.log(`gRPC server will start on port ${process.env.GRPC_PORT || 50053}`);
}

bootstrap().catch((err) => {
  console.error('Failed to start social-service:', err);
  process.exit(1);
});
