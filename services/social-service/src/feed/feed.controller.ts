import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUserId } from '../common/decorators/current-user.decorator';
import { FeedService } from './feed.service';
import { InteractionsService } from '../interactions/interactions.service';
import { CreatePostDto, ExploreQueryDto, FeedQueryDto, ReelViewDto, ReelsQueryDto, UpdatePostDto, UserPostsQueryDto } from './dto/feed.dto';

@Controller('api/v1/posts')
@UseGuards(AuthGuard)
export class FeedController {
  constructor(
    private readonly feedService: FeedService,
    private readonly interactionsService: InteractionsService,
  ) {}

  @Get('feed')
  async getFeed(
    @CurrentUserId() userId: string,
    @Query() query: FeedQueryDto,
  ) {
    const result = await this.feedService.getFeed(
      userId,
      query.cursor || 0,
      query.limit || 20,
    );
    return {
      success: true,
      data: result.posts,
      error: null,
      meta: {
        nextCursor: result.meta.nextCursor,
        hasMore: result.meta.hasMore,
      },
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createPost(
    @CurrentUserId() userId: string,
    @Body() dto: CreatePostDto,
  ) {
    const post = await this.feedService.createPost(userId, {
      textContent: dto.textContent || '',
      contentType: dto.contentType || 'post',
      filePaths: dto.filePaths || [],
      metadata: dto.metadata || {},
      tags: dto.tags || [],
    });
    return {
      success: true,
      data: post,
      error: null,
    };
  }

  @Put(':id')
  async updatePost(
    @Param('id') postId: string,
    @CurrentUserId() userId: string,
    @Body() dto: UpdatePostDto,
  ) {
    const post = await this.feedService.updatePost(userId, postId, {
      textContent: dto.textContent,
      tags: dto.tags,
    });
    return {
      success: true,
      data: post,
      error: null,
    };
  }

  @Get('user/:userId')
  async getUserPosts(
    @Param('userId') targetUserId: string,
    @CurrentUserId() currentUserId: string,
    @Query() query: UserPostsQueryDto,
  ) {
    const result = await this.feedService.getUserPosts(
      targetUserId,
      currentUserId,
      query.cursor || '',
      query.limit || 20,
    );
    return {
      success: true,
      data: result.posts,
      error: null,
      meta: {
        nextCursor: result.meta.nextCursor,
        hasMore: result.meta.hasMore,
      },
    };
  }

  @Get('reels')
  async getReelsFeed(
    @CurrentUserId() userId: string,
    @Query() query: ReelsQueryDto,
  ) {
    const result = await this.feedService.getReelsFeed(
      userId,
      query.cursor || 0,
      query.limit || 10,
    );
    return {
      success: true,
      data: result.posts,
      error: null,
      meta: {
        nextCursor: result.meta.nextCursor,
        hasMore: result.meta.hasMore,
      },
    };
  }

  @Post('reels/view')
  @HttpCode(HttpStatus.NO_CONTENT)
  async recordReelView(
    @CurrentUserId() userId: string,
    @Body() dto: ReelViewDto,
  ) {
    await this.feedService.recordReelView(
      userId,
      dto.postId,
      dto.watchMs,
      dto.replays ?? 0,
    );
  }

  @Get('explore')
  async getExploreFeed(
    @CurrentUserId() userId: string,
    @Query() query: ExploreQueryDto,
  ) {
    const result = await this.feedService.getExploreFeed(
      userId,
      query.cursor || 0,
      query.limit || 20,
    );
    return {
      success: true,
      data: result.posts,
      error: null,
      meta: { nextCursor: result.meta.nextCursor, hasMore: result.meta.hasMore },
    };
  }

  @Get('ads')
  async getAds() {
    const ads = await this.feedService.getAds();
    return { success: true, data: ads, error: null };
  }

  @Get(':id/interactions/:type')
  async getInteractors(
    @Param('id') contentId: string,
    @Param('type') type: string,
    @Query() query: { page?: number; limit?: number },
  ) {
    const validTypes = ['likes', 'reposts', 'shares'];
    if (!validTypes.includes(type)) {
      return { success: false, data: null, error: { code: 400, message: 'Invalid interaction type' } };
    }
    const result = await this.interactionsService.getInteractors(
      contentId,
      type as 'likes' | 'reposts' | 'shares',
      Number(query.page) || 1,
      Number(query.limit) || 20,
    );
    return { success: true, data: result.users, error: null, meta: { pagination: result.meta } };
  }

  @Get(':id')
  async getPost(
    @Param('id') postId: string,
    @CurrentUserId() userId: string,
  ) {
    const post = await this.feedService.getPost(postId, userId);
    return {
      success: true,
      data: post,
      error: null,
    };
  }
}
