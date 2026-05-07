import { Injectable } from "@nestjs/common";
import { RedisClientProvider } from "../redis-client.provider";
import { CounterCache } from "../caches/counter-cache";

/**
 * Domain types of counts denormalized in this service. The string union
 * is the wire-level vocabulary — extending it requires adding a row to
 * {@link CountsRepository}'s internal cache map and is intentionally
 * a centralized decision (avoids accidental new namespaces).
 */
export type CountType =
  | "likes"
  | "comments"
  | "shares"
  | "reposts"
  | "posts"
  | "followers"
  | "following";

/**
 * Abstract contract used by domain services. Tests can inject an
 * in-memory implementation; production wires the Redis-backed subclass.
 * Liskov substitutability guides the contract: every method's
 * post-conditions are stated in terms the caller can rely on without
 * caring about the storage backend.
 */
export abstract class CountsRepository {
  /**
   * Returns the current count for the given (type, id), populating the
   * cache from `loader` on miss. Cached zeros are still returned as 0
   * (no extra DB call) — see {@link CounterCache} for negative-caching
   * details.
   */
  abstract getOrCompute(
    type: CountType,
    id: string,
    loader: () => Promise<number>,
  ): Promise<number>;

  /** Atomic increment. No-op if the key has not been seeded — caller
   * SHOULD have invoked {@link getOrCompute} or {@link set} previously,
   * otherwise the resulting key has no TTL (Redis INCR creates with
   * EXPIRE -1). */
  abstract increment(type: CountType, id: string): Promise<number>;

  /** Atomic decrement, clamped at zero. */
  abstract decrement(type: CountType, id: string): Promise<number>;

  /** Force-write a value with TTL. Use for periodic re-sync. */
  abstract set(type: CountType, id: string, count: number): Promise<void>;

  /** Drop the cached entry — next read will fall through to the loader. */
  abstract invalidate(type: CountType, id: string): Promise<void>;

  /** Batch read in a single round-trip. Map values are `null` for cache
   *  misses (so callers can distinguish missing from cached-zero). */
  abstract getMany(
    type: CountType,
    ids: readonly string[],
  ): Promise<Map<string, number | null>>;

  /** Batch write with the same TTL policy as {@link set}. */
  abstract setMany(
    type: CountType,
    entries: ReadonlyArray<{ id: string; count: number }>,
  ): Promise<void>;
}

/**
 * Default TTLs per count type. Hot path counts (likes/comments) use a
 * shorter TTL so cache drift is bounded; rare-mutation counts
 * (followers, posts) get longer TTLs to maximize hit rate.
 *
 * Negative TTL is shorter still (60 s): "this user has zero likes" is
 * the kind of value that flips to 1 the moment someone acts, so we
 * don't want to keep "0" cached for an hour.
 */
const TTL_BY_TYPE: Record<CountType, { ttl: number; negativeTtl: number }> = {
  likes: { ttl: 600, negativeTtl: 60 },
  comments: { ttl: 600, negativeTtl: 60 },
  shares: { ttl: 600, negativeTtl: 60 },
  reposts: { ttl: 600, negativeTtl: 60 },
  posts: { ttl: 1800, negativeTtl: 60 },
  followers: { ttl: 1800, negativeTtl: 60 },
  following: { ttl: 1800, negativeTtl: 60 },
};

@Injectable()
export class RedisCountsRepository extends CountsRepository {
  private readonly caches: Record<CountType, CounterCache>;

  constructor(redis: RedisClientProvider) {
    super();
    this.caches = Object.fromEntries(
      (Object.keys(TTL_BY_TYPE) as CountType[]).map((type) => [
        type,
        new CounterCache(redis, {
          keyPrefix: `social:count:${type}`,
          ttlSeconds: TTL_BY_TYPE[type].ttl,
          negativeTtlSeconds: TTL_BY_TYPE[type].negativeTtl,
        }),
      ]),
    ) as Record<CountType, CounterCache>;
  }

  getOrCompute(
    type: CountType,
    id: string,
    loader: () => Promise<number>,
  ): Promise<number> {
    return this.caches[type].getOrCompute(id, loader);
  }

  increment(type: CountType, id: string): Promise<number> {
    return this.caches[type].increment(id);
  }

  decrement(type: CountType, id: string): Promise<number> {
    return this.caches[type].decrement(id);
  }

  set(type: CountType, id: string, count: number): Promise<void> {
    return this.caches[type].set(id, count);
  }

  invalidate(type: CountType, id: string): Promise<void> {
    return this.caches[type].invalidate(id);
  }

  getMany(
    type: CountType,
    ids: readonly string[],
  ): Promise<Map<string, number | null>> {
    return this.caches[type].getMany(ids);
  }

  setMany(
    type: CountType,
    entries: ReadonlyArray<{ id: string; count: number }>,
  ): Promise<void> {
    return this.caches[type].setMany(entries);
  }
}
