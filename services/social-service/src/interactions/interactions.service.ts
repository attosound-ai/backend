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

  // ── Likes ──

  async like(userId: string, contentId: string): Promise<void> {
    const existing = await this.prisma.interaction.findUnique({
      where: {
        userId_contentId_type: { userId, contentId, type: 'LIKE' },
      },
    });

    if (existing) {
      throw new ConflictException('Already liked this content');
    }

    const interaction = await this.prisma.interaction.create({
      data: { userId, contentId, type: 'LIKE' },
    });

    await this.redis.incrementCount('likes', contentId);

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
        userId_contentId_type: { userId, contentId, type: 'LIKE' },
      },
    });

    if (!existing) {
      throw new NotFoundException('Like not found');
    }

    await this.prisma.interaction.delete({
      where: {
        userId_contentId_type: { userId, contentId, type: 'LIKE' },
      },
    });

    await this.redis.decrementCount('likes', contentId);
    this.logger.log(`User ${userId} unliked content ${contentId}`);
  }

  async isLiked(userId: string, contentId: string): Promise<boolean> {
    const interaction = await this.prisma.interaction.findUnique({
      where: {
        userId_contentId_type: { userId, contentId, type: 'LIKE' },
      },
    });
    return !!interaction;
  }

  // ── Comments (new Comment model with threading) ──

  async addComment(
    userId: string,
    contentId: string,
    text: string,
    parentId?: string,
  ): Promise<CommentResponseDto> {
    if (parentId) {
      const parent = await this.prisma.comment.findUnique({
        where: { id: parentId },
      });
      if (!parent || parent.contentId !== contentId) {
        throw new NotFoundException('Parent comment not found');
      }
    }

    const comment = await this.prisma.comment.create({
      data: {
        userId,
        contentId,
        text,
        parentId: parentId || null,
      },
    });

    await this.redis.incrementCount('comments', contentId);

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

    await this.kafkaProducer.send('interaction.created', {
      id: comment.id,
      user_id: userId,
      content_id: contentId,
      type: 'comment',
      comment: text,
      created_at: comment.createdAt.toISOString(),
    });

    const author = await this.grpcClients.getUser(userId);

    this.logger.log(`User ${userId} commented on content ${contentId}`);

    return {
      id: comment.id,
      userId: comment.userId,
      contentId: comment.contentId,
      comment: comment.text,
      parentId: comment.parentId,
      createdAt: comment.createdAt.toISOString(),
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

    const [comments, total] = await Promise.all([
      this.prisma.comment.findMany({
        where: { contentId, parentId: null },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          replies: {
            orderBy: { createdAt: 'asc' },
            take: 3,
          },
        },
      }),
      this.prisma.comment.count({
        where: { contentId, parentId: null },
      }),
    ]);

    const userIds = new Set<string>();
    for (const c of comments) {
      userIds.add(c.userId);
      for (const r of c.replies) {
        userIds.add(r.userId);
      }
    }

    const users = await this.grpcClients.getUsersBatch([...userIds]);
    const userMap = new Map(users.map((u) => [u.id, u]));

    const mapAuthor = (uid: string) => {
      const user = userMap.get(uid);
      return user
        ? {
            id: user.id,
            username: user.username,
            displayName: user.display_name || user.username,
            avatar: user.avatar || null,
          }
        : { id: uid, username: 'unknown', displayName: 'Unknown User', avatar: null };
    };

    const result: CommentResponseDto[] = comments.map((c) => ({
      id: c.id,
      userId: c.userId,
      contentId: c.contentId,
      comment: c.text,
      parentId: c.parentId,
      createdAt: c.createdAt.toISOString(),
      author: mapAuthor(c.userId),
      replies: c.replies.map((r) => ({
        id: r.id,
        userId: r.userId,
        contentId: r.contentId,
        comment: r.text,
        parentId: r.parentId,
        createdAt: r.createdAt.toISOString(),
        author: mapAuthor(r.userId),
      })),
    }));

    return {
      comments: result,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ── Bookmarks ──

  async bookmark(userId: string, contentId: string): Promise<void> {
    const existing = await this.prisma.bookmark.findUnique({
      where: { userId_contentId: { userId, contentId } },
    });
    if (existing) throw new ConflictException('Already bookmarked');

    await this.prisma.bookmark.create({ data: { userId, contentId } });
    this.logger.log(`User ${userId} bookmarked content ${contentId}`);
  }

  async unbookmark(userId: string, contentId: string): Promise<void> {
    const existing = await this.prisma.bookmark.findUnique({
      where: { userId_contentId: { userId, contentId } },
    });
    if (!existing) throw new NotFoundException('Bookmark not found');

    await this.prisma.bookmark.delete({
      where: { userId_contentId: { userId, contentId } },
    });
    this.logger.log(`User ${userId} unbookmarked content ${contentId}`);
  }

  async isBookmarked(userId: string, contentId: string): Promise<boolean> {
    const bookmark = await this.prisma.bookmark.findUnique({
      where: { userId_contentId: { userId, contentId } },
    });
    return !!bookmark;
  }

  async getBookmarks(
    userId: string,
    page: number,
    limit: number,
  ): Promise<{ contentIds: string[]; meta: { page: number; total: number; totalPages: number } }> {
    const skip = (page - 1) * limit;
    const [bookmarks, total] = await Promise.all([
      this.prisma.bookmark.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: { contentId: true },
      }),
      this.prisma.bookmark.count({ where: { userId } }),
    ]);
    return {
      contentIds: bookmarks.map((b) => b.contentId),
      meta: { page, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ── Reposts ──

  async repost(userId: string, contentId: string): Promise<void> {
    const existing = await this.prisma.repost.findUnique({
      where: { userId_contentId: { userId, contentId } },
    });
    if (existing) throw new ConflictException('Already reposted');

    await this.prisma.repost.create({ data: { userId, contentId } });
    await this.redis.incrementCount('reposts', contentId);

    const content = await this.grpcClients.getContent(contentId);
    if (content && content.author_id !== userId) {
      await this.prisma.notification.create({
        data: {
          recipientId: content.author_id,
          type: 'repost',
          actorId: userId,
          referenceId: contentId,
        },
      });
      await this.kafkaProducer.send('notification.trigger', {
        type: 'repost',
        recipient_id: content.author_id,
        actor_id: userId,
        reference_id: contentId,
      });
    }

    this.logger.log(`User ${userId} reposted content ${contentId}`);
  }

  async unrepost(userId: string, contentId: string): Promise<void> {
    const existing = await this.prisma.repost.findUnique({
      where: { userId_contentId: { userId, contentId } },
    });
    if (!existing) throw new NotFoundException('Repost not found');

    await this.prisma.repost.delete({
      where: { userId_contentId: { userId, contentId } },
    });
    await this.redis.decrementCount('reposts', contentId);
    this.logger.log(`User ${userId} unreposted content ${contentId}`);
  }

  async isReposted(userId: string, contentId: string): Promise<boolean> {
    const repost = await this.prisma.repost.findUnique({
      where: { userId_contentId: { userId, contentId } },
    });
    return !!repost;
  }

  // ── Counts ──

  async getInteractionCounts(
    contentId: string,
  ): Promise<{ likesCount: number; commentsCount: number; sharesCount: number; repostsCount: number }> {
    const [likes, comments, shares, reposts] = await Promise.all([
      this.redis.getCount('likes', contentId),
      this.redis.getCount('comments', contentId),
      this.redis.getCount('shares', contentId),
      this.redis.getCount('reposts', contentId),
    ]);

    if (likes > 0 || comments > 0 || shares > 0 || reposts > 0) {
      return {
        likesCount: likes,
        commentsCount: comments,
        sharesCount: shares,
        repostsCount: reposts,
      };
    }

    const [likesCount, commentsCount, sharesCount, repostsCount] =
      await Promise.all([
        this.prisma.interaction.count({ where: { contentId, type: 'LIKE' } }),
        this.prisma.comment.count({ where: { contentId } }),
        this.prisma.interaction.count({ where: { contentId, type: 'SHARE' } }),
        this.prisma.repost.count({ where: { contentId } }),
      ]);

    await Promise.all([
      this.redis.setCount('likes', contentId, likesCount),
      this.redis.setCount('comments', contentId, commentsCount),
      this.redis.setCount('shares', contentId, sharesCount),
      this.redis.setCount('reposts', contentId, repostsCount),
    ]);

    return { likesCount, commentsCount, sharesCount, repostsCount };
  }
}
