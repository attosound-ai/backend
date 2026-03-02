import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GrpcClientsService } from '../grpc/grpc-clients.service';
import { InteractionsService } from '../interactions/interactions.service';
import { FollowsService } from '../follows/follows.service';
import { FeedPostDto } from './dto/feed.dto';

@Injectable()
export class FeedService {
  private readonly logger = new Logger(FeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly grpcClients: GrpcClientsService,
    private readonly interactionsService: InteractionsService,
    private readonly followsService: FollowsService,
  ) {}

  /**
   * GET /api/v1/posts/feed - The critical feed endpoint
   *
   * 1. Get user's following list from Redis/DB
   * 2. Fetch recent content from followed users via Content gRPC (GetContentBatch)
   * 3. Fetch author details via User gRPC (GetUsersBatch)
   * 4. Merge and return paginated response
   */
  async getFeed(
    userId: string,
    cursor: number,
    limit: number,
  ): Promise<{
    posts: FeedPostDto[];
    meta: { nextCursor: number | null; hasMore: boolean };
  }> {
    // Step 1: Try to get feed from Redis sorted set cache
    const cachedFeed = await this.redis.getFeedContentIds(
      userId,
      cursor,
      limit,
    );

    let contentIds = cachedFeed.contentIds;
    let nextCursor = cachedFeed.nextCursor;

    // If Redis cache is empty, build feed from following list
    if (contentIds.length === 0 && cursor === 0) {
      this.logger.debug(
        `Feed cache empty for user ${userId}, building from following list`,
      );
      const result = await this.buildFeedFromFollowing(userId, cursor, limit);
      contentIds = result.contentIds;
      nextCursor = result.nextCursor;
    }

    if (contentIds.length === 0) {
      return {
        posts: [],
        meta: { nextCursor: null, hasMore: false },
      };
    }

    // Step 2: Fetch content details from Content service via gRPC
    const { contents } = await this.grpcClients.getContentBatch(contentIds);

    if (contents.length === 0) {
      return {
        posts: [],
        meta: { nextCursor: null, hasMore: false },
      };
    }

    // Step 3: Fetch author details via User service gRPC
    const authorIds = [...new Set(contents.map((c) => c.author_id))];
    const users = await this.grpcClients.getUsersBatch(authorIds);
    const userMap = new Map(users.map((u) => [u.id, u]));

    // Step 4: Fetch interaction data for each content
    const posts = await Promise.all(
      contents.map(async (content) => {
        const author = userMap.get(content.author_id);
        const counts = await this.interactionsService.getInteractionCounts(
          content.id,
        );
        const isLiked = await this.interactionsService.isLiked(
          userId,
          content.id,
        );

        return this.buildFeedPost(content, author, counts, isLiked);
      }),
    );

    // Sort by creation time descending
    posts.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return {
      posts,
      meta: {
        nextCursor,
        hasMore: nextCursor !== null,
      },
    };
  }

  /**
   * Build feed from the user's following list when Redis cache is cold
   */
  private async buildFeedFromFollowing(
    userId: string,
    cursor: number,
    limit: number,
  ): Promise<{ contentIds: string[]; nextCursor: number | null }> {
    // Get who the user follows
    const followingIds = await this.followsService.getFollowingIds(userId);

    if (followingIds.length === 0) {
      return { contentIds: [], nextCursor: null };
    }

    // Fetch recent content from all followed users
    const allContents: { id: string; timestamp: number }[] = [];

    // Batch fetch content from followed users
    const batchSize = 10;
    for (let i = 0; i < followingIds.length; i += batchSize) {
      const batch = followingIds.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map((authorId) =>
          this.grpcClients.getContentByAuthor(authorId, {
            cursor: '',
            limit: 20,
          }),
        ),
      );

      for (const result of results) {
        for (const content of result.contents) {
          const timestamp = new Date(content.created_at).getTime();
          allContents.push({ id: content.id, timestamp });
          // Populate the feed cache
          await this.redis.addToFeed(userId, content.id, timestamp);
        }
      }
    }

