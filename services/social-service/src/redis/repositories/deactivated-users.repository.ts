import { Injectable, Logger } from "@nestjs/common";
import { RedisClientProvider } from "../redis-client.provider";

/**
 * Accounts in their 30 day deletion grace (user-service, Nov 12 2026). They
 * still exist, but nobody else may see their posts, comments or profile
 * rows until they recover the account or the final deletion purges them.
 *
 * Fed by the user.deactivated / user.reactivated Kafka events into one
 * Redis SET without TTL (a few dozen ids at most). user-service is the
 * source of truth; this is only the copy social needs on every read.
 */
export abstract class DeactivatedUsersRepository {
  abstract add(userIds: string[]): Promise<void>;
  abstract remove(userIds: string[]): Promise<void>;
  /** The ids among `userIds` that are deactivated. Never throws: on a
   * Redis error it answers an empty set so the feed keeps working. */
  abstract among(userIds: string[]): Promise<Set<string>>;
}

export const DEACTIVATED_USERS_KEY = "social:deactivated_users";

@Injectable()
export class RedisDeactivatedUsersRepository extends DeactivatedUsersRepository {
  private readonly logger = new Logger(RedisDeactivatedUsersRepository.name);

  constructor(private readonly redis: RedisClientProvider) {
    super();
  }

  async add(userIds: string[]): Promise<void> {
    const ids = clean(userIds);
    if (ids.length === 0) return;
    await this.redis.client().sadd(DEACTIVATED_USERS_KEY, ...ids);
  }

  async remove(userIds: string[]): Promise<void> {
    const ids = clean(userIds);
    if (ids.length === 0) return;
    await this.redis.client().srem(DEACTIVATED_USERS_KEY, ...ids);
  }

  async among(userIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(clean(userIds))];
    if (ids.length === 0) return new Set();
    try {
      const flags = await this.redis
        .client()
        .smismember(DEACTIVATED_USERS_KEY, ...ids);
      const out = new Set<string>();
      flags.forEach((f, i) => {
        if (f === 1) out.add(ids[i]);
      });
      return out;
    } catch (err) {
      this.logger.warn(
        `deactivated lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return new Set();
    }
  }
}

function clean(ids: string[]): string[] {
  return (ids ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
}
