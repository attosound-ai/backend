import { RedisClientProvider } from "../redis-client.provider";

export interface SortedSetCacheOptions {
  /** Key namespace, e.g. "social:feed" — caller appends the id. */
  readonly keyPrefix: string;
  /**
   * Maximum number of entries kept per sorted set. After every write
   * the lowest-scoring members beyond this bound are trimmed via
   * `ZREMRANGEBYRANK 0 -(maxEntries+1)`. For feeds this is the
   * "keep the most recent N entries" bound.
   */
  readonly maxEntries: number;
}

export interface PageResult {
  /** Members in score-descending order (newest first). */
  readonly members: string[];
  /**
   * Score of the next page (use as `cursor` for the following call) or
   * `null` when there are no more entries.
   */
  readonly nextCursor: number | null;
}

/**
 * Sorted-set cache backed by `ZADD` / `ZREVRANGEBYSCORE` for time-ordered
 * collections. Single Responsibility: hold a bounded, score-keyed set
 * of string ids and expose paginated reverse iteration.
 *
 * Used for the per-user feed where the score is a Unix timestamp and
 * members are content ids. The bound (`maxEntries`) prevents the
 * working set from growing unbounded when a power user's followees
 * post heavily — we only ever serve the most recent slice anyway.
 */
export class SortedSetCache {
  constructor(
    private readonly redis: RedisClientProvider,
    private readonly options: SortedSetCacheOptions,
  ) {}

  /** Insert a single (member, score) pair and trim to {@link SortedSetCacheOptions.maxEntries}. */
  async add(id: string, member: string, score: number): Promise<void> {
    const key = this.keyFor(id);
    const pipeline = this.redis.client().pipeline();
    pipeline.zadd(key, score, member);
    pipeline.zremrangebyrank(key, 0, -(this.options.maxEntries + 1));
    await pipeline.exec();
  }

  /**
   * Bulk insert: add `member` with the same `score` to many parent ids.
   * Used by fan-out-on-write so a single content publication can reach
   * thousands of followers in one round-trip-amortized operation.
   */
  async addBulk(
    ids: readonly string[],
    member: string,
    score: number,
  ): Promise<void> {
    if (ids.length === 0) return;
    const pipeline = this.redis.client().pipeline();
    const limit = this.options.maxEntries;
    for (const id of ids) {
      const key = this.keyFor(id);
      pipeline.zadd(key, score, member);
      pipeline.zremrangebyrank(key, 0, -(limit + 1));
    }
    await pipeline.exec();
  }

  /**
   * Score-descending pagination. `cursor` is the score returned as
   * `nextCursor` from the previous page; pass `null` (or omit) for the
   * first page. The first page returns up to `limit` entries with the
   * highest scores.
   *
   * Pagination semantics: if exactly `limit` entries are returned and
   * there's at least one more, `nextCursor` is the score of the last
   * returned entry minus 1, so the next call resumes correctly.
   */
  async pageDescending(
    id: string,
    cursor: number | null,
    limit: number,
  ): Promise<PageResult> {
    const key = this.keyFor(id);
    const maxScore = cursor != null && cursor > 0 ? cursor - 1 : "+inf";

    // Fetch one extra to detect "has more"
    const results = await this.redis
      .client()
      .zrevrangebyscore(
        key,
        maxScore,
        "-inf",
        "WITHSCORES",
        "LIMIT",
        0,
        limit + 1,
      );

    const members: string[] = [];
    let lastScore: number | null = null;
    for (let i = 0; i < results.length; i += 2) {
      members.push(results[i]);
      lastScore = Number.parseInt(results[i + 1], 10);
    }

    const hasMore = members.length > limit;
    if (hasMore) members.pop();

    return {
      members,
      nextCursor: hasMore && lastScore !== null ? lastScore : null,
    };
  }

  async invalidate(id: string): Promise<void> {
    await this.redis.client().del(this.keyFor(id));
  }

  private keyFor(id: string): string {
    return `${this.options.keyPrefix}:${id}`;
  }
}