    // Also include user's own posts
    const ownContent = await this.grpcClients.getContentByAuthor(userId, {
      cursor: '',
      limit: 20,
    });
    for (const content of ownContent.contents) {
      const timestamp = new Date(content.created_at).getTime();
      allContents.push({ id: content.id, timestamp });
      await this.redis.addToFeed(userId, content.id, timestamp);
    }

    // Sort by timestamp descending
    allContents.sort((a, b) => b.timestamp - a.timestamp);

    // Apply cursor-based pagination
    let filtered = allContents;
    if (cursor > 0) {
      filtered = allContents.filter((c) => c.timestamp < cursor);
    }

    const paginated = filtered.slice(0, limit + 1);
    const hasMore = paginated.length > limit;
    if (hasMore) {
      paginated.pop();
    }

    const contentIds = paginated.map((c) => c.id);
    const lastTimestamp = paginated.length > 0
      ? paginated[paginated.length - 1].timestamp
      : null;

    return {
      contentIds,
      nextCursor: hasMore ? lastTimestamp : null,
    };
  }

  /**
   * Create a new post via Content gRPC
   */
  async createPost(
    userId: string,
    data: {
      textContent: string;
      contentType: string;
      filePaths: string[];
      metadata: Record<string, string>;
      tags: string[];
    },
  ): Promise<FeedPostDto> {
    const content = await this.grpcClients.createContent({
      authorId: userId,
      contentType: data.contentType,
      textContent: data.textContent,
      filePaths: data.filePaths,
      metadata: data.metadata,
      tags: data.tags,
    });

    if (!content) {
      throw new Error('Failed to create content');
    }

    // Update posts count in Redis
    await this.redis.incrementCount('posts', userId);

    // Add to author's own feed
    const timestamp = new Date(content.created_at).getTime();
    await this.redis.addToFeed(userId, content.id, timestamp);

    // Fan out to followers' feeds
    const followerIds = await this.redis.getFollowerIds(userId);
    if (followerIds.length > 0) {
      await this.redis.addToFeedBulk(followerIds, content.id, timestamp);
    }

    // Fetch author details
    const author = await this.grpcClients.getUser(userId);

    return this.buildFeedPost(
      content,
      author,
      { likesCount: 0, commentsCount: 0, sharesCount: 0 },
      false,
    );
  }

  /**
   * Get a single post with author info and interaction counts
   */
  async getPost(postId: string, currentUserId: string): Promise<FeedPostDto> {
    const content = await this.grpcClients.getContent(postId);

    if (!content) {
      throw new NotFoundException('Post not found');
    }

    const [author, counts, isLiked] = await Promise.all([
      this.grpcClients.getUser(content.author_id),
      this.interactionsService.getInteractionCounts(postId),
      this.interactionsService.isLiked(currentUserId, postId),
    ]);

    return this.buildFeedPost(content, author, counts, isLiked);
  }

  private buildFeedPost(
    content: any,
    author: any,
    counts: { likesCount: number; commentsCount: number; sharesCount: number },
    isLiked: boolean,
  ): FeedPostDto {
    return {
      id: content.id,
      authorId: content.author_id,
      contentType: content.content_type,
      textContent: content.text_content,
      filePaths: content.file_paths || [],
      metadata: content.metadata || {},
      tags: content.tags || [],
      createdAt: content.created_at,
      updatedAt: content.updated_at || content.created_at,
      author: author
        ? {
            id: author.id,
            username: author.username,
            displayName: author.display_name || author.username,
            avatar: author.avatar || null,
          }
        : {
            id: content.author_id,
            username: 'unknown',
            displayName: 'Unknown User',
            avatar: null,
          },
      interactions: {
        likesCount: counts.likesCount,
        commentsCount: counts.commentsCount,
        sharesCount: counts.sharesCount,
        isLiked,
      },
    };
  }
}
