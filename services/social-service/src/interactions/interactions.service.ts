import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GrpcClientsService } from '../grpc/grpc-clients.service';
import { KafkaProducer } from '../kafka/kafka.producer';
import { CommentResponseDto } from './dto/interaction.dto';

@Injectable()
export class InteractionsService {
  private readonly logger = new Logger(InteractionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly grpcClients: GrpcClientsService,
    private readonly kafkaProducer: KafkaProducer,
  ) {}

  async like(userId: string, contentId: string): Promise<void> {
    const existing = await this.prisma.interaction.findUnique({
      where: {
        userId_contentId_type: {
          userId,
          contentId,
          type: 'LIKE',
        },
      },
    });

    if (existing) {
      throw new ConflictException('Already liked this content');
    }

    const interaction = await this.prisma.interaction.create({
      data: {
        userId,
        contentId,
        type: 'LIKE',
      },
    });

    // Update Redis count
    await this.redis.incrementCount('likes', contentId);

    // Get content author for notification
    const content = await this.grpcClients.getContent(contentId);
    if (content && content.author_id !== userId) {
      await this.prisma.notification.create({
        data: {
          recipientId: content.author_id,
          type: 'like',
          actorId: userId,
          referenceId: contentId,
        },
      });

      await this.kafkaProducer.send('notification.trigger', {
        type: 'like',
        recipient_id: content.author_id,
        actor_id: userId,
        reference_id: contentId,
      });
    }

    // Produce interaction event
    await this.kafkaProducer.send('interaction.created', {
      id: interaction.id,
      user_id: userId,
      content_id: contentId,
      type: 'like',
      created_at: interaction.createdAt.toISOString(),
    });

    this.logger.log(`User ${userId} liked content ${contentId}`);
  }

  async unlike(userId: string, contentId: string): Promise<void> {
    const existing = await this.prisma.interaction.findUnique({
      where: {
        userId_contentId_type: {
          userId,
          contentId,
          type: 'LIKE',
        },
      },
    });

    if (!existing) {
      throw new NotFoundException('Like not found');
    }

    await this.prisma.interaction.delete({
      where: {
        userId_contentId_type: {
          userId,
          contentId,
          type: 'LIKE',
        },
      },
    });

    await this.redis.decrementCount('likes', contentId);

    this.logger.log(`User ${userId} unliked content ${contentId}`);
  }

  async addComment(
    userId: string,
    contentId: string,
    comment: string,
  ): Promise<CommentResponseDto> {
    const interaction = await this.prisma.interaction.create({
      data: {
        userId,
        contentId,
        type: 'COMMENT',
        comment,
      },
    });

    // Update Redis count
    await this.redis.incrementCount('comments', contentId);

    // Get content author for notification
    const content = await this.grpcClients.getContent(contentId);
    if (content && content.author_id !== userId) {
      await this.prisma.notification.create({
        data: {
          recipientId: content.author_id,
          type: 'comment',
          actorId: userId,
          referenceId: contentId,
        },
      });

      await this.kafkaProducer.send('notification.trigger', {
        type: 'comment',
        recipient_id: content.author_id,
        actor_id: userId,
        reference_id: contentId,
      });
    }

    // Produce interaction event
    await this.kafkaProducer.send('interaction.created', {
      id: interaction.id,
      user_id: userId,
      content_id: contentId,
      type: 'comment',
      comment,
      created_at: interaction.createdAt.toISOString(),
    });

    // Fetch author details
    const author = await this.grpcClients.getUser(userId);

    this.logger.log(`User ${userId} commented on content ${contentId}`);

    return {
      id: interaction.id,
      userId: interaction.userId,
      contentId: interaction.contentId,
      comment: interaction.comment || '',
      createdAt: interaction.createdAt.toISOString(),
      author: author
        ? {
            id: author.id,
            username: author.username,
            displayName: author.display_name || author.username,
            avatar: author.avatar || null,
          }
        : undefined,
    };
  }

  async getComments(
    contentId: string,
    page: number,
    limit: number,
  ): Promise<{
    comments: CommentResponseDto[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const skip = (page - 1) * limit;

    const [interactions, total] = await Promise.all([
      this.prisma.interaction.findMany({
        where: { contentId, type: 'COMMENT' },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.interaction.count({
        where: { contentId, type: 'COMMENT' },
      }),
    ]);

    // Fetch user details for all commenters
    const userIds = [...new Set(interactions.map((i) => i.userId))];
    const users = await this.grpcClients.getUsersBatch(userIds);
    const userMap = new Map(users.map((u) => [u.id, u]));

    const comments: CommentResponseDto[] = interactions.map((interaction) => {
      const user = userMap.get(interaction.userId);
      return {
        id: interaction.id,
        userId: interaction.userId,
        contentId: interaction.contentId,
        comment: interaction.comment || '',
        createdAt: interaction.createdAt.toISOString(),
        author: user
          ? {
              id: user.id,
              username: user.username,
              displayName: user.display_name || user.username,
              avatar: user.avatar || null,
            }
          : {
              id: interaction.userId,
              username: 'unknown',
              displayName: 'Unknown User',
              avatar: null,
            },
      };
    });

    return {
      comments,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getInteractionCounts(
    contentId: string,
  ): Promise<{ likesCount: number; commentsCount: number; sharesCount: number }> {
    // Try Redis first
    const [likes, comments, shares] = await Promise.all([
      this.redis.getCount('likes', contentId),
      this.redis.getCount('comments', contentId),
      this.redis.getCount('shares', contentId),
    ]);

    if (likes > 0 || comments > 0 || shares > 0) {
      return {
        likesCount: likes,
        commentsCount: comments,
        sharesCount: shares,
      };
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

    return { likesCount, commentsCount, sharesCount };
  }

  async isLiked(userId: string, contentId: string): Promise<boolean> {
    const interaction = await this.prisma.interaction.findUnique({
      where: {
        userId_contentId_type: {
          userId,
          contentId,
          type: 'LIKE',
        },
      },
    });
    return !!interaction;
  }
}
