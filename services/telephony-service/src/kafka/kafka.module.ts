import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { KafkaProducer } from "./kafka.producer";
import { KafkaConsumer } from "./kafka.consumer";
import { CallsModule } from "../calls/calls.module";
import { NumbersModule } from "../numbers/numbers.module";
import { MediaModule } from "../media/media.module";
import { Call } from "../entities/call.entity";
import { PhoneNumberAssignment } from "../entities/phone-number-assignment.entity";
import { Project } from "../entities/project.entity";
import { TimelineClip } from "../entities/timeline-clip.entity";
import { AudioSegment } from "../entities/audio-segment.entity";

@Module({
  imports: [
    forwardRef(() => CallsModule),
    forwardRef(() => NumbersModule),
    forwardRef(() => MediaModule),
    // Repos used by the user.deleted cleanup path.
    TypeOrmModule.forFeature([
      Call,
      PhoneNumberAssignment,
      Project,
      TimelineClip,
      AudioSegment,
    ]),
  ],
  providers: [KafkaProducer, KafkaConsumer],
  exports: [KafkaProducer],
})
export class KafkaModule {}
