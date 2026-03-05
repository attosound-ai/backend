import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
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

  @Post("waveforms/batch")
  async getWaveformsBatch(
    @Body() body: { segmentIds: string[]; samples?: number },
  ) {
    const samples = body.samples ?? 100;
    const results: Record<string, number[]> = {};

    await Promise.all(
      body.segmentIds.map(async (id) => {
        results[id] = await this.projectsService.getWaveformData(id, samples);
      }),
    );

    return { success: true, data: results };
  }
}
