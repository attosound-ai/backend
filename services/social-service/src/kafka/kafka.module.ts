import { Global, Module } from "@nestjs/common";
import { KafkaProducer } from "./kafka.producer";
import { KafkaConsumer } from "./kafka.consumer";
import { PushModule } from "../push/push.module";

@Global()
@Module({
  imports: [PushModule],
  providers: [KafkaProducer, KafkaConsumer],
  exports: [KafkaProducer],
})
export class KafkaModule {}
