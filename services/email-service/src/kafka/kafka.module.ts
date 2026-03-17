import { Module } from '@nestjs/common';
import { KafkaConsumer } from './kafka.consumer';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [EmailModule],
  controllers: [KafkaConsumer],
})
export class KafkaConsumerModule {}
