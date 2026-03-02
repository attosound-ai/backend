import {
  Controller,
  Get,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
} from "@nestjs/common";
import { ProjectsService } from "./projects.service";

@Controller("telephony/segments")
export class SegmentsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get(":segmentId/waveform")
  async getWaveform(
    @Param("segmentId") segmentId: string,
    @Query("samples", new DefaultValuePipe(100), ParseIntPipe) samples: number,
  ) {
    const data = await this.projectsService.getWaveformData(
      segmentId,
      samples,
    );
    return { success: true, data };
  }
}
