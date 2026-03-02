import { Global, Module } from '@nestjs/common';
import { KafkaProducer } from './kafka.producer';
import { KafkaConsumer } from './kafka.consumer';

@Global()
@Module({
  providers: [KafkaProducer, KafkaConsumer],
  exports: [KafkaProducer],
})
export class KafkaModule {}
