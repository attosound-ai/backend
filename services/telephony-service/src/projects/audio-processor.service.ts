import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AudioSegment } from "../entities/audio-segment.entity";
import { AudioStorageService } from "../media/audio-storage.service";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ConfigService } from "@nestjs/config";
import ffmpeg = require("fluent-ffmpeg");
import { Readable } from "stream";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { CacheService } from "../cache/cache.service";

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
  async generateWaveformData(
    segmentId: string,
    numSamples: number,
  ): Promise<number[]> {
    // Check Redis cache first (waveforms are immutable)
    const cacheKey = `telephony:waveform:${segmentId}:${numSamples}`;
    const cached = await this.cache.get<number[]>(cacheKey);
    if (cached) return cached;

    const segment = await this.segmentRepo.findOne({
      where: { id: segmentId },
    });
    if (!segment) throw new NotFoundException("Segment not found");

    const tmpFile = join(tmpdir(), `waveform-${randomUUID()}.wav`);

    try {
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

      // Parse WAV header to get PCM data
      // Standard WAV: 44-byte header, 16-bit PCM mono at 8000Hz
      const headerSize = 44;
      if (wavBuffer.length <= headerSize) {
        return Array(numSamples).fill(0);
      }

      const pcmData = wavBuffer.subarray(headerSize);
      const samples = new Int16Array(
        pcmData.buffer,
        pcmData.byteOffset,
        pcmData.byteLength / 2,
      );

      // Peak envelope, the model every waveform renderer uses (audiowaveform /
      // peaks.js / wavesurfer): the absolute PEAK per bucket, not RMS. RMS
      // flattens transients (a vocal's consonants, drum hits) into a blurry
      // band, which is why the editor's waveform looked featureless next to a
      // DAW's. Peaks keep the shape. The bucket count is allowed up to 4000 so
      // the client can precompute one dense envelope per segment and downsample
      // it locally for any zoom level (instant zoom, no refetch); the old 500
      // ceiling was too coarse to survive zooming in.
      const count = Math.max(1, Math.min(numSamples, 4000));
      const windowSize = Math.floor(samples.length / count);
      if (windowSize === 0) return Array(count).fill(0);

      const amplitudes: number[] = [];
      for (let i = 0; i < count; i++) {
        const start = i * windowSize;
        const end = Math.min(start + windowSize, samples.length);
        let peak = 0;
        for (let j = start; j < end; j++) {
          const v = samples[j] < 0 ? -samples[j] : samples[j];
          if (v > peak) peak = v;
        }
        // Normalize to 0-1 range (Int16 max = 32768)
        amplitudes.push(Math.round((peak / 32768) * 1000) / 1000);
      }

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
    placed: { file: string; positionMs: number; volume: number }[],
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
        chains.push(
          `[${i}:a]volume=${vol.toFixed(4)},` +
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
    }[],
    projectId: string,
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
        const placed: { file: string; positionMs: number; volume: number }[] =
          [];
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

          placed.push({
            file: tmpCut,
            positionMs,
            volume: typeof clip.volume === "number" ? clip.volume : 1,
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

      // Upload to S3
      const outputBuffer = await fs.readFile(finalOutput);
      const date = new Date().toISOString().slice(0, 10);
      const storageKey = `exports/${date}/${projectId}/${randomUUID()}.wav`;

      await this.storageService.upload(storageKey, outputBuffer);

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
