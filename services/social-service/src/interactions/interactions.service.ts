import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { GrpcClientsService } from "../grpc/grpc-clients.service";
import { KafkaProducer } from "../kafka/kafka.producer";
import { PushService } from "../push/push.service";
import { CommentResponseDto } from "./dto/interaction.dto";

@Injectable()
export class InteractionsService {
  private readonly logger = new Logger(InteractionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly grpcClients: GrpcClientsService,
    private readonly kafkaProducer: KafkaProducer,
    private readonly pushService: PushService,
  ) {}

  /** Fire-and-forget push notification after creating a notification in DB. */
  private firePush(
    recipientId: string,
    type: string,
    actorId: string,
    referenceId: string,
  ): void {
    this.grpcClients.getUser(actorId).then((actor) => {
      this.pushService
        .sendPush(
          recipientId,
          type,
          actorId,
          actor?.username || "Someone",
          referenceId,
        )
        .catch((err) => this.logger.error(`Push failed: ${err.message}`));
    });
  }

  // ── Likes ──

  async like(userId: string, contentId: string): Promise<void> {
    const existing = await this.prisma.interaction.findUnique({
      where: {
        userId_contentId_type: { userId, contentId, type: "LIKE" },
      },
    });

    if (existing) {
      throw new ConflictException("Already liked this content");
    }

    const interaction = await this.prisma.interaction.create({
      data: { userId, contentId, type: "LIKE" },
    });

    await this.redis.incrementCount("likes", contentId);

    const content = await this.grpcClients.getContent(contentId);
    if (content && content.author_id !== userId) {
      await this.prisma.notification.create({
        data: {
          recipientId: content.author_id,
          type: "like",
          actorId: userId,
          referenceId: contentId,
        },
      });

      await this.kafkaProducer.send("notification.trigger", {
        type: "like",
        recipient_id: content.author_id,
        actor_id: userId,
        reference_id: contentId,
      });
      this.firePush(content.author_id, "like", userId, contentId);
    }

    await this.kafkaProducer.send("interaction.created", {
      id: interaction.id,
      user_id: userId,
      content_id: contentId,
      type: "like",
      created_at: interaction.createdAt.toISOString(),
    });

    this.logger.log(`User ${userId} liked content ${contentId}`);
  }

  async unlike(userId: string, contentId: string): Promise<void> {
    const existing = await this.prisma.interaction.findUnique({
      where: {
        userId_contentId_type: { userId, contentId, type: "LIKE" },
      },
    });

    if (!existing) {
      throw new NotFoundException("Like not found");
    }

    await this.prisma.interaction.delete({
      where: {
        userId_contentId_type: { userId, contentId, type: "LIKE" },
      },
    });

    await this.redis.decrementCount("likes", contentId);

    await this.kafkaProducer.send("interaction.removed", {
      user_id: userId,
      content_id: contentId,
      type: "like",
    });

    this.logger.log(`User ${userId} unliked content ${contentId}`);
  }

