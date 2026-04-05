import { Module, forwardRef } from "@nestjs/common";
import { KafkaProducer } from "./kafka.producer";
import { KafkaConsumer } from "./kafka.consumer";
import { CallsModule } from "../calls/calls.module";
import { NumbersModule } from "../numbers/numbers.module";
import { MediaModule } from "../media/media.module";

@Module({
  imports: [forwardRef(() => CallsModule), forwardRef(() => NumbersModule), forwardRef(() => MediaModule)],
  providers: [KafkaProducer, KafkaConsumer],
  exports: [KafkaProducer],
})
export class KafkaModule {}
