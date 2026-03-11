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
        const [counts, isLiked, isBookmarked, isReposted] = await Promise.all([
          this.interactionsService.getInteractionCounts(content.id),
          this.interactionsService.isLiked(userId, content.id),
          this.interactionsService.isBookmarked(userId, content.id),
          this.interactionsService.isReposted(userId, content.id),
        ]);

        return this.buildFeedPost(content, author, counts, isLiked, isBookmarked, isReposted);
      }),
    );

    // Sort by EdgeRank score with 1.5× boost for posts from followed accounts
    const followingIds = await this.followsService.getFollowingIds(userId);
    const followingSet = new Set(followingIds);
    posts.sort(
      (a, b) =>
        this.computeEdgeRankScore(b, followingSet.has(b.authorId)) -
        this.computeEdgeRankScore(a, followingSet.has(a.authorId)),
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
   * GET /api/v1/posts/reels - TikTok-style FYP reels feed.
   *
   * Mixes personalised (from following) + globally trending reels,
   * scored with a completion-weighted EdgeRank.
   */
  async getReelsFeed(
    userId: string,
    cursor: number,
    limit: number,
  ): Promise<{
    posts: FeedPostDto[];
    meta: { nextCursor: number | null; hasMore: boolean };
  }> {
    const REEL_TYPES = new Set(['reel', 'video']);

    // Get personalised feed IDs (larger window so we have enough reels after filtering)
    const { contentIds: feedIds } = await this.redis.getFeedContentIds(
      userId,
      cursor,
      limit * 5,
    );

    let personalIds = feedIds;
    if (personalIds.length === 0 && cursor === 0) {
      const result = await this.buildFeedFromFollowing(userId, 0, limit * 5);
      personalIds = result.contentIds;
    }

    // Trending content IDs by like count over last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const trending = await this.prisma.interaction.groupBy({
      by: ['contentId'],
      where: { type: 'LIKE', createdAt: { gte: sevenDaysAgo } },
      _count: { contentId: true },
      orderBy: { _count: { contentId: 'desc' } },
      take: 50,
    });
    const trendingIds = trending.map((t) => t.contentId);

    // Deduplicate: trending first, then personal
    const seenIds = new Set<string>();
    const candidateIds: string[] = [];
    for (const id of [...trendingIds, ...personalIds]) {
      if (!seenIds.has(id)) {
        seenIds.add(id);
        candidateIds.push(id);
      }
    }

    if (candidateIds.length === 0) {
      return { posts: [], meta: { nextCursor: null, hasMore: false } };
    }

    // Fetch content and filter to reel/video types
    const { contents } = await this.grpcClients.getContentBatch(
      candidateIds.slice(0, limit * 5),
    );
    const reelContents = contents.filter((c) => REEL_TYPES.has(c.content_type));

    if (reelContents.length === 0) {
      return { posts: [], meta: { nextCursor: null, hasMore: false } };
    }

    // Fetch authors and interactions
    const authorIds = [...new Set(reelContents.map((c) => c.author_id))];
    const users = await this.grpcClients.getUsersBatch(authorIds);
    const userMap = new Map(users.map((u) => [u.id, u]));

    const posts = await Promise.all(
      reelContents.map(async (content) => {
        const author = userMap.get(content.author_id);
        const [counts, isLiked, isBookmarked, isReposted] = await Promise.all([
          this.interactionsService.getInteractionCounts(content.id),
          this.interactionsService.isLiked(userId, content.id),
          this.interactionsService.isBookmarked(userId, content.id),
          this.interactionsService.isReposted(userId, content.id),
        ]);
        return this.buildFeedPost(content, author, counts, isLiked, isBookmarked, isReposted);
      }),
    );

    // Score with reels formula + 1.5× boost for posts from followed accounts
    const followingIds = await this.followsService.getFollowingIds(userId);
    const followingSet = new Set(followingIds);
    posts.sort(
      (a, b) =>
        this.computeReelScore(b, followingSet.has(b.authorId)) -
        this.computeReelScore(a, followingSet.has(a.authorId)),
    );

    const page = posts.slice(0, limit);
    const hasMore = posts.length > limit;
    const lastTs = page.length > 0 ? new Date(page[page.length - 1].createdAt).getTime() : null;

    return {
      posts: page,
      meta: { nextCursor: hasMore ? lastTs : null, hasMore },
    };
  }

  /**
   * GET /api/v1/posts/explore - Instagram-style explore grid.
   *
   * Same as getReelsFeed() but includes ALL content types (not just reel/video).
   */
  async getExploreFeed(
    userId: string,
    cursor: number,
    limit: number,
  ): Promise<{ posts: FeedPostDto[]; meta: { nextCursor: number | null; hasMore: boolean } }> {
    // Get personalised feed IDs (larger window)
    const { contentIds: feedIds } = await this.redis.getFeedContentIds(userId, cursor, limit * 5);
    let personalIds = feedIds;
    if (personalIds.length === 0 && cursor === 0) {
      const result = await this.buildFeedFromFollowing(userId, 0, limit * 5);
      personalIds = result.contentIds;
    }

    // Trending IDs by like count over last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const trending = await this.prisma.interaction.groupBy({
      by: ['contentId'],
      where: { type: 'LIKE', createdAt: { gte: sevenDaysAgo } },
      _count: { contentId: true },
      orderBy: { _count: { contentId: 'desc' } },
      take: 50,
    });
    const trendingIds = trending.map((t) => t.contentId);

    // Deduplicate: trending first, then personal
    const seenIds = new Set<string>();
    const candidateIds: string[] = [];
    for (const id of [...trendingIds, ...personalIds]) {
      if (!seenIds.has(id)) {
        seenIds.add(id);
        candidateIds.push(id);
      }
    }

    let contents: Awaited<ReturnType<typeof this.grpcClients.getContentBatch>>['contents'];

    if (candidateIds.length === 0) {
      // Fallback: no follows + no trending likes → list all recent content directly
      const result = await this.grpcClients.listRecentContent('', limit * 5);
      contents = result.contents;
    } else {
      const result = await this.grpcClients.getContentBatch(candidateIds.slice(0, limit * 5));
      contents = result.contents;
    }
    if (contents.length === 0) {
      return { posts: [], meta: { nextCursor: null, hasMore: false } };
    }

    // Fetch authors and interactions
    const authorIds = [...new Set(contents.map((c) => c.author_id))];
    const users = await this.grpcClients.getUsersBatch(authorIds);
    const userMap = new Map(users.map((u) => [u.id, u]));

    const posts = await Promise.all(
      contents.map(async (content) => {
        const author = userMap.get(content.author_id);
        const [counts, isLiked, isBookmarked, isReposted] = await Promise.all([
          this.interactionsService.getInteractionCounts(content.id),
          this.interactionsService.isLiked(userId, content.id),
          this.interactionsService.isBookmarked(userId, content.id),
          this.interactionsService.isReposted(userId, content.id),
        ]);
        return this.buildFeedPost(content, author, counts, isLiked, isBookmarked, isReposted);
      }),
    );

    posts.sort((a, b) => this.computeReelScore(b) - this.computeReelScore(a));

    const page = posts.slice(0, limit);
    const hasMore = posts.length > limit;
    const lastTs = page.length > 0 ? new Date(page[page.length - 1].createdAt).getTime() : null;

    return { posts: page, meta: { nextCursor: hasMore ? lastTs : null, hasMore } };
  }

  /**
   * POST /api/v1/posts/reels/view - Record a reel view event for future FYP signals.
   */
  async recordReelView(
    userId: string,
    contentId: string,
    watchMs: number,
    replays: number,
  ): Promise<void> {
    await this.prisma.reelView.create({
      data: { userId, contentId, watchMs, replays },
    });
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

    const allContents: { id: string; timestamp: number }[] = [];

    // Batch fetch content from followed users (if any)
    if (followingIds.length > 0) {
      const batchSize = 10;
      for (let i = 0; i < followingIds.length; i += batchSize) {
        const batch = followingIds.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map((authorId) =>
            this.grpcClients.getContentByAuthor(authorId, {
              cursor: '',
              limit: 100,
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
    }

    // Always include user's own posts
    const ownContent = await this.grpcClients.getContentByAuthor(userId, {
      cursor: '',
      limit: 100,
    });
    for (const content of ownContent.contents) {
      const timestamp = new Date(content.created_at).getTime();
      allContents.push({ id: content.id, timestamp });
      await this.redis.addToFeed(userId, content.id, timestamp);
    }

    // Fallback: fill with recent posts from non-followed accounts so the feed
    // is never empty and always has content to show beyond the following list.
    const fetchedAuthorIds = new Set([...followingIds, userId]);
    try {
      const exploreResult = await this.grpcClients.listRecentContent('', 100);
      for (const content of exploreResult.contents) {
        if (!fetchedAuthorIds.has(content.author_id)) {
          const timestamp = new Date(content.created_at).getTime();
          allContents.push({ id: content.id, timestamp });
          await this.redis.addToFeed(userId, content.id, timestamp);
        }
      }
    } catch (err) {
      this.logger.warn('listRecentContent fallback failed during feed build', err);
    }

    if (allContents.length === 0) {
      return { contentIds: [], nextCursor: null };
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
      { likesCount: 0, commentsCount: 0, sharesCount: 0, repostsCount: 0 },
      false,
      false,
      false,
    );
  }

  /**
   * GET /api/v1/posts/user/:userId - Get posts by a specific user
   */
  async getUserPosts(
    authorId: string,
    currentUserId: string,
    cursor: string,
    limit: number,
  ): Promise<{
    posts: FeedPostDto[];
    meta: { nextCursor: string | null; hasMore: boolean };
  }> {
    // Fetch content authored by the target user
    const { contents, meta } = await this.grpcClients.getContentByAuthor(
      authorId,
      { cursor, limit },
    );

    if (contents.length === 0) {
      return {
        posts: [],
        meta: { nextCursor: null, hasMore: false },
      };
    }

    // Fetch the author details once (all posts share the same author)
    const author = await this.grpcClients.getUser(authorId);

    // Fetch interaction data for each content
    const posts = await Promise.all(
      contents.map(async (content) => {
        const [counts, isLiked, isBookmarked, isReposted] = await Promise.all([
          this.interactionsService.getInteractionCounts(content.id),
          this.interactionsService.isLiked(currentUserId, content.id),
          this.interactionsService.isBookmarked(currentUserId, content.id),
          this.interactionsService.isReposted(currentUserId, content.id),
        ]);

        return this.buildFeedPost(content, author, counts, isLiked, isBookmarked, isReposted);
      }),
    );

    return {
      posts,
      meta: {
        nextCursor: meta.has_more ? meta.next_cursor : null,
        hasMore: meta.has_more,
      },
    };
  }

  /**
   * Get a single post with author info and interaction counts
   */
  async getPost(postId: string, currentUserId: string): Promise<FeedPostDto> {
    const content = await this.grpcClients.getContent(postId);

    if (!content) {
      throw new NotFoundException('Post not found');
    }

    const [author, counts, isLiked, isBookmarked, isReposted] = await Promise.all([
      this.grpcClients.getUser(content.author_id),
      this.interactionsService.getInteractionCounts(postId),
      this.interactionsService.isLiked(currentUserId, postId),
      this.interactionsService.isBookmarked(currentUserId, postId),
      this.interactionsService.isReposted(currentUserId, postId),
    ]);

    return this.buildFeedPost(content, author, counts, isLiked, isBookmarked, isReposted);
  }

  /**
   * EdgeRank score for home feed.
   * score = (likes×3 + comments×5 + shares×4 + reposts×2) × exp(-0.05 × hours)
   */
  private computeEdgeRankScore(post: FeedPostDto, fromFollowing = false): number {
    const { likesCount, commentsCount, sharesCount, repostsCount } = post.interactions;
    const engagement = likesCount * 3 + commentsCount * 5 + sharesCount * 4 + repostsCount * 2;
    const ageMs = Date.now() - new Date(post.createdAt).getTime();
    const hours = ageMs / (1000 * 60 * 60);
    const boost = fromFollowing ? 1.5 : 1.0;
    return engagement * Math.exp(-0.05 * hours) * boost;
  }

  /**
   * Reels FYP score — higher weight on shares and faster time decay.
   * score = (likes×3 + comments×4 + shares×5 + reposts×3) × exp(-0.08 × hours)
   */
  private computeReelScore(post: FeedPostDto, fromFollowing = false): number {
    const { likesCount, commentsCount, sharesCount, repostsCount } = post.interactions;
    const engagement = likesCount * 3 + commentsCount * 4 + sharesCount * 5 + repostsCount * 3;
    const ageMs = Date.now() - new Date(post.createdAt).getTime();
    const hours = ageMs / (1000 * 60 * 60);
    const boost = fromFollowing ? 1.5 : 1.0;
    return engagement * Math.exp(-0.08 * hours) * boost;
  }

  private buildFeedPost(
    content: any,
    author: any,
    counts: { likesCount: number; commentsCount: number; sharesCount: number; repostsCount: number },
    isLiked: boolean,
    isBookmarked: boolean,
    isReposted: boolean,
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
        repostsCount: counts.repostsCount,
        isLiked,
        isBookmarked,
        isReposted,
      },
    };
  }
}
