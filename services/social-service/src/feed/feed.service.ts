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
    const t0 = Date.now();

    // Step 1: First page (cursor=0) always rebuilds to catch new content.
    // Subsequent pages use Redis cache for pagination performance.
    let contentIds: string[] = [];
    let nextCursor: number | null = null;
    let cacheHit = false;

    if (cursor > 0) {
      const cached = await this.redis.getFeedContentIds(userId, cursor, limit);
      if (cached.contentIds.length > 0) {
        contentIds = cached.contentIds;
        nextCursor = cached.nextCursor;
        cacheHit = true;
      }
    }

    if (!cacheHit) {
      const result = await this.buildFeedFromFollowing(userId, cursor, limit);
      contentIds = result.contentIds;
      nextCursor = result.nextCursor;
    }

    const t1 = Date.now();
    this.logger.log(`[PERF] Step 1 feed IDs: ${t1 - t0}ms (${contentIds.length} IDs, cache=${cacheHit})`);

    if (contentIds.length === 0) {
      return {
        posts: [],
        meta: { nextCursor: null, hasMore: false },
      };
    }

    // Step 2+3: Fetch content + authors in parallel
    const { contents } = await this.grpcClients.getContentBatch(contentIds);
    const t2 = Date.now();
    this.logger.log(`[PERF] Step 2 getContentBatch gRPC: ${t2 - t1}ms (${contents.length} contents)`);

    if (contents.length === 0) {
      return {
        posts: [],
        meta: { nextCursor: null, hasMore: false },
      };
    }

    const postIds = contents.map((c) => c.id);
    const authorIds = [...new Set(contents.map((c) => c.author_id))];

    // Step 3+4: Fetch authors, counts, and user interactions ALL in parallel
    const [users, countsMap, userInteractionsMap, followingIds] = await Promise.all([
      this.grpcClients.getUsersBatch(authorIds),
      this.interactionsService.getInteractionCountsBatch(postIds),
      this.interactionsService.getUserInteractionsBatch(userId, postIds),
      this.followsService.getFollowingIds(userId),
    ]);
    const t3 = Date.now();
    this.logger.log(`[PERF] Step 3+4 authors+interactions+follows (parallel): ${t3 - t2}ms | TOTAL: ${t3 - t0}ms`);

    const userMap = new Map(users.map((u) => [u.id, u]));

    // Build posts from pre-fetched data (zero DB queries here)
    const defaultCounts = { likesCount: 0, commentsCount: 0, sharesCount: 0, repostsCount: 0 };
    const defaultInteractions = { isLiked: false, isBookmarked: false, isReposted: false };
    const posts = contents.map((content) => {
      const author = userMap.get(content.author_id);
      const counts = countsMap.get(content.id) || defaultCounts;
      const ui = userInteractionsMap.get(content.id) || defaultInteractions;
      return this.buildFeedPost(content, author, counts, ui.isLiked, ui.isBookmarked, ui.isReposted);
    });
    const followingSet = new Set(followingIds);
    const viewerId = String(userId);
    posts.sort(
      (a, b) =>
        this.computeEdgeRankScore(b, followingSet.has(b.authorId), String(b.authorId) === viewerId) -
        this.computeEdgeRankScore(a, followingSet.has(a.authorId), String(a.authorId) === viewerId),
    );

    // Tag each post with whether the viewer follows the author
    // followingIds may be numbers while authorId is a string — normalize both
    const followingStrSet = new Set(followingIds.map(String));
    for (const post of posts) {
      post.isFollowingAuthor = followingStrSet.has(String(post.authorId)) || String(post.authorId) === String(userId);
    }

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
    let personalIds: string[] = [];
    try {
      const { contentIds: feedIds } = await this.redis.getFeedContentIds(userId, cursor, limit * 5);
      personalIds = feedIds;
    } catch (err) {
      this.logger.warn(`Redis reels feed read failed, using empty list: ${(err as Error).message}`);
    }
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

    // Batch resolve authors + interactions + follows in parallel
    const posts = await this.resolvePostsBatch(reelContents, userId);

    // Score with reels formula
    const followingSet = new Set(posts.filter((p) => p.isFollowingAuthor).map((p) => p.authorId));
    const reelsViewerId = String(userId);
    posts.sort(
      (a, b) =>
        this.computeReelScore(b, followingSet.has(b.authorId), String(b.authorId) === reelsViewerId) -
        this.computeReelScore(a, followingSet.has(a.authorId), String(a.authorId) === reelsViewerId),
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

    // Batch resolve authors + interactions + follows in parallel
    const posts = await this.resolvePostsBatch(contents, userId);

    const trendingViewerId = String(userId);
    posts.sort((a, b) =>
      this.computeReelScore(b, false, String(b.authorId) === trendingViewerId) -
      this.computeReelScore(a, false, String(a.authorId) === trendingViewerId),
    );

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
   * Build feed from the user's following list when Redis cache is cold.
   *
   * Optimized: single listRecentContent call + parallel getContentByAuthor
   * for own posts. Avoids N sequential gRPC calls per followed user.
   */
  private async buildFeedFromFollowing(
    userId: string,
    cursor: number,
    limit: number,
  ): Promise<{ contentIds: string[]; nextCursor: number | null }> {
    // Fetch ALL recent content in one gRPC call + own posts in parallel
    const [allRecent, ownContent, followingIds] = await Promise.all([
      this.grpcClients.listRecentContent('', limit * 5),
      this.grpcClients.getContentByAuthor(userId, { cursor: '', limit: 50 }),
      this.followsService.getFollowingIds(userId),
    ]);

    const followingSet = new Set(followingIds.map(String));
    const allContents: { id: string; timestamp: number }[] = [];
    const seenIds = new Set<string>();

    // Add own posts
    for (const content of ownContent.contents) {
      if (!seenIds.has(content.id)) {
        seenIds.add(content.id);
        const timestamp = new Date(content.created_at).getTime();
        allContents.push({ id: content.id, timestamp });
      }
    }

    // Add recent content (following + explore), prioritizing followed users
    for (const content of allRecent.contents) {
      if (!seenIds.has(content.id)) {
        seenIds.add(content.id);
        const timestamp = new Date(content.created_at).getTime();
        allContents.push({ id: content.id, timestamp });
      }
    }

    // Cache in Redis for subsequent requests (fire-and-forget)
    if (allContents.length > 0) {
      const cacheEntries = allContents.map((c) => ({ id: c.id, timestamp: c.timestamp }));
      Promise.resolve().then(async () => {
        try {
          const client = this.redis.getClient();
          const pipeline = client.pipeline();
          const feedKey = `social:feed:${userId}`;
          for (const entry of cacheEntries) {
            pipeline.zadd(feedKey, entry.timestamp, entry.id);
          }
          pipeline.zremrangebyrank(feedKey, 0, -501);
          await pipeline.exec();
        } catch { /* ignore cache errors */ }
      });
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
   * PUT /api/v1/posts/:id - Update a post (text/tags only, no media swap)
   */
  async updatePost(
    userId: string,
    postId: string,
    data: { textContent?: string; tags?: string[] },
  ): Promise<FeedPostDto> {
    const updated = await this.grpcClients.updateContent({
      contentId: postId,
      authorId: userId,
      textContent: data.textContent,
      tags: data.tags,
    });

    if (!updated) {
      throw new NotFoundException('Post not found or not the author');
    }

    const [post] = await this.resolvePostsBatch([updated], userId);
    return post;
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
    meta: { nextCursor: string | null; hasMore: boolean; total?: number };
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

    // Batch resolve author + interactions + follows in parallel
    const posts = await this.resolvePostsBatch(contents, currentUserId);

    return {
      posts,
      meta: {
        nextCursor: meta.has_more ? meta.next_cursor : null,
        hasMore: meta.has_more,
        total: meta.total ?? posts.length,
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

    const [post] = await this.resolvePostsBatch([content], currentUserId);
    return post;
  }

  /**
   * Three-pillar feed ranking inspired by Instagram/X/TikTok/LinkedIn.
   *
   * Score = Engagement + Recency + Relationship + SelfBoost
   *
   * ── Engagement (weighted like X's open-source algo) ──
   *   shares×20 + comments×13 + reposts×10 + likes×1
   *   Weighted by time decay: × exp(-0.05 × hours)
   *   Shares/reposts >> likes (X, TikTok, Instagram all confirm this)
   *
   * ── Recency (Instagram timeliness pillar) ──
   *   5 × exp(-0.015 × hours)
   *   Fresh posts start at ~5, half-life ~46 hours (2 days)
   *   Ensures new posts always surface even with 0 engagement
   *
   * ── Relationship (Instagram/LinkedIn relationship pillar) ──
   *   +3.0 if viewer follows the author
   *   Decays with time: × exp(-0.01 × hours)
   *   Following someone means their content stays relevant longer
   *
   * ── Self-boost (own post visibility) ──
   *   +50 for own posts < 10 min (see your post immediately)
   *   Rapid decay so it sinks to natural position quickly
   */
  private computeEdgeRankScore(post: FeedPostDto, fromFollowing = false, isOwnPost = false): number {
    const { likesCount, commentsCount, sharesCount, repostsCount } = post.interactions;
    const ageMs = Date.now() - new Date(post.createdAt).getTime();
    const hours = ageMs / (1000 * 60 * 60);
    const minutes = ageMs / (1000 * 60);

    // Pillar 1: Engagement (X-style weights with time decay)
    const rawEngagement = sharesCount * 20 + commentsCount * 13 + repostsCount * 10 + likesCount * 1;
    const engagement = rawEngagement * Math.exp(-0.05 * hours);

    // Pillar 2: Recency (always-on base score)
    const recency = 5 * Math.exp(-0.015 * hours);

    // Pillar 3: Relationship
    const relationship = fromFollowing ? 3.0 * Math.exp(-0.01 * hours) : 0;

    // Self-boost: own posts < 10 min
    const selfBoost = isOwnPost && minutes < 10 ? 50 * Math.exp(-0.3 * minutes) : 0;

    return engagement + recency + relationship + selfBoost;
  }

  /**
   * Reels FYP score — shares/completion matter most (TikTok model).
   *
   * Same 3-pillar approach but with:
   * - Higher share weight (shares×30, TikTok values sends above all)
   * - Faster time decay (-0.08, reels cycle faster than feed posts)
   * - Faster recency decay (half-life ~24h vs 48h for feed)
   */
  private computeReelScore(post: FeedPostDto, fromFollowing = false, isOwnPost = false): number {
    const { likesCount, commentsCount, sharesCount, repostsCount } = post.interactions;
    const ageMs = Date.now() - new Date(post.createdAt).getTime();
    const hours = ageMs / (1000 * 60 * 60);
    const minutes = ageMs / (1000 * 60);

    // Pillar 1: Engagement (TikTok-style — shares dominate)
    const rawEngagement = sharesCount * 30 + commentsCount * 10 + repostsCount * 8 + likesCount * 1;
    const engagement = rawEngagement * Math.exp(-0.08 * hours);

    // Pillar 2: Recency (faster decay for reels)
    const recency = 5 * Math.exp(-0.03 * hours);

    // Pillar 3: Relationship
    const relationship = fromFollowing ? 2.0 * Math.exp(-0.02 * hours) : 0;

    // Self-boost
    const selfBoost = isOwnPost && minutes < 10 ? 50 * Math.exp(-0.3 * minutes) : 0;

    return engagement + recency + relationship + selfBoost;
  }

  /**
   * Shared helper: given fetched contents and a viewer, resolves authors,
   * interaction counts, and user interactions in batch (parallel).
   * Eliminates the N+1 pattern across all feed endpoints.
   */
  private async resolvePostsBatch(
    contents: any[],
    viewerId: string,
  ): Promise<FeedPostDto[]> {
    if (contents.length === 0) return [];

    const postIds = contents.map((c) => c.id);
    const authorIds = [...new Set(contents.map((c) => c.author_id))];

    const [users, countsMap, userInteractionsMap, followingIds] = await Promise.all([
      this.grpcClients.getUsersBatch(authorIds),
      this.interactionsService.getInteractionCountsBatch(postIds),
      this.interactionsService.getUserInteractionsBatch(viewerId, postIds),
      this.followsService.getFollowingIds(viewerId),
    ]);

    const userMap = new Map(users.map((u) => [u.id, u]));
    const followingStrSet = new Set(followingIds.map(String));
    const defaultCounts = { likesCount: 0, commentsCount: 0, sharesCount: 0, repostsCount: 0 };
    const defaultUi = { isLiked: false, isBookmarked: false, isReposted: false };

    return contents.map((content) => {
      const author = userMap.get(content.author_id);
      const counts = countsMap.get(content.id) || defaultCounts;
      const ui = userInteractionsMap.get(content.id) || defaultUi;
      const post = this.buildFeedPost(content, author, counts, ui.isLiked, ui.isBookmarked, ui.isReposted);
      post.isFollowingAuthor = followingStrSet.has(String(post.authorId)) || String(post.authorId) === String(viewerId);
      return post;
    });
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
            role: author.role || null,
          }
        : {
            id: content.author_id,
            username: 'unknown',
            displayName: 'Unknown User',
            avatar: null,
            role: null,
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
