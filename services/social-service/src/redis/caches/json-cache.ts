import { Logger } from "@nestjs/common";
import { RedisClientProvider } from "../redis-client.provider";

export interface JsonCacheOptions {
  /** Key namespace, e.g. "social:user" -- caller appends the id. */
  readonly keyPrefix: string;
  /** TTL applied on every write. No keys without TTL. */
  readonly ttlSeconds: number;
  /**
   * When the loader returns `null` (entity not found) we cache the
   * absence using a sentinel marker for `negativeTtlSeconds` so a
   * subsequent miss-on-miss doesn't re-hit the source. Disabled when
   * `undefined`.
   */
  readonly negativeTtlSeconds?: number;
}

// Sentinel for negative caching. The leading "@" is illegal at the
// start of a serialized JSON value (which always begins with one of
// {, [, ", -, 0..9, t, f, n), so this string can never collide with a
// legitimately cached entity.
const NEGATIVE_MARKER = "@@cache:negative@@";

/**
 * Generic typed key-value cache backed by Redis with JSON serialization.
 * Single Responsibility: serialize a `T` to/from a string under a fixed
 * key prefix, with read-through and negative-caching semantics.
 *
 * Used for things like cached user profiles where the value is a small
 * record; for primitive types (counts, sets, sorted sets) prefer the
 * dedicated primitives in this folder so the data-structure choice is
 * explicit at the call site.
 */
export class JsonCache<T extends object> {
  private readonly logger = new Logger(JsonCache.name);

  constructor(
    private readonly redis: RedisClientProvider,
    private readonly options: JsonCacheOptions,
  ) {}

  /**
   * Returns the cached value if present, otherwise runs `loader`, caches
   * the result (including a sentinel for `null`), and returns it.
   */
  async getOrCompute(
    id: string,
    loader: () => Promise<T | null>,
  ): Promise<T | null> {
    const key = this.keyFor(id);
    const cached = await this.redis.client().get(key);

    if (cached === NEGATIVE_MARKER) return null;
    if (cached !== null) {
      try {
        return JSON.parse(cached) as T;
      } catch (err) {
        this.logger.warn(
          `corrupt JSON at ${key} (${(err as Error).message}) -- recomputing`,
        );
      }
    }

    const fresh = await loader();
    if (fresh !== null) {
      await this.set(id, fresh);
    } else if (this.options.negativeTtlSeconds !== undefined) {
      await this.redis
        .client()
        .set(key, NEGATIVE_MARKER, "EX", this.options.negativeTtlSeconds);
    }
    return fresh;
  }

  async set(id: string, value: T): Promise<void> {
    await this.redis
      .client()
      .set(this.keyFor(id), JSON.stringify(value), "EX", this.options.ttlSeconds);
  }

  async invalidate(id: string): Promise<void> {
    await this.redis.client().del(this.keyFor(id));
  }

  /**
   * Batch read in a single pipelined round-trip. Returns a map of
   * `id -> value | null`. A `null` value here means EITHER missing
   * (truly uncached) OR cached-as-negative -- the caller can't
   * distinguish, but for typical "fetch many users" use cases that's
   * the right behavior (no fallback needed for either).
   *
   * For a true distinction, callers should use {@link getOrCompute}
   * one-by-one.
   */
  async getMany(ids: readonly string[]): Promise<Map<string, T | null>> {
    const out = new Map<string, T | null>();
    if (ids.length === 0) return out;

    const pipeline = this.redis.client().pipeline();
    for (const id of ids) {
      pipeline.get(this.keyFor(id));
    }
    const results = await pipeline.exec();
    if (!results) {
      for (const id of ids) out.set(id, null);
      return out;
    }

    for (let i = 0; i < ids.length; i++) {
      const raw = results[i]?.[1];
      if (typeof raw !== "string") {
        out.set(ids[i], null);
        continue;
      }
      if (raw === NEGATIVE_MARKER) {
        out.set(ids[i], null);
        continue;
      }
      try {
        out.set(ids[i], JSON.parse(raw) as T);
      } catch {
        out.set(ids[i], null);
      }
    }
    return out;
  }

  /** Batch write (positive entries only -- negatives use {@link getOrCompute}'s sentinel path). */
  async setMany(entries: ReadonlyArray<{ id: string; value: T }>): Promise<void> {
    if (entries.length === 0) return;
    const pipeline = this.redis.client().pipeline();
    for (const { id, value } of entries) {
      pipeline.set(
        this.keyFor(id),
        JSON.stringify(value),
        "EX",
        this.options.ttlSeconds,
      );
    }
    await pipeline.exec();
  }

  private keyFor(id: string): string {
    return `${this.options.keyPrefix}:${id}`;
  }
}
