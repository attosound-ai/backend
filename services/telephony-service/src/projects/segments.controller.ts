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

  /**
   * `from` y `to` van de 0 a 1 sobre la duración del segmento y son opcionales:
   * sin ellos se devuelve el segmento entero, que es lo de siempre. Con ellos
   * se piden los picos de una ventana, que es lo que permite que ampliar la
   * vista en un audio largo siga teniendo detalle.
   */
  @Get(":segmentId/waveform")
  async getWaveform(
    @Param("segmentId") segmentId: string,
    @Query("samples", new DefaultValuePipe(100), ParseIntPipe) samples: number,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const data = await this.projectsService.getWaveformData(
      segmentId,
      samples,
      from === undefined ? 0 : Number(from),
      to === undefined ? 1 : Number(to),
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
