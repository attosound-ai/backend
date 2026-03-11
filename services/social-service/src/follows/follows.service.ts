import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GrpcClientsService } from '../grpc/grpc-clients.service';
import { KafkaProducer } from '../kafka/kafka.producer';
import { UserSummaryDto } from './dto/follow.dto';

@Injectable()
export class FollowsService {
  private readonly logger = new Logger(FollowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly grpcClients: GrpcClientsService,
    private readonly kafkaProducer: KafkaProducer,
  ) {}

  async follow(followerId: string, followingId: string): Promise<void> {
    if (followerId === followingId) {
      throw new BadRequestException('Cannot follow yourself');
    }

    // Check if already following
    const existing = await this.prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId,
          followingId,
        },
      },
    });

    if (existing) {
      throw new ConflictException('Already following this user');
    }

    // Create follow in DB
    const follow = await this.prisma.follow.create({
      data: {
        followerId,
        followingId,
      },
    });

    // Update Redis cache (best-effort — DB is source of truth)
    try {
      await this.redis.addFollow(followerId, followingId);
      await this.redis.incrementCount('followers', followingId);
      await this.redis.incrementCount('following', followerId);
    } catch (err) {
      this.logger.warn(`Redis follow cache update failed: ${(err as Error).message}`);
    }

    // Create notification for the followed user
    await this.prisma.notification.create({
      data: {
        recipientId: followingId,
        type: 'follow',
        actorId: followerId,
        referenceId: follow.id,
      },
    });

    // Produce Kafka event
    await this.kafkaProducer.send('follow.created', {
      id: follow.id,
      follower_id: followerId,
      following_id: followingId,
      created_at: follow.createdAt.toISOString(),
    });

    // Produce notification trigger
    await this.kafkaProducer.send('notification.trigger', {
      type: 'follow',
      recipient_id: followingId,
      actor_id: followerId,
      reference_id: follow.id,
    });

    this.logger.log(`User ${followerId} followed ${followingId}`);
  }

  async unfollow(followerId: string, followingId: string): Promise<void> {
    if (followerId === followingId) {
      throw new BadRequestException('Cannot unfollow yourself');
    }

    const existing = await this.prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId,
          followingId,
        },
      },
    });

    if (!existing) {
      throw new NotFoundException('Not following this user');
    }

    await this.prisma.follow.delete({
      where: {
        followerId_followingId: {
          followerId,
          followingId,
        },
      },
    });

    // Update Redis cache (best-effort — DB is source of truth)
    try {
      await this.redis.removeFollow(followerId, followingId);
      await this.redis.decrementCount('followers', followingId);
      await this.redis.decrementCount('following', followerId);
    } catch (err) {
      this.logger.warn(`Redis unfollow cache update failed: ${(err as Error).message}`);
    }

    this.logger.log(`User ${followerId} unfollowed ${followingId}`);
  }

  async getFollowers(
    userId: string,
    page: number,
    limit: number,
    currentUserId?: string,
  ): Promise<{
    users: UserSummaryDto[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const skip = (page - 1) * limit;

    const [follows, total] = await Promise.all([
      this.prisma.follow.findMany({
        where: { followingId: userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: { followerId: true },
      }),
      this.prisma.follow.count({
        where: { followingId: userId },
      }),
    ]);

    const followerIds = follows.map((f) => f.followerId);

    // Fetch user details via gRPC
    const users = await this.enrichUserSummaries(followerIds, currentUserId);

    return {
      users,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getFollowing(
    userId: string,
    page: number,
    limit: number,
    currentUserId?: string,
  ): Promise<{
    users: UserSummaryDto[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const skip = (page - 1) * limit;

    const [follows, total] = await Promise.all([
      this.prisma.follow.findMany({
        where: { followerId: userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: { followingId: true },
      }),
      this.prisma.follow.count({
        where: { followerId: userId },
      }),
    ]);

    const followingIds = follows.map((f) => f.followingId);

    const users = await this.enrichUserSummaries(followingIds, currentUserId);

    return {
      users,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getFollowingIds(userId: string): Promise<string[]> {
    // Try Redis first
    let ids = await this.redis.getFollowingIds(userId);

    if (ids.length === 0) {
      // Fall back to DB and populate cache
      const follows = await this.prisma.follow.findMany({
        where: { followerId: userId },
        select: { followingId: true },
      });
      ids = follows.map((f) => f.followingId);

      // Populate Redis cache
      for (const followingId of ids) {
        await this.redis.addFollow(userId, followingId);
      }
    }

    return ids;
  }

  private async enrichUserSummaries(
    userIds: string[],
    currentUserId?: string,
  ): Promise<UserSummaryDto[]> {
    if (userIds.length === 0) return [];

    // Fetch user details via gRPC
    const grpcUsers = await this.grpcClients.getUsersBatch(userIds);

    // Build a map for quick lookup
    const userMap = new Map<string, any>();
    for (const user of grpcUsers) {
      userMap.set(user.id, user);
    }

    // Check follow status for current user if provided
    let followingSet = new Set<string>();
    if (currentUserId) {
      const followingIds = await this.getFollowingIds(currentUserId);
      followingSet = new Set(followingIds);
    }

    return userIds.map((id) => {
      const user = userMap.get(id);
      if (user) {
        return {
          id: user.id,
          username: user.username,
          displayName: user.display_name || user.username,
          avatar: user.avatar || null,
          bio: user.bio || null,
          isFollowing: currentUserId ? followingSet.has(id) : undefined,
        };
      }
      // Fallback if gRPC failed
      return {
        id,
        username: 'unknown',
        displayName: 'Unknown User',
        avatar: null,
        bio: null,
        isFollowing: currentUserId ? followingSet.has(id) : undefined,
      };
    });
  }
}
