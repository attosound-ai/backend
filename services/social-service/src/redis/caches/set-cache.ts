import { RedisClientProvider } from "../redis-client.provider";

export interface SetCacheOptions {
  /** Key namespace, e.g. "social:following" — caller appends the id. */
  readonly keyPrefix: string;
  /**
   * TTL applied when the set is (re-)materialized from the source of
   * truth via {@link SetCache.materialize}. Reads through `members` /
   * `has` do not refresh the TTL by themselves — see ADR notes in
   * {@link SetCache}.
   */
  readonly ttlSeconds: number;
}

/**
 * Set cache backed by Redis `SADD` / `SREM` / `SMEMBERS` / `SISMEMBER`.
 * Single Responsibility: hold an unordered collection of string ids
 * for a stable parent id.
 *
 * Why a dedicated class instead of "generic cache":
 *  - SET semantics are naturally idempotent (SADD twice = once),
 *    which matters for read-through correctness.
 *  - SCARD / SISMEMBER are O(1); we expose them so domain code does
 *    not invoke SMEMBERS just to check membership or count.
 *  - TTL is set on the whole set, not per-member — encoding that
 *    correctly here keeps domain code straightforward.
 *
 * Read-through caveat: SET caches lose individual freshness when the
 * underlying source mutates without going through this class. The
 * canonical pattern in this codebase is "DB write first, then SADD/SREM
 * here" (write-through). Domain code that wants read-through must call
 * {@link materialize} when it detects a cold key.
 */
export class SetCache {
  constructor(
    private readonly redis: RedisClientProvider,
    private readonly options: SetCacheOptions,
  ) {}

  /** Add a member. Caller is responsible for ensuring the set has been
   * materialized at least once if read-through correctness matters. */
  async add(id: string, member: string): Promise<void> {
    await this.redis.client().sadd(this.keyFor(id), member);
  }

  async remove(id: string, member: string): Promise<void> {
    await this.redis.client().srem(this.keyFor(id), member);
  }

  /** All members. Empty array on cache miss; callers wanting
   * read-through should use {@link materializeIfMissing}. */
  async members(id: string): Promise<string[]> {
    return this.redis.client().smembers(this.keyFor(id));
  }

  async has(id: string, member: string): Promise<boolean> {
    const result = await this.redis.client().sismember(this.keyFor(id), member);
    return result === 1;
  }

  async size(id: string): Promise<number> {
    return this.redis.client().scard(this.keyFor(id));
  }

  /**
   * Replace the entire set with `members` and apply the configured TTL.
   * Used for read-through (re-materialization from the source of truth)
   * and for periodic resync jobs.
   */
  async materialize(id: string, members: string[]): Promise<void> {
    const key = this.keyFor(id);
    const client = this.redis.client();
    const pipeline = client.pipeline();
    pipeline.del(key);
    if (members.length > 0) {
      pipeline.sadd(key, ...members);
    }
    pipeline.expire(key, this.options.ttlSeconds);
    await pipeline.exec();
  }

  /**
   * Returns the set's members; if the key does not exist, runs `loader`
   * to materialize it from the source of truth and returns the result.
   * Negative result (empty array) is also cached — under the same TTL —
   * so a "user follows nobody" scenario doesn't translate into one DB
   * query per request.
   */
  async getOrMaterialize(
    id: string,
    loader: () => Promise<string[]>,
  ): Promise<string[]> {
    const key = this.keyFor(id);
    const client = this.redis.client();
    const exists = await client.exists(key);
    if (exists === 1) {
      return client.smembers(key);
    }
    const fresh = await loader();
    await this.materialize(id, fresh);
    return fresh;
  }

  async invalidate(id: string): Promise<void> {
    await this.redis.client().del(this.keyFor(id));
  }

  private keyFor(id: string): string {
    return `${this.options.keyPrefix}:${id}`;
  }
}
