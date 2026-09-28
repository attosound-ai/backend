import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AudioSegment } from "../entities/audio-segment.entity";
import { AudioStorageService } from "../media/audio-storage.service";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ConfigService } from "@nestjs/config";
import ffmpeg = require("fluent-ffmpeg");
import {
  encodePlan,
  envelopeVolumeExpression,
  masterFilterChain,
  type EncodePlan,
  type ExportOptions,
  type MasterEffects,
} from "./project-settings";
import { Readable } from "stream";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { CacheService } from "../cache/cache.service";
import {
  leerCabeceraWav,
  rangoDeBytes,
  lectorDeFotogramas,
  picosDeMuestras,
  tamanoDeContentRange,
  type CabeceraWav,
} from "./wav-window";

@Injectable()
export class AudioProcessorService {
  private readonly logger = new Logger(AudioProcessorService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    @InjectRepository(AudioSegment)
    private readonly segmentRepo: Repository<AudioSegment>,
    private readonly storageService: AudioStorageService,
    private readonly config: ConfigService,
    private readonly cache: CacheService,
  ) {
    this.bucket = this.config.get<string>("s3.bucket", "atto-audio-segments");

    this.s3 = new S3Client({
      endpoint: this.config.get<string>("s3.endpoint", "http://localhost:9000"),
      region: this.config.get<string>("s3.region", "us-east-1"),
      credentials: {
        accessKeyId: this.config.get<string>("s3.accessKey", "atto_minio"),
        secretAccessKey: this.config.get<string>(
          "s3.secretKey",
          "atto_minio_dev",
        ),
      },
      forcePathStyle: true,
    });
  }

  /**
   * Generate waveform amplitude data from an audio segment.
   * Downloads WAV from S3, computes RMS amplitudes per window.
   */
  /**
   * Peak envelope of a segment, optionally of a WINDOW inside it.
   *
   * El rango existe porque un número fijo de picos para el segmento entero se
   * queda sin detalle en cuanto el audio es largo: con 2000 cubos, 35 minutos
   * dan 1,05 segundos por cubo, y al ampliar la vista a doce segundos quedan
   * once puntos para toda la pantalla. Eso es lo que hacía que una onda larga
   * se dibujara como una rampa y una recta (cliente, 27 de septiembre de 2026).
   *
   * `fromRatio` y `toRatio` van de 0 a 1 sobre la duración del segmento, que es
   * como el cliente ya razona los recortes, y así esto no depende de conocer la
   * frecuencia de muestreo ni la duración exacta.
   */
  /** Un stream de S3, entero, en memoria. */
  private async leerStream(body: unknown): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  /**
   * La cabecera del WAV y el tamaño del objeto, con una petición de los
   * primeros kilobytes. Se cachea por segmento porque no cambia nunca y la
   * pide cada ventana.
   */
  private async cabeceraDe(
    segment: AudioSegment,
  ): Promise<{ cab: CabeceraWav; totalBytes: number } | null> {
    const key = `telephony:wavhead:v1:${segment.id}`;
    const cached = await this.cache.get<{ cab: CabeceraWav; totalBytes: number } | "no">(key);
    if (cached) return cached === "no" ? null : cached;

    try {
      const res = await this.s3.send(
        new GetObjectCommand({
          Bucket: segment.storageBucket,
          Key: segment.storageKey,
          Range: "bytes=0-8191",
        }),
      );
      const head = await this.leerStream(res.Body);
      const cab = leerCabeceraWav(head);
      const totalBytes =
        tamanoDeContentRange(res.ContentRange) ??
        (typeof res.ContentLength === "number" && head.length < 8192
          ? res.ContentLength
          : null);
      if (!cab || !totalBytes) {
        await this.cache.set(key, "no", this.cache.jitterTtl(86400));
        return null;
      }
      const info = { cab, totalBytes };
      await this.cache.set(key, info, this.cache.jitterTtl(14 * 86400));
      return info;
    } catch (error) {
      this.logger.debug(
        "No se pudo leer la cabecera del segmento %s: %s",
        segment.id,
        error,
      );
      return null;
    }
  }

