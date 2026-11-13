import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Headers,
  ParseIntPipe,
  DefaultValuePipe,
} from "@nestjs/common";
import { ProjectsService } from "./projects.service";
import { resolveVerifiedUserId } from "../common/verified-user-id";

@Controller("telephony/segments")
export class SegmentsController {
  constructor(private readonly projectsService: ProjectsService) {}

  /**
   * `from` y `to` van de 0 a 1 sobre la duración del segmento y son opcionales:
   * sin ellos se devuelve el segmento entero, que es lo de siempre. Con ellos
   * se piden los picos de una ventana, que es lo que permite que ampliar la
   * vista en un audio largo siga teniendo detalle.
   *
   * Pide sesión y que el segmento sea de quien pregunta (o de su grupo de
   * cuentas enlazadas); uno ajeno responde 404 igual que uno que no existe.
   */
  @Get(":segmentId/waveform")
  async getWaveform(
    @Param("segmentId") segmentId: string,
    @Query("samples", new DefaultValuePipe(100), ParseIntPipe) samples: number,
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = resolveVerifiedUserId(userId, authHeader);
    const data = await this.projectsService.getWaveformData(
      segmentId,
      uid,
      samples,
      from === undefined ? 0 : Number(from),
      to === undefined ? 1 : Number(to),
    );
    return { success: true, data };
  }

  @Post("waveforms/batch")
  async getWaveformsBatch(
    @Body() body: { segmentIds: string[]; samples?: number },
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = resolveVerifiedUserId(userId, authHeader);
    const samples = body.samples ?? 100;
    const results: Record<string, number[]> = {};

    await Promise.all(
      (Array.isArray(body?.segmentIds) ? body.segmentIds : []).map(async (id) => {
        results[id] = await this.projectsService.getWaveformData(
          id,
          uid,
          samples,
        );
      }),
    );

    return { success: true, data: results };
  }
}
