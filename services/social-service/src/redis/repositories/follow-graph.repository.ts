import { Injectable } from "@nestjs/common";
import { RedisClientProvider } from "../redis-client.provider";
import { SetCache } from "../caches/set-cache";

/**
 * Encapsulates the bidirectional follow graph (`following` + `followers`)
 * as two cooperating SET caches. The two sides MUST stay consistent:
 * every {@link addEdge} touches both, ditto {@link removeEdge}.
 *
 * The follow graph is *write-through cache* over Postgres' `follows`
 * table — domain code writes the row in Postgres first, then mirrors
 * the change here. Read operations may fall through to Postgres on
 * cold keys via {@link getFollowingOrMaterialize} /
 * {@link getFollowersOrMaterialize}.
 */
export abstract class FollowGraphRepository {
  /** Add a follow edge from `followerId` to `followingId` in both sides. */
  abstract addEdge(followerId: string, followingId: string): Promise<void>;

  /** Remove the follow edge from `followerId` to `followingId`. */
  abstract removeEdge(followerId: string, followingId: string): Promise<void>;

  /** Ids that `userId` follows. Falls back to Redis only — caller wanting
   * read-through must use {@link getFollowingOrMaterialize}. */
  abstract getFollowing(userId: string): Promise<string[]>;

  /** Ids that follow `userId`. Pure cache read. */
  abstract getFollowers(userId: string): Promise<string[]>;

  /** O(1) membership check on the cached set. */
  abstract isFollowing(
    followerId: string,
    followingId: string,
  ): Promise<boolean>;

  /** Read-through: returns the cached set or materializes from `loader`. */
  abstract getFollowingOrMaterialize(
    userId: string,
    loader: () => Promise<string[]>,
  ): Promise<string[]>;

  /** Read-through: returns the cached set or materializes from `loader`. */
  abstract getFollowersOrMaterialize(
    userId: string,
    loader: () => Promise<string[]>,
  ): Promise<string[]>;

  /**
   * Drop both the `following` and `followers` SETs for `userId`. Used
   * by the user-deletion cleanup path after the per-edge `removeEdge`
   * calls have already mutated the counterparties' sets — this is a
   * defensive `DEL` of the user's own keys to guarantee no leftovers.
   */
  abstract invalidateUser(userId: string): Promise<void>;
}

/** TTL for follow-graph caches. Long enough to absorb fan-out and
 *  pagination workloads, short enough that an out-of-band edit (e.g.
 *  database surgery) heals within the hour. */
const FOLLOW_GRAPH_TTL_SECONDS = 60 * 60;

@Injectable()
export class RedisFollowGraphRepository extends FollowGraphRepository {
  private readonly following: SetCache;
  private readonly followers: SetCache;

  constructor(redis: RedisClientProvider) {
    super();
    this.following = new SetCache(redis, {
      keyPrefix: "social:following",
      ttlSeconds: FOLLOW_GRAPH_TTL_SECONDS,
    });
    this.followers = new SetCache(redis, {
      keyPrefix: "social:followers",
      ttlSeconds: FOLLOW_GRAPH_TTL_SECONDS,
    });
  }

  async addEdge(followerId: string, followingId: string): Promise<void> {
    await Promise.all([
      this.following.add(followerId, followingId),
      this.followers.add(followingId, followerId),
    ]);
  }

  async removeEdge(followerId: string, followingId: string): Promise<void> {
    await Promise.all([
      this.following.remove(followerId, followingId),
      this.followers.remove(followingId, followerId),
    ]);
  }

  getFollowing(userId: string): Promise<string[]> {
    return this.following.members(userId);
  }

  getFollowers(userId: string): Promise<string[]> {
    return this.followers.members(userId);
  }

  isFollowing(followerId: string, followingId: string): Promise<boolean> {
    return this.following.has(followerId, followingId);
  }

  getFollowingOrMaterialize(
    userId: string,
    loader: () => Promise<string[]>,
  ): Promise<string[]> {
    return this.following.getOrMaterialize(userId, loader);
  }

  getFollowersOrMaterialize(
    userId: string,
    loader: () => Promise<string[]>,
  ): Promise<string[]> {
    return this.followers.getOrMaterialize(userId, loader);
  }

  async invalidateUser(userId: string): Promise<void> {
    await Promise.all([
      this.following.invalidate(userId),
      this.followers.invalidate(userId),
    ]);
  }
}
