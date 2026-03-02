import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class GrpcServerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GrpcServerService.name);
  private server: grpc.Server;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
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

      // Try Redis first
      let count = await this.redis.getFollowersCount(userId);
      if (count === 0) {
        // Fall back to DB
        count = await this.prisma.follow.count({
          where: { followingId: userId },
        });
      }

      callback(null, { count });
    } catch (error) {
      this.logger.error(`GetFollowersCount error: ${error.message}`);
      callback({
        code: grpc.status.INTERNAL,
        message: error.message,
      });
    }
  }

  private async getFollowingCount(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>,
  ): Promise<void> {
    try {
      const { userId } = call.request;

      let count = await this.redis.getFollowingCount(userId);
      if (count === 0) {
        count = await this.prisma.follow.count({
          where: { followerId: userId },
        });
      }

      callback(null, { count });
    } catch (error) {
      this.logger.error(`GetFollowingCount error: ${error.message}`);
      callback({
        code: grpc.status.INTERNAL,
        message: error.message,
      });
    }
  }

  private async getPostsCount(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>,
  ): Promise<void> {
    try {
      const { userId } = call.request;

      // Posts count is tracked via interactions or content service
      // We cache it in Redis
      let count = await this.redis.getCount('posts', userId);
      if (count === 0) {
        // Count interactions of type that indicate a post
        // In this context, posts are created via Content service.
        // We return the cached value or 0
        count = 0;
      }

      callback(null, { count });
    } catch (error) {
      this.logger.error(`GetPostsCount error: ${error.message}`);
      callback({
        code: grpc.status.INTERNAL,
        message: error.message,
      });
    }
  }

  private async getInteractionCounts(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>,
  ): Promise<void> {
    try {
      const { contentId } = call.request;

      // Try Redis cache first
      const cachedLikes = await this.redis.getCount('likes', contentId);
      const cachedComments = await this.redis.getCount('comments', contentId);
      const cachedShares = await this.redis.getCount('shares', contentId);

      if (cachedLikes > 0 || cachedComments > 0 || cachedShares > 0) {
        callback(null, {
          likesCount: cachedLikes,
          commentsCount: cachedComments,
          sharesCount: cachedShares,
        });
        return;
      }

      // Fall back to DB
      const [likesCount, commentsCount, sharesCount] = await Promise.all([
        this.prisma.interaction.count({
          where: { contentId, type: 'LIKE' },
        }),
        this.prisma.interaction.count({
          where: { contentId, type: 'COMMENT' },
        }),
        this.prisma.interaction.count({
          where: { contentId, type: 'SHARE' },
        }),
      ]);

      // Cache the results
      await Promise.all([
        this.redis.setCount('likes', contentId, likesCount),
        this.redis.setCount('comments', contentId, commentsCount),
        this.redis.setCount('shares', contentId, sharesCount),
      ]);

      callback(null, { likesCount, commentsCount, sharesCount });
    } catch (error) {
      this.logger.error(`GetInteractionCounts error: ${error.message}`);
      callback({
        code: grpc.status.INTERNAL,
        message: error.message,
      });
    }
  }

  private async isFollowing(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>,
  ): Promise<void> {
    try {
      const { followerId, followingId } = call.request;

      // Try Redis first
      const cachedResult = await this.redis.isFollowing(
        followerId,
        followingId,
      );
      if (cachedResult) {
        callback(null, { result: true });
        return;
      }

      // Fall back to DB
      const follow = await this.prisma.follow.findUnique({
        where: {
          followerId_followingId: {
            followerId,
            followingId,
          },
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
