import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  S3Client,
  PutObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { CacheService } from "../cache/cache.service";

@Injectable()
export class AudioStorageService implements OnModuleInit {
  private readonly logger = new Logger(AudioStorageService.name);
  private readonly s3: S3Client;
  private readonly s3Public: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: CacheService,
  ) {
    this.bucket = this.config.get<string>("s3.bucket", "atto-audio-segments");

    const region = this.config.get<string>("s3.region", "us-east-1");
    const credentials = {
      accessKeyId: this.config.get<string>("s3.accessKey", "atto_minio"),
      secretAccessKey: this.config.get<string>(
        "s3.secretKey",
        "atto_minio_dev",
      ),
    };
    const s3Endpoint = this.config.get<string>(
      "s3.endpoint",
      "http://localhost:9000",
    );
    const s3PublicEndpoint = this.config.get<string>(
      "s3.publicEndpoint",
      "",
    );

    // Internal client for uploads and bucket operations
    this.s3 = new S3Client({
      endpoint: s3Endpoint,
      region,
      credentials,
      forcePathStyle: true,
    });

    // Public client for generating presigned URLs accessible from outside Docker
    this.s3Public = new S3Client({
      endpoint: s3PublicEndpoint || s3Endpoint,
      region,
      credentials,
      forcePathStyle: true,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  /** Create the bucket if it doesn't exist. */
  private async ensureBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.logger.log('S3 bucket "%s" exists', this.bucket);
    } catch {
      try {
        await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log('S3 bucket "%s" created', this.bucket);
      } catch (err) {
        this.logger.error('Failed to create bucket "%s": %s', this.bucket, err);
      }
    }
  }

  /** Upload a WAV buffer to S3/MinIO. */
  async upload(
    key: string,
    data: Buffer,
    contentType = "audio/wav",
  ): Promise<{ bucket: string; key: string; size: number }> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      }),
    );

    this.logger.log("Uploaded %s (%d bytes)", key, data.length);
    return { bucket: this.bucket, key, size: data.length };
  }

  /** Generate a pre-signed URL for downloading an audio segment. */
  async getPresignedUrl(
    bucket: string,
    key: string,
    expiresIn = 3600,
  ): Promise<string> {
    const cacheKey = `telephony:presigned:${bucket}:${key}`;
    const cached = await this.cache.get<string>(cacheKey);
    if (cached) return cached;

    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const url = await getSignedUrl(this.s3Public, command, { expiresIn });

    // Cache for 50% of expiry time to ensure URLs are still valid when served
    await this.cache.set(cacheKey, url, Math.floor(expiresIn * 0.5));
    return url;
  }

  /** Build a storage key for an audio segment. */
  buildStorageKey(
    callSid: string,
    segmentIndex: number,
    track: string,
  ): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return `audio/${date}/${callSid}/${String(segmentIndex).padStart(3, "0")}_${track}.wav`;
  }
}
