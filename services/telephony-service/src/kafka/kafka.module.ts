import { Module, forwardRef } from "@nestjs/common";
import { KafkaProducer } from "./kafka.producer";
import { KafkaConsumer } from "./kafka.consumer";
import { CallsModule } from "../calls/calls.module";
import { NumbersModule } from "../numbers/numbers.module";

@Module({
  imports: [forwardRef(() => CallsModule), forwardRef(() => NumbersModule)],
  providers: [KafkaProducer, KafkaConsumer],
  exports: [KafkaProducer],
})
export class KafkaModule {}
