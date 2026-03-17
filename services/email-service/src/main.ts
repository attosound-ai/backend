import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const configService = app.get(ConfigService);
  const kafkaBrokers = configService.get<string>('KAFKA_BROKERS', 'kafka:29092');

  // Kafka microservice for consuming user.created events
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: 'email-service',
        brokers: kafkaBrokers.split(','),
      },
      consumer: {
        groupId: 'email-service-consumer',
      },
    },
  });

  await app.startAllMicroservices();

  const port = configService.get<number>('PORT', 3005);
  await app.listen(port);

  console.log(`[EMAIL-SERVICE] HTTP server listening on port ${port}`);
  console.log(`[EMAIL-SERVICE] Kafka consumer connected to ${kafkaBrokers}`);
}
bootstrap();
