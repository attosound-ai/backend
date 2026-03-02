import { Module, forwardRef } from "@nestjs/common";
import { MediaGateway } from "./media.gateway";
import { MediaService } from "./media.service";
import { AudioStorageService } from "./audio-storage.service";
import { CallsModule } from "../calls/calls.module";
import { KafkaModule } from "../kafka/kafka.module";

@Module({
  imports: [forwardRef(() => CallsModule), forwardRef(() => KafkaModule)],
  providers: [MediaGateway, MediaService, AudioStorageService],
  exports: [MediaService, AudioStorageService],
})
export class MediaModule {}
