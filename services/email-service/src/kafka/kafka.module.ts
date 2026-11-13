import { Module } from '@nestjs/common';
import { AccountDeletionConsumer, KafkaConsumer } from './kafka.consumer';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [EmailModule],
  controllers: [KafkaConsumer, AccountDeletionConsumer],
})
export class KafkaConsumerModule {}