  async isLiked(userId: string, contentId: string): Promise<boolean> {
    const interaction = await this.prisma.interaction.findUnique({
      where: {
        userId_contentId_type: { userId, contentId, type: "LIKE" },
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
        throw new NotFoundException("Parent comment not found");
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

    await this.redis.incrementCount("comments", contentId);

    const content = await this.grpcClients.getContent(contentId);
    if (content && content.author_id !== userId) {
      await this.prisma.notification.create({
        data: {
          recipientId: content.author_id,
          type: "comment",
          actorId: userId,
          referenceId: contentId,
        },
      });

      await this.kafkaProducer.send("notification.trigger", {
        type: "comment",
        recipient_id: content.author_id,
        actor_id: userId,
        reference_id: contentId,
      });
      this.firePush(content.author_id, "comment", userId, contentId);
    }

    await this.kafkaProducer.send("interaction.created", {
      id: comment.id,
      user_id: userId,
      content_id: contentId,
      type: "comment",
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
        where: { contentId, parentId: null, isDeleted: false },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          replies: {
            where: { isDeleted: false },
            orderBy: { createdAt: "asc" },
            take: 3,
          },
        },
      }),
      this.prisma.comment.count({
        where: { contentId, parentId: null, isDeleted: false },
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
        : {
            id: uid,
            username: "unknown",
            displayName: "Unknown User",
            avatar: null,
          };
    };

    const result: CommentResponseDto[] = comments.map((c) => ({
      id: c.id,
      userId: c.userId,
      contentId: c.contentId,
      comment: c.text,
      parentId: c.parentId,
      createdAt: c.createdAt.toISOString(),
      isEdited: c.isEdited,
      author: mapAuthor(c.userId),
      replies: c.replies.map((r) => ({
        id: r.id,
        userId: r.userId,
        contentId: r.contentId,
        comment: r.text,
        parentId: r.parentId,
        createdAt: r.createdAt.toISOString(),
        isEdited: r.isEdited,
        author: mapAuthor(r.userId),
      })),
    }));

    return {
      comments: result,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async editComment(
    userId: string,
    commentId: string,
    newText: string,
  ): Promise<CommentResponseDto> {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
    });
    if (!comment || comment.isDeleted) {
      throw new NotFoundException("Comment not found");
    }
    if (comment.userId !== userId) {
      throw new ForbiddenException("Cannot edit another user's comment");
    }

    const updated = await this.prisma.comment.update({
      where: { id: commentId },
      data: { text: newText, isEdited: true, editedAt: new Date() },
    });

    await this.kafkaProducer.send("interaction.updated", {
      id: updated.id,
      user_id: userId,
      content_id: updated.contentId,
      type: "comment",
    });

    const author = await this.grpcClients.getUser(userId);

    this.logger.log(`User ${userId} edited comment ${commentId}`);

    return {
      id: updated.id,
      userId: updated.userId,
      contentId: updated.contentId,
      comment: updated.text,
      parentId: updated.parentId,
      createdAt: updated.createdAt.toISOString(),
      isEdited: updated.isEdited,
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

  async deleteComment(userId: string, commentId: string): Promise<void> {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
    });
    if (!comment || comment.isDeleted) {
      throw new NotFoundException("Comment not found");
    }
    if (comment.userId !== userId) {
      throw new ForbiddenException("Cannot delete another user's comment");
    }

    await this.prisma.comment.update({
      where: { id: commentId },
      data: { isDeleted: true, deletedAt: new Date() },
    });

    await this.redis.decrementCount("comments", comment.contentId);

    await this.kafkaProducer.send("interaction.deleted", {
      id: commentId,
      user_id: userId,
      content_id: comment.contentId,
      type: "comment",
    });

    this.logger.log(`User ${userId} deleted comment ${commentId}`);
  }

  // ── Bookmarks ──

  async bookmark(userId: string, contentId: string): Promise<void> {
    const existing = await this.prisma.bookmark.findUnique({
      where: { userId_contentId: { userId, contentId } },
    });
    if (existing) throw new ConflictException("Already bookmarked");

    await this.prisma.bookmark.create({ data: { userId, contentId } });
    this.logger.log(`User ${userId} bookmarked content ${contentId}`);
  }

  async unbookmark(userId: string, contentId: string): Promise<void> {
    const existing = await this.prisma.bookmark.findUnique({
      where: { userId_contentId: { userId, contentId } },
    });
    if (!existing) throw new NotFoundException("Bookmark not found");

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
  ): Promise<{
    contentIds: string[];
    meta: { page: number; total: number; totalPages: number };
  }> {
    const skip = (page - 1) * limit;
    const [bookmarks, total] = await Promise.all([
      this.prisma.bookmark.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
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
    if (existing) throw new ConflictException("Already reposted");

    await this.prisma.repost.create({ data: { userId, contentId } });
    await this.redis.incrementCount("reposts", contentId);

    const content = await this.grpcClients.getContent(contentId);
    if (content && content.author_id !== userId) {
      await this.prisma.notification.create({
        data: {
          recipientId: content.author_id,
          type: "repost",
          actorId: userId,
          referenceId: contentId,
        },
      });
      await this.kafkaProducer.send("notification.trigger", {
        type: "repost",
        recipient_id: content.author_id,
        actor_id: userId,
        reference_id: contentId,
      });
      this.firePush(content.author_id, "repost", userId, contentId);
    }

    this.logger.log(`User ${userId} reposted content ${contentId}`);
  }

  async unrepost(userId: string, contentId: string): Promise<void> {
    const existing = await this.prisma.repost.findUnique({
      where: { userId_contentId: { userId, contentId } },
    });
    if (!existing) throw new NotFoundException("Repost not found");

    await this.prisma.repost.delete({
      where: { userId_contentId: { userId, contentId } },
    });
    await this.redis.decrementCount("reposts", contentId);

    await this.kafkaProducer.send("interaction.removed", {
      user_id: userId,
      content_id: contentId,
      type: "repost",
    });

    this.logger.log(`User ${userId} unreposted content ${contentId}`);
  }

  async isReposted(userId: string, contentId: string): Promise<boolean> {
    const repost = await this.prisma.repost.findUnique({
      where: { userId_contentId: { userId, contentId } },
    });
    return !!repost;
  }

  // ── Shares ──

  async share(userId: string, contentId: string): Promise<void> {
    await this.prisma.interaction.upsert({
      where: {
        userId_contentId_type: { userId, contentId, type: "SHARE" },
      },
      update: {},
      create: { userId, contentId, type: "SHARE" },
    });

    await this.redis.incrementCount("shares", contentId);

    const content = await this.grpcClients.getContent(contentId);
    if (content && content.author_id !== userId) {
      await this.prisma.notification.create({
        data: {
          recipientId: content.author_id,
          type: "share",
          actorId: userId,
          referenceId: contentId,
        },
      });

      await this.kafkaProducer.send("notification.trigger", {
        type: "share",
        recipient_id: content.author_id,
        actor_id: userId,
        reference_id: contentId,
      });
      this.firePush(content.author_id, "share", userId, contentId);
    }

    await this.kafkaProducer.send("interaction.created", {
      user_id: userId,
      content_id: contentId,
      type: "share",
      created_at: new Date().toISOString(),
    });

    this.logger.log(`User ${userId} shared content ${contentId}`);
  }

  // ── Counts ──

  async getInteractionCounts(
    contentId: string,
  ): Promise<{
    likesCount: number;
    commentsCount: number;
    sharesCount: number;
    repostsCount: number;
  }> {
    const [likes, comments, shares, reposts] = await Promise.all([
      this.redis.getCount("likes", contentId),
      this.redis.getCount("comments", contentId),
      this.redis.getCount("shares", contentId),
      this.redis.getCount("reposts", contentId),
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
        this.prisma.interaction.count({ where: { contentId, type: "LIKE" } }),
        this.prisma.comment.count({ where: { contentId } }),
        this.prisma.interaction.count({ where: { contentId, type: "SHARE" } }),
        this.prisma.repost.count({ where: { contentId } }),
      ]);

    await Promise.all([
      this.redis.setCount("likes", contentId, likesCount),
      this.redis.setCount("comments", contentId, commentsCount),
      this.redis.setCount("shares", contentId, sharesCount),
      this.redis.setCount("reposts", contentId, repostsCount),
    ]);

    return { likesCount, commentsCount, sharesCount, repostsCount };
  }

  // ── Batch methods (feed optimization) ──

  /**
   * Batch-fetch interaction counts for multiple content IDs.
   * Uses Redis pipeline (1 roundtrip) with Prisma fallback via GROUP BY (1 query per type).
   * Replaces N×4 individual queries with 1 pipeline + at most 4 queries.
   */
  async getInteractionCountsBatch(
    contentIds: string[],
  ): Promise<Map<string, { likesCount: number; commentsCount: number; sharesCount: number; repostsCount: number }>> {
    const result = new Map<string, { likesCount: number; commentsCount: number; sharesCount: number; repostsCount: number }>();
    if (contentIds.length === 0) return result;

    // Try Redis pipeline first (1 roundtrip for all counts)
    const client = this.redis.getClient();
    const pipeline = client.pipeline();
    for (const id of contentIds) {
      pipeline.get(`social:count:likes:${id}`);
      pipeline.get(`social:count:comments:${id}`);
      pipeline.get(`social:count:shares:${id}`);
      pipeline.get(`social:count:reposts:${id}`);
    }
    const redisResults = await pipeline.exec();

    const missingIds: string[] = [];
    for (let i = 0; i < contentIds.length; i++) {
      const likes = redisResults?.[i * 4]?.[1];
      const comments = redisResults?.[i * 4 + 1]?.[1];
      const shares = redisResults?.[i * 4 + 2]?.[1];
      const reposts = redisResults?.[i * 4 + 3]?.[1];

      if (likes || comments || shares || reposts) {
        result.set(contentIds[i], {
          likesCount: parseInt(likes as string, 10) || 0,
          commentsCount: parseInt(comments as string, 10) || 0,
          sharesCount: parseInt(shares as string, 10) || 0,
          repostsCount: parseInt(reposts as string, 10) || 0,
        });
      } else {
        missingIds.push(contentIds[i]);
      }
    }

    // Fallback: batch DB queries for cache misses (GROUP BY instead of N individual COUNTs)
    if (missingIds.length > 0) {
      const [likeGroups, commentGroups, shareGroups, repostGroups] = await Promise.all([
        this.prisma.interaction.groupBy({
          by: ['contentId'],
          where: { contentId: { in: missingIds }, type: 'LIKE' },
          _count: { contentId: true },
        }),
        this.prisma.comment.groupBy({
          by: ['contentId'],
          where: { contentId: { in: missingIds } },
          _count: { contentId: true },
        }),
        this.prisma.interaction.groupBy({
          by: ['contentId'],
          where: { contentId: { in: missingIds }, type: 'SHARE' },
          _count: { contentId: true },
        }),
        this.prisma.repost.groupBy({
          by: ['contentId'],
          where: { contentId: { in: missingIds } },
          _count: { contentId: true },
        }),
      ]);

      const likeMap = new Map(likeGroups.map((g) => [g.contentId, g._count.contentId]));
      const commentMap = new Map(commentGroups.map((g) => [g.contentId, g._count.contentId]));
      const shareMap = new Map(shareGroups.map((g) => [g.contentId, g._count.contentId]));
      const repostMap = new Map(repostGroups.map((g) => [g.contentId, g._count.contentId]));

      // Cache in Redis and populate result
      const cachePipeline = client.pipeline();
      for (const id of missingIds) {
        const counts = {
          likesCount: likeMap.get(id) || 0,
          commentsCount: commentMap.get(id) || 0,
          sharesCount: shareMap.get(id) || 0,
          repostsCount: repostMap.get(id) || 0,
        };
        result.set(id, counts);
        cachePipeline.set(`social:count:likes:${id}`, counts.likesCount, 'EX', 3600);
        cachePipeline.set(`social:count:comments:${id}`, counts.commentsCount, 'EX', 3600);
        cachePipeline.set(`social:count:shares:${id}`, counts.sharesCount, 'EX', 3600);
        cachePipeline.set(`social:count:reposts:${id}`, counts.repostsCount, 'EX', 3600);
      }
      await cachePipeline.exec();
    }

    // Fill any remaining IDs with zeros
    for (const id of contentIds) {
      if (!result.has(id)) {
        result.set(id, { likesCount: 0, commentsCount: 0, sharesCount: 0, repostsCount: 0 });
      }
    }

    return result;
  }

  /**
   * Batch-check user interactions for multiple content IDs.
   * 3 queries with WHERE IN instead of N×3 individual lookups.
   */
  async getUserInteractionsBatch(
    userId: string,
    contentIds: string[],
  ): Promise<Map<string, { isLiked: boolean; isBookmarked: boolean; isReposted: boolean }>> {
    const result = new Map<string, { isLiked: boolean; isBookmarked: boolean; isReposted: boolean }>();
    if (contentIds.length === 0) return result;

    const [likedRows, bookmarkedRows, repostedRows] = await Promise.all([
      this.prisma.interaction.findMany({
        where: { userId, contentId: { in: contentIds }, type: 'LIKE' },
        select: { contentId: true },
      }),
      this.prisma.bookmark.findMany({
        where: { userId, contentId: { in: contentIds } },
        select: { contentId: true },
      }),
      this.prisma.repost.findMany({
        where: { userId, contentId: { in: contentIds } },
        select: { contentId: true },
      }),
    ]);

    const likedSet = new Set(likedRows.map((r) => r.contentId));
    const bookmarkedSet = new Set(bookmarkedRows.map((r) => r.contentId));
    const repostedSet = new Set(repostedRows.map((r) => r.contentId));

    for (const id of contentIds) {
      result.set(id, {
        isLiked: likedSet.has(id),
        isBookmarked: bookmarkedSet.has(id),
        isReposted: repostedSet.has(id),
      });
    }

    return result;
  }

  async getInteractors(
    contentId: string,
    type: 'likes' | 'reposts' | 'shares',
    page: number,
    limit: number,
  ) {
    const skip = (page - 1) * limit;
    let userIds: string[];
    let total: number;

    if (type === 'reposts') {
      [userIds, total] = await Promise.all([
        this.prisma.repost
          .findMany({ where: { contentId }, skip, take: limit, orderBy: { createdAt: 'desc' }, select: { userId: true } })
          .then((rows) => rows.map((r) => r.userId)),
        this.prisma.repost.count({ where: { contentId } }),
      ]);
    } else {
      const interactionType = type === 'likes' ? 'LIKE' : 'SHARE';
      [userIds, total] = await Promise.all([
        this.prisma.interaction
          .findMany({ where: { contentId, type: interactionType as any }, skip, take: limit, orderBy: { createdAt: 'desc' }, select: { userId: true } })
          .then((rows) => rows.map((r) => r.userId)),
        this.prisma.interaction.count({ where: { contentId, type: interactionType as any } }),
      ]);
    }

    const users = userIds.length > 0
      ? await this.grpcClients.getUsersBatch(userIds)
      : [];

    return {
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name || u.username,
        avatar: u.avatar || null,
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