  /**
   * Los picos de una ventana leyendo SOLO sus bytes.
   *
   * Devuelve null cuando el archivo no se deja leer por rango (no es un WAV de
   * PCM entero, o el almacenamiento no sirve rangos), y entonces el que llama
   * se baja el objeto entero como toda la vida.
   */
  private async picosPorRango(
    segment: AudioSegment,
    desde: number,
    hasta: number,
    pedidos: number,
  ): Promise<number[] | null> {
    const info = await this.cabeceraDe(segment);
    if (!info) return null;
    const rango = rangoDeBytes(info.cab, info.totalBytes, desde, hasta);
    if (!rango) return null;

    try {
      const res = await this.s3.send(
        new GetObjectCommand({
          Bucket: segment.storageBucket,
          Key: segment.storageKey,
          Range: `bytes=${rango.start}-${rango.end}`,
        }),
      );
      const buf = await this.leerStream(res.Body);
      if (buf.length < 2) return null;
      // Si el almacenamiento ignorase la cabecera Range y devolviera el objeto
      // entero, lo de abajo dibujaría el segmento completo dentro del hueco de
      // la ventana: una onda falsa, y sin error por ninguna parte. Un byte de
      // más ya delata que no se respetó el rango.
      const pedidos = rango.end - rango.start + 1;
      if (buf.length > pedidos) {
        this.logger.warn(
          "El almacenamiento no respetó el rango en el segmento %s (%d bytes pedidos, %d recibidos)",
          segment.id,
          pedidos,
          buf.length,
        );
        return null;
      }
      const lector = lectorDeFotogramas(buf, info.cab);
      const count = Math.max(1, Math.min(pedidos, 24000));
      const picos = picosDeMuestras(lector.leer, lector.frames, count, lector.maximo);
      return picos.length > 0 ? picos : null;
    } catch (error) {
      this.logger.debug(
        "Lectura por rango fallida en el segmento %s: %s",
        segment.id,
        error,
      );
      return null;
    }
  }

