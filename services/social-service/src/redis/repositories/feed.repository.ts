import { Injectable } from "@nestjs/common";
import { RedisClientProvider } from "../redis-client.provider";
import { SortedSetCache, PageResult } from "../caches/sorted-set-cache";

/**
 * Per-user home feed, score-ordered by content publication timestamp
 * (Unix seconds, descending = newest first).
 *
 * Update model: fan-out-on-write. When a creator publishes, we ZADD the
 * content id into every follower's feed via {@link addToFollowerFeeds}.
 * The bound (last 500 entries) is enforced by the underlying
 * {@link SortedSetCache}.
 */
export abstract class FeedRepository {
  /** Add to a single user's feed. */
  abstract add(
    userId: string,
    contentId: string,
    timestamp: number,
  ): Promise<void>;

  /** Add the same content to many users' feeds in a single pipeline. */
  abstract addToFollowerFeeds(
    followerIds: readonly string[],
    contentId: string,
    timestamp: number,
  ): Promise<void>;

  /**
   * Cursor-paginated read in score-descending order. `cursor` of `null`
   * returns the first page; subsequent calls pass back the
   * `nextCursor` from the previous response.
   */
  abstract page(
    userId: string,
    cursor: number | null,
    limit: number,
  ): Promise<PageResult>;

  /** Drop the cached feed for `userId`. */
  abstract invalidate(userId: string): Promise<void>;

  /**
   * Remove a single content id from many users' feeds in one pipeline.
   * Used by the content-deleted cleanup path. Returns the number of
   * (key, member) pairs that actually existed and were removed — useful
   * for diagnostics on cleanup jobs.
   */
  abstract removeContentFromFeeds(
    userIds: readonly string[],
    contentId: string,
  ): Promise<number>;
}

/** Bound on per-user feed size. Five hundred entries × ~16 byte ids =
 *  ~8 KB max per user, which scales comfortably on a single Redis. */
const FEED_MAX_ENTRIES = 500;

@Injectable()
export class RedisFeedRepository extends FeedRepository {
  private readonly cache: SortedSetCache;

  constructor(private readonly redis: RedisClientProvider) {
    super();
    this.cache = new SortedSetCache(redis, {
      keyPrefix: "social:feed",
      maxEntries: FEED_MAX_ENTRIES,
    });
  }

  add(userId: string, contentId: string, timestamp: number): Promise<void> {
    return this.cache.add(userId, contentId, timestamp);
  }

  addToFollowerFeeds(
    followerIds: readonly string[],
    contentId: string,
    timestamp: number,
  ): Promise<void> {
    return this.cache.addBulk(followerIds, contentId, timestamp);
  }

  page(
    userId: string,
    cursor: number | null,
    limit: number,
  ): Promise<PageResult> {
    return this.cache.pageDescending(userId, cursor, limit);
  }

  invalidate(userId: string): Promise<void> {
    return this.cache.invalidate(userId);
  }

  async removeContentFromFeeds(
    userIds: readonly string[],
    contentId: string,
  ): Promise<number> {
    if (userIds.length === 0) return 0;
    const client = this.redis.client();
    const pipeline = client.pipeline();
    for (const userId of userIds) {
      pipeline.zrem(`social:feed:${userId}`, contentId);
    }
    const results = await pipeline.exec();
    if (!results) return 0;
    return results.reduce(
      (acc, [, removed]) => acc + ((removed as number) ?? 0),
      0,
    );
  }
}
