import { Logger } from "@nestjs/common";
import { RedisClientProvider } from "../redis-client.provider";

export interface CounterCacheOptions {
  /** Key namespace, e.g. "social:count:likes" — caller appends the id. */
  readonly keyPrefix: string;
  /** TTL on initial seed and on re-sync. INCR/DECR preserve the existing TTL. */
  readonly ttlSeconds: number;
  /**
   * When the loader returns 0, cache it explicitly with a shorter TTL so
   * subsequent reads hit. A 0 in Redis is a valid answer; previously we
   * skipped the write and every read for "user with no likes" turned into
   * a fresh DB query — counted as a miss against the keyspace_hits ratio.
   */
  readonly negativeTtlSeconds?: number;
}

/**
 * Counter cache backed by Redis `INCR` / `DECR` semantics with proper
 * TTL hygiene and negative caching. Single Responsibility: maintain a
 * numeric counter for a stable id under a fixed key prefix.
 *
 * Bug fix: the previous god-class issued an explicit `PERSIST` after
 * every increment/decrement, which removed the TTL set during the
 * initial sync from the database. Counts then lived forever and could
 * silently drift from the durable store (Postgres). This class never
 * calls PERSIST; INCR/DECR inherit the existing TTL by Redis design.
 *
 * Stampede note: counter reads are extremely cheap (`GET`), so a true
 * single-flight lock is overkill. Negative caching plus a short
 * defensive TTL is enough to bound the herd.
 */
export class CounterCache {
  private readonly logger = new Logger(CounterCache.name);

  constructor(
    private readonly redis: RedisClientProvider,
    private readonly options: CounterCacheOptions,
  ) {}

  /**
   * Read-through pattern: returns the cached value if present, otherwise
   * runs `loader`, caches the result (including 0 if `negativeTtlSeconds`
   * is set), and returns it.
   *
   * The loader is the source-of-truth query (typically a DB count). It
   * MUST be idempotent and side-effect-free — callers should expect it
   * to run zero or more times for the same key during a window.
   */
  async getOrCompute(id: string, loader: () => Promise<number>): Promise<number> {
    const key = this.keyFor(id);
    const cached = await this.redis.client().get(key);

    if (cached !== null) {
      const parsed = Number.parseInt(cached, 10);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;

      // Corrupt cache value — log and recompute. Treat as miss.
      this.logger.warn(
        `corrupt counter at ${key}=${cached}, recomputing from loader`,
      );
    }

    const fresh = await loader();
    await this.set(id, fresh);
    return fresh;
  }

  /**
   * Force-write a value (e.g. after a periodic re-sync from the source
   * of truth). Always sets TTL — never leaves a key without expiry.
   * If `count` is 0, uses {@link CounterCacheOptions.negativeTtlSeconds}
   * when configured, otherwise falls back to {@link CounterCacheOptions.ttlSeconds}.
   */
  async set(id: string, count: number): Promise<void> {
    const key = this.keyFor(id);
    const ttl =
      count === 0 && this.options.negativeTtlSeconds !== undefined
        ? this.options.negativeTtlSeconds
        : this.options.ttlSeconds;
    await this.redis.client().set(key, String(count), "EX", ttl);
  }

  /**
   * Atomic increment that preserves the existing TTL (Redis guarantees
   * INCR does not modify expiry). If the key does not exist, INCR
   * initializes it to 1 with NO TTL — to avoid that, callers should
   * ensure {@link getOrCompute} or {@link set} has run at least once
   * for the id, or treat the resulting unbounded key as a known risk.
   */
  async increment(id: string): Promise<number> {
    return this.redis.client().incr(this.keyFor(id));
  }

  /**
   * Atomic decrement that clamps at zero. Counts are denormalized
   * caches of source-of-truth COUNT(*) results which cannot be
   * negative; observing a negative value here means we have a logic
   * bug (double-decrement, missing seed, race) — clamp silently and
   * log so it's diagnosable without breaking user-visible flows.
   */
  async decrement(id: string): Promise<number> {
    const key = this.keyFor(id);
    const next = await this.redis.client().decr(key);
    if (next < 0) {
      this.logger.warn(`decrement underflow on ${key} — clamped to 0`);
      // Use SET (no EX) to preserve any existing TTL on the key.
      await this.redis.client().set(key, "0", "KEEPTTL");
      return 0;
    }
    return next;
  }

  async invalidate(id: string): Promise<void> {
    await this.redis.client().del(this.keyFor(id));
  }

  /**
   * Batch read in a single pipelined round-trip. Returns a map of
   * `id → cachedValue`. Missing keys are returned as `null` (so callers
   * can distinguish "cached as 0" from "uncached"). The caller is
   * expected to fan out to the source-of-truth for the missing ids and
   * write them back via {@link setMany}.
   *
   * Why not extend `getOrCompute` with a batch loader? Two reasons:
   *  1. Domain code already wants to GROUP BY across the missing ids
   *     for efficiency — that's batch-loader knowledge that doesn't
   *     belong in a generic cache primitive.
   *  2. Keeping `getOrCompute` single-key keeps its cardinality
   *     analysis simple (each call = one cache lookup).
   */
  async getMany(ids: readonly string[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
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
      const parsed = Number.parseInt(raw, 10);
      out.set(ids[i], Number.isFinite(parsed) && parsed >= 0 ? parsed : null);
    }
    return out;
  }

  /**
   * Batch write with TTL applied per entry (using `negativeTtlSeconds`
   * for zeros when configured). Single pipelined round-trip.
   */
  async setMany(entries: ReadonlyArray<{ id: string; count: number }>): Promise<void> {
    if (entries.length === 0) return;
    const pipeline = this.redis.client().pipeline();
    for (const { id, count } of entries) {
      const ttl =
        count === 0 && this.options.negativeTtlSeconds !== undefined
          ? this.options.negativeTtlSeconds
          : this.options.ttlSeconds;
      pipeline.set(this.keyFor(id), String(count), "EX", ttl);
    }
    await pipeline.exec();
  }

  private keyFor(id: string): string {
    return `${this.options.keyPrefix}:${id}`;
  }
}