  async generateWaveformData(
    segmentId: string,
    numSamples: number,
    fromRatio = 0,
    toRatio = 1,
  ): Promise<number[]> {
    // Ventana saneada: dentro de 0..1, ordenada, y nunca vacía.
    const desde = Math.min(Math.max(Number.isFinite(fromRatio) ? fromRatio : 0, 0), 1);
    const hastaCrudo = Math.min(Math.max(Number.isFinite(toRatio) ? toRatio : 1, 0), 1);
    const hasta = hastaCrudo > desde ? hastaCrudo : 1;
    // La clave incluye la ventana redondeada a seis decimales: dos peticiones
    // del mismo tramo comparten caché, y una de otro tramo no lo pisa.
    const ventana = desde === 0 && hasta === 1 ? "full" : `${desde.toFixed(6)}-${hasta.toFixed(6)}`;
    // v2: la caché dura catorce días, así que sin cambiar la clave el arreglo
    // del pico fantasma no se vería en ningún audio ya dibujado. Recalcular
    // cuesta una lectura por segmento y solo la primera vez.
    const cacheKey = `telephony:waveform:v2:${segmentId}:${numSamples}:${ventana}`;
    const cached = await this.cache.get<number[]>(cacheKey);
    if (cached) return cached;

    const segment = await this.segmentRepo.findOne({
      where: { id: segmentId },
    });
    if (!segment) throw new NotFoundException("Segment not found");

    const tmpFile = join(tmpdir(), `waveform-${randomUUID()}.wav`);

    try {
      // Por rango, y SOLO cuando se pide una ventana: es la diferencia entre
      // bajarse los doscientos megas del segmento o los veinte kilobytes que
      // se van a dibujar. La envolvente completa, que es la que pide todo el
      // mundo al abrir el editor, sigue por el camino de siempre a propósito:
      // esto es un añadido para el zoom profundo y no tiene por qué cambiar ni
      // un pico de lo que ya se dibuja hoy. Si el archivo no se deja leer por
      // rango, la ventana también cae al camino completo.
      if (ventana !== "full") {
        const porRango = await this.picosPorRango(segment, desde, hasta, numSamples);
        if (porRango) {
          await this.cache.set(cacheKey, porRango, this.cache.jitterTtl(14 * 86400));
          return porRango;
        }
      }

      // Download from S3
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: segment.storageBucket,
          Key: segment.storageKey,
        }),
      );

      const chunks: Buffer[] = [];
      const stream = response.Body as Readable;
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      const wavBuffer = Buffer.concat(chunks);

      // Dónde empieza el audio de verdad.
      //
      // Aquí había un 44 fijo, que es lo que mide la cabecera de un WAV sin
      // extras. Pero los archivos los escribe ffmpeg, y ffmpeg mete un bloque
      // LIST con su firma ("Lavf62.3.100"), así que el audio empieza en el 78.
      // Los 34 bytes de diferencia se dibujaban como si fueran sonido, y como
      // son texto ASCII valen medio fondo de escala: TODO clip importado
      // salía con un pico de la nada pegado a su primera muestra.
      const cabecera = leerCabeceraWav(
        wavBuffer.subarray(0, Math.min(8192, wavBuffer.length)),
      );
      const headerSize = cabecera?.dataOffset ?? 44;
      if (wavBuffer.length <= headerSize) {
        return Array(numSamples).fill(0);
      }

      const pcmData = wavBuffer.subarray(
        headerSize,
        cabecera && cabecera.dataBytes > 0
          ? Math.min(wavBuffer.length, headerSize + cabecera.dataBytes)
          : wavBuffer.length,
      );
      // El lector, y no un Int16Array, porque un Int16Array exige que el
      // desplazamiento sea par y eso depende de dónde caiga el buffer.
      const lector = lectorDeFotogramas(
        pcmData,
        cabecera ?? {
          dataOffset: headerSize,
          dataBytes: pcmData.length,
          bitsPerSample: 16,
          channels: 1,
          sampleRate: 8000,
        },
      );

      // Peak envelope, the model every waveform renderer uses (audiowaveform /
      // peaks.js / wavesurfer): the absolute PEAK per bucket, not RMS. RMS
      // flattens transients (a vocal's consonants, drum hits) into a blurry
      // band, which is why the editor's waveform looked featureless next to a
      // DAW's. Peaks keep the shape. The bucket count is allowed up to 4000 so
      // the client can precompute one dense envelope per segment and downsample
      // it locally for any zoom level (instant zoom, no refetch); the old 500
      // ceiling was too coarse to survive zooming in.
      // El techo era 4000, que en un audio de 35 minutos deja medio segundo por
      // cubo: al ampliar la vista la onda se convertía en una recta. 24000 son
      // 87 ms por cubo en ese mismo archivo y unos 120 KB de números, que se
      // piden una vez y se cachean catorce días.
      const count = Math.max(1, Math.min(numSamples, 24000));
      // Solo el tramo pedido. Con la ventana completa esto es exactamente lo
      // que se hacía antes.
      const inicio = Math.floor(desde * lector.frames);
      const fin = Math.max(inicio + 1, Math.floor(hasta * lector.frames));
      const total = fin - inicio;
      // Nunca más cubos que muestras: pedir 2000 picos de 500 muestras daba
      // cubos de cero muestras y devolvía una onda plana, que es justo lo que
      // pasaba al ampliar mucho una ventana corta.
      const amplitudes = picosDeMuestras(
        (i) => lector.leer(inicio + i),
        total,
        count,
        lector.maximo,
      );

      // Cache for ~14 days with jitter
      await this.cache.set(cacheKey, amplitudes, this.cache.jitterTtl(14 * 86400));

      return amplitudes;
    } catch (error) {
      this.logger.warn(
        "Failed to generate waveform for segment %s: %s",
        segmentId,
        error,
      );
      // Return mock data as fallback
      return Array.from(
        { length: Math.min(numSamples, 500) },
        () => Math.round(Math.random() * 100) / 100,
      );
    } finally {
      // Cleanup temp file if it exists
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  /**
   * Cut a segment of audio using ffmpeg.
   * Returns the cut audio as a Buffer.
   */
  async cutSegment(
    bucket: string,
    key: string,
    startMs: number,
    endMs: number,
  ): Promise<Buffer> {
    const tmpInput = join(tmpdir(), `cut-in-${randomUUID()}.wav`);
    const tmpOutput = join(tmpdir(), `cut-out-${randomUUID()}.wav`);

    try {
      // Download source file
      const response = await this.s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const chunks: Buffer[] = [];
      for await (const chunk of response.Body as Readable) {
        chunks.push(Buffer.from(chunk));
      }
      await fs.writeFile(tmpInput, Buffer.concat(chunks));

      // Cut with ffmpeg
      await new Promise<void>((resolve, reject) => {
        ffmpeg(tmpInput)
          .setStartTime(startMs / 1000)
          .setDuration((endMs - startMs) / 1000)
          .output(tmpOutput)
          .on("end", () => resolve())
          .on("error", (err: Error) => reject(err))
          .run();
      });

      return await fs.readFile(tmpOutput);
    } finally {
      await fs.unlink(tmpInput).catch(() => {});
      await fs.unlink(tmpOutput).catch(() => {});
    }
  }

  /**
   * Concat a list of WAV files sequentially.
   */
  private async concatFiles(
    files: string[],
    outputPath: string,
  ): Promise<void> {
    if (files.length === 1) {
      await fs.copyFile(files[0], outputPath);
      return;
    }

    const listFile = join(tmpdir(), `concat-${randomUUID()}.txt`);
    const listContent = files.map((f) => `file '${f}'`).join("\n");
    await fs.writeFile(listFile, listContent);

    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(listFile)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .output(outputPath)
        .outputOptions(["-c", "copy"])
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });

    await fs.unlink(listFile).catch(() => {});
  }

  /**
   * Mix multiple audio files together using amix filter.
   */
  private async mixFiles(files: string[], outputPath: string): Promise<void> {
    if (files.length === 1) {
      await fs.copyFile(files[0], outputPath);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg();
      for (const f of files) {
        cmd.input(f);
      }
      cmd
        .complexFilter(
          `amix=inputs=${files.length}:duration=longest:normalize=0`,
        )
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
  }

  /**
   * Loudness-normalize a WAV to a comfortable listening level (~-16 LUFS).
   * The Securus line delivers very quiet audio (measured ~-34 LUFS on real
   * recordings), so without this the user has to crank playback, which surfaces
   * the line's noise floor ("so quiet that when we turn them up it sounds like
   * shit"). loudnorm applies gentle leveling to a broadcast-ish target. Callers
   * fall back to the un-normalized mix if this throws, so an export never fails
   * over a normalization hiccup.
   */
  private async normalizeLoudness(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .audioFilters("loudnorm=I=-16:TP=-1.5:LRA=11")
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
  }

  /**
   * Convert any supported audio file to WAV format.
   */
  async convertToWav(inputPath: string): Promise<string> {
    const outputPath = join(tmpdir(), `convert-${randomUUID()}.wav`);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .output(outputPath)
        .outputOptions(["-ar", "8000", "-ac", "1", "-f", "wav"])
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
    return outputPath;
  }

  /**
   * Inspect an audio file's real format.
   *
   * Needed because import used to decide "is this already WAV?" from the CLIENT'S
   * mime string. A 44.1 kHz stereo file announced as `audio/wav` was therefore
   * stored untouched while the DB recorded `sampleRate: 8000`. Downstream,
   * `concatFiles` uses `-c copy`, which requires every clip on a lane to share an
   * identical format, so mixing that import with 8 kHz mono call recordings
   * produced a garbled or failed export. Probing the bytes removes the guess.
   */
  async probeAudio(filePath: string): Promise<{
    sampleRate: number;
    channels: number;
    codecName: string;
    durationMs: number;
  }> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err: Error | null, metadata: any) => {
        if (err) return reject(err);
        const stream = (metadata?.streams ?? []).find(
          (s: any) => s?.codec_type === "audio",
        );
        resolve({
          sampleRate: Number(stream?.sample_rate ?? 0),
          channels: Number(stream?.channels ?? 0),
          codecName: String(stream?.codec_name ?? ""),
          durationMs: Math.round(Number(metadata?.format?.duration ?? 0) * 1000),
        });
      });
    });
  }

  /**
   * Get audio duration in milliseconds using ffprobe.
   */
  async getDurationMs(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err: Error | null, metadata: any) => {
        if (err) return reject(err);
        const durationSec = metadata?.format?.duration ?? 0;
        resolve(Math.round(durationSec * 1000));
      });
    });
  }

  /**
   * Place every clip of one lane at its ABSOLUTE timeline position and sum
   * them into a single lane file. Gaps between clips are silence.
   *
   * This replaced a sequential `concat` by `order`, which ignored
   * `positionInTimeline` entirely: a take recorded at the playhead (10s in) was
   * exported glued to 0s, a clip dragged later on the timeline exported where
   * it used to be, and any gap the editor showed collapsed in the file. It also
   * makes the editor's region operations (silence / cut / insert time, which
   * are all "leave a gap") render faithfully, with no schema change.
   *
   * ffmpeg graph per clip: atrim is already applied by cutSegment, so each
   * input gets `volume` (clip gain), `afade` in+out of a few ms (kills the click
   * a hard cut leaves at a boundary, since the client only snaps to peaks, not
   * zero crossings) and `adelay` to its position; `amix` then sums with
   * `normalize=0` so levels are preserved and `duration=longest` so trailing
   * silence after the last clip is kept.
   */
  private async placeClipsOnLane(
    placed: {
      file: string;
      positionMs: number;
      volume: number;
      volumeExpr?: string | null;
    }[],
    outputPath: string,
  ): Promise<void> {
    const EDGE_FADE_SEC = 0.004;
    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg();
      const chains: string[] = [];
      placed.forEach((p, i) => {
        cmd.input(p.file);
        const vol = Number.isFinite(p.volume) ? Math.max(0, p.volume) : 1;
        const delayMs = Math.max(0, Math.round(p.positionMs));
        // The clip's automation envelope runs before the static clip gain,
        // in the clip's own time base (adelay has not moved it yet).
        const envelope = p.volumeExpr
          ? `volume=volume='${p.volumeExpr}':eval=frame,`
          : "";
        chains.push(
          `[${i}:a]${envelope}volume=${vol.toFixed(4)},` +
            `afade=t=in:st=0:d=${EDGE_FADE_SEC},` +
            `areverse,afade=t=in:st=0:d=${EDGE_FADE_SEC},areverse,` +
            `adelay=${delayMs}:all=1[c${i}]`,
        );
      });
      const mixInputs = placed.map((_, i) => `[c${i}]`).join("");
      const filter =
        placed.length === 1
          ? `${chains[0].replace(`[c0]`, "[out]")}`
          : `${chains.join(";")};${mixInputs}amix=inputs=${placed.length}:duration=longest:normalize=0[out]`;
      cmd
        .complexFilter(filter, "out")
        .output(outputPath)
        .outputOptions(["-f", "wav"])
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
  }

  /** Run a plain audio filter chain over a WAV, writing a new WAV. */
  private async applyFilters(
    inputPath: string,
    outputPath: string,
    filters: string[],
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .audioFilters(filters)
        .output(outputPath)
        .outputOptions(["-f", "wav"])
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
  }

  /**
   * Encode the mixed WAV for delivery: format and quality from the exporter,
   * optional resample and channel count, title, author and ISRC tags, and
   * the cover picture for containers that carry one. WAV with no options
   * is returned as is (the feed path).
   */
  private async encodeExport(
    inputPath: string,
    plan: EncodePlan,
    options: ExportOptions | undefined,
  ): Promise<{ tmpPath: string }> {
    const wantsResample =
      typeof options?.sampleRate === "number" || typeof options?.channels === "number";
    const hasTags = !!(options?.title || options?.author || options?.isrc);
    if (plan.extension === "wav" && !wantsResample && !hasTags) {
      return { tmpPath: inputPath };
    }
    const outputPath = join(tmpdir(), `export-${randomUUID()}.${plan.extension}`);
    let coverPath: string | null = null;
    if (options?.coverKey && plan.supportsCover) {
      try {
        const response = await this.s3.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: options.coverKey }),
        );
        const chunks: Buffer[] = [];
        for await (const chunk of response.Body as Readable) {
          chunks.push(Buffer.from(chunk));
        }
        const cover = Buffer.concat(chunks);
        const ext = options.coverKey.toLowerCase().endsWith(".png") ? "png" : "jpg";
        coverPath = join(tmpdir(), `cover-${randomUUID()}.${ext}`);
        await fs.writeFile(coverPath, cover);
      } catch (err) {
        this.logger.warn("Cover download failed, exporting without it: %s", err);
        coverPath = null;
      }
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const cmd = ffmpeg(inputPath);
        const args: string[] = [...plan.codecArgs];
        if (typeof options?.sampleRate === "number") {
          args.push("-ar", String(options.sampleRate));
        }
        if (typeof options?.channels === "number") {
          args.push("-ac", String(options.channels));
        }
        if (options?.title) args.push("-metadata", `title=${options.title}`);
        if (options?.author) args.push("-metadata", `artist=${options.author}`);
        if (options?.isrc) args.push("-metadata", `ISRC=${options.isrc}`);
        if (coverPath) {
          cmd.input(coverPath);
          args.push(
            "-map",
            "0:a",
            "-map",
            "1:v",
            "-c:v",
            "mjpeg",
            "-disposition:v",
            "attached_pic",
          );
          if (plan.extension === "mp3") {
            args.push("-id3v2_version", "3");
          }
        }
        cmd
          .outputOptions(args)
          .output(outputPath)
          .on("end", () => resolve())
          .on("error", (err: Error) => reject(err))
          .run();
      });
    } finally {
      if (coverPath) await fs.unlink(coverPath).catch(() => {});
    }
    return { tmpPath: outputPath };
  }

  /**
   * Export a project by cutting each clip, placing it at its timeline
   * position on its lane, then mixing lanes together into a single WAV.
   */
  async exportProject(
    clips: {
      segmentId: string;
      startInSegment: number;
      endInSegment: number;
      order: number;
      laneIndex?: number;
      positionInTimeline?: number;
      volume?: number;
      id?: string;
    }[],
    projectId: string,
    master?: MasterEffects,
    options?: ExportOptions,
    automation?: Record<string, Array<[number, number]>>,
  ): Promise<{ downloadUrl: string; fileSizeBytes: number }> {
    if (clips.length === 0) {
      throw new NotFoundException("No clips to export");
    }

    // Group clips by lane
    const byLane = new Map<number, typeof clips>();
    for (const clip of clips) {
      const lane = clip.laneIndex ?? 0;
      if (!byLane.has(lane)) byLane.set(lane, []);
      byLane.get(lane)!.push(clip);
    }

    const allTmpFiles: string[] = [];
    const laneFiles: string[] = [];
    const tmpOutput = join(tmpdir(), `export-${randomUUID()}.wav`);

    try {
      // Process each lane: cut every clip, then place each at its absolute
      // timeline position (gaps = silence). Legacy rows that predate
      // positionInTimeline (null/undefined) fall back to sequential placement
      // by `order`, which reproduces the old concat behaviour for them only.
      for (const [, laneClips] of byLane) {
        const sortedClips = [...laneClips].sort((a, b) => a.order - b.order);
        const placed: {
          file: string;
          positionMs: number;
          volume: number;
          volumeExpr?: string | null;
        }[] = [];
        let sequentialCursorMs = 0;

        for (const clip of sortedClips) {
          const segment = await this.segmentRepo.findOne({
            where: { id: clip.segmentId },
          });
          if (!segment) continue;

          const cutBuffer = await this.cutSegment(
            segment.storageBucket,
            segment.storageKey,
            clip.startInSegment,
            clip.endInSegment,
          );

          const tmpCut = join(tmpdir(), `clip-${randomUUID()}.wav`);
          await fs.writeFile(tmpCut, cutBuffer);
          allTmpFiles.push(tmpCut);

          const hasPosition =
            typeof clip.positionInTimeline === "number" &&
            Number.isFinite(clip.positionInTimeline);
          const positionMs = hasPosition
            ? clip.positionInTimeline!
            : sequentialCursorMs;
          sequentialCursorMs =
            positionMs + (clip.endInSegment - clip.startInSegment);

          const envelope = clip.id ? automation?.[clip.id] : undefined;
          placed.push({
            file: tmpCut,
            positionMs,
            volume: typeof clip.volume === "number" ? clip.volume : 1,
            volumeExpr: Array.isArray(envelope)
              ? envelopeVolumeExpression(envelope)
              : null,
          });
        }

        if (placed.length === 0) continue;

        const laneOutput = join(tmpdir(), `lane-${randomUUID()}.wav`);
        await this.placeClipsOnLane(placed, laneOutput);
        laneFiles.push(laneOutput);
        allTmpFiles.push(laneOutput);
      }

      if (laneFiles.length === 0) {
        throw new NotFoundException("No valid clips to export");
      }

      // Mix lanes together (or just use single lane output)
      await this.mixFiles(laneFiles, tmpOutput);

      // Loudness-normalize the final mix so recordings play at a comfortable
      // level instead of the very quiet raw Securus-line level. Falls back to the
      // un-normalized mix if normalization throws, so an export never breaks.
      let finalOutput = tmpOutput;
      try {
        const normalizedOutput = join(tmpdir(), `export-norm-${randomUUID()}.wav`);
        allTmpFiles.push(normalizedOutput);
        await this.normalizeLoudness(tmpOutput, normalizedOutput);
        finalOutput = normalizedOutput;
      } catch (err) {
        this.logger.warn(
          "Loudness normalization failed, using un-normalized mix: %s",
          err,
        );
      }

      // Master effects (the editor's Master Effects sheet) run on the mix
      // bus, before loudness normalisation so the level target still holds.
      // The pipeline is 8 kHz mono; probe rather than assume so an EQ band
      // above Nyquist is skipped instead of failing the export.
      const masterFilters = masterFilterChain(
        master,
        (await this.probeAudio(finalOutput).catch(() => null))?.sampleRate ??
          8000,
      );
      if (masterFilters.length > 0) {
        const masteredOutput = join(
          tmpdir(),
          `export-master-${randomUUID()}.wav`,
        );
        allTmpFiles.push(masteredOutput);
        await this.applyFilters(finalOutput, masteredOutput, masterFilters);
        finalOutput = masteredOutput;
      }

      // Encode to the exporter's format with its metadata and cover.
      const plan = encodePlan(options);
      const encoded = await this.encodeExport(finalOutput, plan, options);
      if (encoded.tmpPath !== finalOutput) allTmpFiles.push(encoded.tmpPath);

      // Upload to S3
      const outputBuffer = await fs.readFile(encoded.tmpPath);
      const date = new Date().toISOString().slice(0, 10);
      const storageKey = `exports/${date}/${projectId}/${randomUUID()}.${plan.extension}`;

      await this.storageService.upload(storageKey, outputBuffer, plan.mimeType);

      const downloadUrl = await this.storageService.getPresignedUrl(
        this.bucket,
        storageKey,
        7200, // 2 hours
      );

      this.logger.log(
        "Project exported: project=%s lanes=%d size=%d",
        projectId,
        laneFiles.length,
        outputBuffer.length,
      );

      return { downloadUrl, fileSizeBytes: outputBuffer.length };
    } finally {
      for (const f of allTmpFiles) {
        await fs.unlink(f).catch(() => {});
      }
      await fs.unlink(tmpOutput).catch(() => {});
    }
  }
}
