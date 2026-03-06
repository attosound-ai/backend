import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private client: Redis;
  private connected = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.client = new Redis({
      host: this.config.get<string>("redis.host"),
      port: this.config.get<number>("redis.port"),
      password: this.config.get<string>("redis.password"),
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      maxRetriesPerRequest: 1,
    });

    this.client.on("connect", () => {
      this.connected = true;
      this.logger.log("Redis connected");
    });

    this.client.on("error", (err) => {
      this.connected = false;
      this.logger.warn("Redis error: %s", err.message);
    });

    try {
      await this.client.connect();
    } catch {
      this.logger.warn("Redis unavailable — cache disabled, falling back to pass-through");
    }
  }

  async onModuleDestroy() {
    await this.client?.quit().catch(() => {});
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.connected) return null;
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.setex(key, ttlSeconds, JSON.stringify(value));
    } catch {
      // Silently fail — cache is optional
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.del(key);
    } catch {
      // Silently fail
    }
  }

  /** Delete all keys matching a glob pattern (e.g. "telephony:presigned:*"). */
  async deletePattern(pattern: string): Promise<number> {
    if (!this.connected) return 0;
    try {
      let deleted = 0;
      let cursor = "0";
      do {
        const [next, keys] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = next;
        if (keys.length > 0) {
          await this.client.del(...keys);
          deleted += keys.length;
        }
      } while (cursor !== "0");
      return deleted;
    } catch {
      return 0;
    }
  }

  /** Add ±10% jitter to a TTL to prevent thundering herd. */
  jitterTtl(baseTtl: number): number {
    const jitter = baseTtl * 0.1;
    return Math.round(baseTtl + (Math.random() * 2 - 1) * jitter);
  }
}
