import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { CountsRepository } from '../redis/repositories/counts.repository';
import { FollowGraphRepository } from '../redis/repositories/follow-graph.repository';

@Injectable()
export class GrpcServerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GrpcServerService.name);
  private server: grpc.Server;

  constructor(
    private readonly prisma: PrismaService,
    private readonly counts: CountsRepository,
    private readonly followGraph: FollowGraphRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    const protoPath = path.resolve(
      process.cwd(),
      '..',
      '..',
      'proto',
      'social.proto',
    );

    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [path.resolve(process.cwd(), '..', '..', 'proto')],
    });

    const proto = grpc.loadPackageDefinition(packageDefinition) as any;

    this.server = new grpc.Server();

    this.server.addService(proto.atto.social.SocialService.service, {
      GetFollowersCount: this.getFollowersCount.bind(this),
      GetFollowingCount: this.getFollowingCount.bind(this),
      GetPostsCount: this.getPostsCount.bind(this),
      GetInteractionCounts: this.getInteractionCounts.bind(this),
      IsFollowing: this.isFollowing.bind(this),
      IsLiked: this.isLiked.bind(this),
    });

    const port = process.env.GRPC_PORT || '50053';
    this.server.bindAsync(
      `0.0.0.0:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (err, boundPort) => {
        if (err) {
          this.logger.error(`Failed to bind gRPC server: ${err.message}`);
          return;
        }
        this.logger.log(`gRPC server listening on port ${boundPort}`);
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.server) {
      this.server.forceShutdown();
      this.logger.log('gRPC server shut down');
    }
  }

  private async getFollowersCount(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>,
  ): Promise<void> {
    try {
      const { userId } = call.request;
      const count = await this.counts.getOrCompute("followers", userId, () =>
        this.prisma.follow.count({ where: { followingId: userId } }),
      );
      callback(null, { count });
    } catch (error) {
      this.logger.error(`GetFollowersCount error: ${error.message}`);
      callback({ code: grpc.status.INTERNAL, message: error.message });
    }
  }

  private async getFollowingCount(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>,
  ): Promise<void> {
    try {
      const { userId } = call.request;
      const count = await this.counts.getOrCompute("following", userId, () =>
        this.prisma.follow.count({ where: { followerId: userId } }),
      );
      callback(null, { count });
    } catch (error) {
      this.logger.error(`GetFollowingCount error: ${error.message}`);
      callback({ code: grpc.status.INTERNAL, message: error.message });
    }
  }

  private async getPostsCount(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>,
  ): Promise<void> {
    try {
      const { userId } = call.request;
      // Source of truth for posts lives in content-service. The loader
      // here returns 0 — same behavior as before — but now zeros are
      // cached with the negative-TTL policy, so a creator-with-no-posts
      // doesn't trigger a Redis lookup that misses on every gRPC call.
      const count = await this.counts.getOrCompute("posts", userId, async () => 0);
      callback(null, { count });
    } catch (error) {
      this.logger.error(`GetPostsCount error: ${error.message}`);
      callback({ code: grpc.status.INTERNAL, message: error.message });
    }
  }

  private async getInteractionCounts(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>,
  ): Promise<void> {
    try {
      const { contentId } = call.request;
      const [likesCount, commentsCount, sharesCount] = await Promise.all([
        this.counts.getOrCompute("likes", contentId, () =>
          this.prisma.interaction.count({ where: { contentId, type: "LIKE" } }),
        ),
        this.counts.getOrCompute("comments", contentId, () =>
          this.prisma.interaction.count({
            where: { contentId, type: "COMMENT" },
          }),
        ),
        this.counts.getOrCompute("shares", contentId, () =>
          this.prisma.interaction.count({
            where: { contentId, type: "SHARE" },
          }),
        ),
      ]);
      callback(null, { likesCount, commentsCount, sharesCount });
    } catch (error) {
      this.logger.error(`GetInteractionCounts error: ${error.message}`);
      callback({ code: grpc.status.INTERNAL, message: error.message });
    }
  }

  private async isFollowing(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>,
  ): Promise<void> {
    try {
      const { followerId, followingId } = call.request;

      // Cache says "yes" → trust it (false-positive on a cached entry
      // would require an out-of-band write that bypassed the repo).
      // Cache says "no" → could be a genuine "no" OR a cold cache, so
      // fall through to DB to avoid false negatives.
      const cachedResult = await this.followGraph.isFollowing(
        followerId,
        followingId,
      );
      if (cachedResult) {
        callback(null, { result: true });
        return;
      }

      const follow = await this.prisma.follow.findUnique({
        where: {
          followerId_followingId: { followerId, followingId },
        },
      });

      callback(null, { result: !!follow });
    } catch (error) {
      this.logger.error(`IsFollowing error: ${error.message}`);
      callback({
        code: grpc.status.INTERNAL,
        message: error.message,
      });
    }
  }

  private async isLiked(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>,
  ): Promise<void> {
    try {
      const { userId, contentId } = call.request;

      const interaction = await this.prisma.interaction.findUnique({
        where: {
          userId_contentId_type: {
            userId,
            contentId,
            type: 'LIKE',
          },
        },
      });

      callback(null, { result: !!interaction });
    } catch (error) {
      this.logger.error(`IsLiked error: ${error.message}`);
      callback({
        code: grpc.status.INTERNAL,
        message: error.message,
      });
    }
  }
}
