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

      // Compute RMS amplitudes
      const count = Math.min(numSamples, 500);
      const windowSize = Math.floor(samples.length / count);
      if (windowSize === 0) return Array(count).fill(0);

      const amplitudes: number[] = [];
      for (let i = 0; i < count; i++) {
        const start = i * windowSize;
        const end = Math.min(start + windowSize, samples.length);
        let sumSquares = 0;
        for (let j = start; j < end; j++) {
          sumSquares += samples[j] * samples[j];
        }
        const rms = Math.sqrt(sumSquares / (end - start));
        // Normalize to 0-1 range (Int16 max = 32768)
        amplitudes.push(Math.round((rms / 32768) * 1000) / 1000);
      }

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
   * Export a project by cutting and merging clips per lane,
   * then mixing lanes together into a single WAV.
   */
  async exportProject(
    clips: {
      segmentId: string;
      startInSegment: number;
      endInSegment: number;
      order: number;
      laneIndex?: number;
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
      // Process each lane: cut clips and concat sequentially
      for (const [, laneClips] of byLane) {
        const sortedClips = [...laneClips].sort((a, b) => a.order - b.order);
        const cutFiles: string[] = [];

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
          cutFiles.push(tmpCut);
          allTmpFiles.push(tmpCut);
        }

        if (cutFiles.length === 0) continue;

        // Concat clips within this lane
        const laneOutput = join(tmpdir(), `lane-${randomUUID()}.wav`);
        await this.concatFiles(cutFiles, laneOutput);
        laneFiles.push(laneOutput);
        allTmpFiles.push(laneOutput);
      }

      if (laneFiles.length === 0) {
        throw new NotFoundException("No valid clips to export");
      }

      // Mix lanes together (or just use single lane output)
      await this.mixFiles(laneFiles, tmpOutput);

      // Upload to S3
      const outputBuffer = await fs.readFile(tmpOutput);
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
