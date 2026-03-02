import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ProjectsController } from "./projects.controller";
import { SegmentsController } from "./segments.controller";
import { ProjectsService } from "./projects.service";
import { AudioProcessorService } from "./audio-processor.service";
import { Project } from "../entities/project.entity";
import { TimelineClip } from "../entities/timeline-clip.entity";
import { AudioSegment } from "../entities/audio-segment.entity";
import { MediaModule } from "../media/media.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([Project, TimelineClip, AudioSegment]),
    MediaModule,
  ],
  controllers: [ProjectsController, SegmentsController],
  providers: [ProjectsService, AudioProcessorService],
  exports: [ProjectsService, AudioProcessorService],
})
export class ProjectsModule {}
