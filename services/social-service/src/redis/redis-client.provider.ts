import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import Redis from "ioredis";

/**
 * Owns the lifecycle of the single ioredis connection used by every
 * Redis-backed cache and repository in this service.
 *
 * Single Responsibility: connect, expose, disconnect. No domain logic,
 * no key-naming, no TTL policy — those live one layer up.
 *
 * The provider is registered as a singleton in {@link RedisModule}; all
 * cache primitives and repositories receive the same client through DI,
 * so connection-pool churn is bounded by the service-level pool of
 * ioredis itself rather than by reconnects per-collaborator.
 */
@Injectable()
export class RedisClientProvider implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisClientProvider.name);
  private clientInstance: Redis | null = null;

  onModuleInit(): void {
    const url = process.env.REDIS_URL || "redis://localhost:6379";

    this.clientInstance = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number): number | null => {
        if (times > 5) return null;
        return Math.min(times * 200, 2000);
      },
      lazyConnect: false,
    });

    this.clientInstance.on("connect", () => {
      this.logger.log("Connected to Redis");
    });

    this.clientInstance.on("error", (err) => {
      this.logger.error(`Redis error: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.clientInstance) {
      await this.clientInstance.quit();
      this.logger.log("Disconnected from Redis");
      this.clientInstance = null;
    }
  }

  /**
   * Returns the raw ioredis client. Cache primitives use this to issue
   * commands; domain code should NOT depend on this directly — depend on
   * a Repository or Cache abstraction instead.
   */
  client(): Redis {
    if (!this.clientInstance) {
      throw new Error(
        "RedisClientProvider used before onModuleInit completed",
      );
    }
    return this.clientInstance;
  }
}
