import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  onModuleInit(): void {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number): number | null {
        if (times > 5) return null;
        return Math.min(times * 200, 2000);
      },
      lazyConnect: false,
    });

    this.client.on('connect', () => {
      this.logger.log('Connected to Redis');
    });

    this.client.on('error', (err) => {
      this.logger.error(`Redis error: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.logger.log('Disconnected from Redis');
    }
  }

  getClient(): Redis {
    return this.client;
  }

  // ── Follow Graph (SET) ──

  private followingKey(userId: string): string {
    return `social:following:${userId}`;
  }

  private followersKey(userId: string): string {
    return `social:followers:${userId}`;
  }

  async addFollow(followerId: string, followingId: string): Promise<void> {
    const pipeline = this.client.pipeline();
    pipeline.sadd(this.followingKey(followerId), followingId);
    pipeline.sadd(this.followersKey(followingId), followerId);
    await pipeline.exec();
  }

  async removeFollow(followerId: string, followingId: string): Promise<void> {
    const pipeline = this.client.pipeline();
    pipeline.srem(this.followingKey(followerId), followingId);
    pipeline.srem(this.followersKey(followingId), followerId);
    await pipeline.exec();
  }

  async getFollowingIds(userId: string): Promise<string[]> {
    return this.client.smembers(this.followingKey(userId));
  }

  async getFollowerIds(userId: string): Promise<string[]> {
    return this.client.smembers(this.followersKey(userId));
  }

  async isFollowing(followerId: string, followingId: string): Promise<boolean> {
    const result = await this.client.sismember(
      this.followingKey(followerId),
      followingId,
    );
    return result === 1;
  }

  async getFollowingCount(userId: string): Promise<number> {
    return this.client.scard(this.followingKey(userId));
  }

  async getFollowersCount(userId: string): Promise<number> {
    return this.client.scard(this.followersKey(userId));
  }

  // ── Feed Cache (SORTED SET by timestamp) ──

  private feedKey(userId: string): string {
    return `social:feed:${userId}`;
  }

  async addToFeed(
    userId: string,
    contentId: string,
    timestamp: number,
  ): Promise<void> {
    await this.client.zadd(this.feedKey(userId), timestamp, contentId);
    // Keep feed trimmed to last 500 entries
    await this.client.zremrangebyrank(this.feedKey(userId), 0, -501);
  }

  async getFeedContentIds(
    userId: string,
    cursor: number,
    limit: number,
  ): Promise<{ contentIds: string[]; nextCursor: number | null }> {
    const key = this.feedKey(userId);
    const maxScore = cursor > 0 ? cursor - 1 : '+inf';
    const results = await this.client.zrevrangebyscore(
      key,
      maxScore,
      '-inf',
      'WITHSCORES',
      'LIMIT',
      0,
      limit + 1,
    );

    const contentIds: string[] = [];
    let lastScore: number | null = null;
    for (let i = 0; i < results.length; i += 2) {
      contentIds.push(results[i]);
      lastScore = parseInt(results[i + 1], 10);
    }

    const hasMore = contentIds.length > limit;
    if (hasMore) {
      contentIds.pop();
    }

    return {
      contentIds,
      nextCursor: hasMore && lastScore !== null ? lastScore : null,
    };
  }

  async addToFeedBulk(
    followerIds: string[],
    contentId: string,
    timestamp: number,
  ): Promise<void> {
    if (followerIds.length === 0) return;
    const pipeline = this.client.pipeline();
    for (const followerId of followerIds) {
      pipeline.zadd(this.feedKey(followerId), timestamp, contentId);
      pipeline.zremrangebyrank(this.feedKey(followerId), 0, -501);
    }
    await pipeline.exec();
  }

  // ── Counts Cache (STRING) ──

  private countKey(type: string, id: string): string {
    return `social:count:${type}:${id}`;
  }

  async incrementCount(type: string, id: string): Promise<void> {
    await this.client.incr(this.countKey(type, id));
  }

  async decrementCount(type: string, id: string): Promise<void> {
    await this.client.decr(this.countKey(type, id));
  }

  async getCount(type: string, id: string): Promise<number> {
    const val = await this.client.get(this.countKey(type, id));
    return val ? parseInt(val, 10) : 0;
  }

  async setCount(type: string, id: string, count: number): Promise<void> {
    await this.client.set(this.countKey(type, id), count, 'EX', 3600);
  }

  // ── Generic cache ──

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}
