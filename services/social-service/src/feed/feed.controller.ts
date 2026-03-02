import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUserId } from '../common/decorators/current-user.decorator';
import { FeedService } from './feed.service';
import { CreatePostDto, FeedQueryDto } from './dto/feed.dto';

@Controller('api/v1/posts')
@UseGuards(AuthGuard)
export class FeedController {
  constructor(private readonly feedService: FeedService) {}

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
      textContent: dto.textContent,
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
