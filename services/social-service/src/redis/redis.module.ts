import { Global, Module } from "@nestjs/common";
import { RedisClientProvider } from "./redis-client.provider";
import {
  CountsRepository,
  RedisCountsRepository,
} from "./repositories/counts.repository";
import {
  FollowGraphRepository,
  RedisFollowGraphRepository,
} from "./repositories/follow-graph.repository";
import {
  FeedRepository,
  RedisFeedRepository,
} from "./repositories/feed.repository";

/**
 * Wires the cache stack:
 *   - {@link RedisClientProvider}  : the singleton ioredis connection
 *   - Domain repositories          : injected throughout the app
 *
 * Repositories are registered via the Dependency Inversion pattern:
 * domain code depends on the abstract class (e.g. {@link CountsRepository}),
 * Nest provides the Redis implementation. Tests can override with
 * `overrideProvider(CountsRepository).useValue({...})`.
 *
 * The module is `@Global` so any feature module gets the repositories
 * by injection without an explicit import.
 */
@Global()
@Module({
  providers: [
    RedisClientProvider,
    { provide: CountsRepository, useClass: RedisCountsRepository },
    { provide: FollowGraphRepository, useClass: RedisFollowGraphRepository },
    { provide: FeedRepository, useClass: RedisFeedRepository },
  ],
  exports: [
    RedisClientProvider,
    CountsRepository,
    FollowGraphRepository,
    FeedRepository,
  ],
})
export class RedisModule {}
