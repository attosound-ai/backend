import {
  Body,
  Controller,
  Delete,
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
import { InteractionsService } from './interactions.service';
import { CreateCommentDto, InteractionPaginationDto } from './dto/interaction.dto';

@Controller('api/v1/posts')
@UseGuards(AuthGuard)
export class InteractionsController {
  constructor(private readonly interactionsService: InteractionsService) {}

  // ── Likes ──

  @Post(':id/like')
  @HttpCode(HttpStatus.OK)
  async like(
    @Param('id') contentId: string,
    @CurrentUserId() userId: string,
  ) {
    await this.interactionsService.like(userId, contentId);
    return {
      success: true,
      data: { message: 'Content liked successfully' },
      error: null,
    };
  }

  @Delete(':id/like')
  @HttpCode(HttpStatus.OK)
  async unlike(
    @Param('id') contentId: string,
    @CurrentUserId() userId: string,
  ) {
    await this.interactionsService.unlike(userId, contentId);
    return {
      success: true,
      data: { message: 'Content unliked successfully' },
      error: null,
    };
  }

  // ── Comments ──

  @Post(':id/comments')
  @HttpCode(HttpStatus.CREATED)
  async addComment(
    @Param('id') contentId: string,
    @CurrentUserId() userId: string,
    @Body() dto: CreateCommentDto,
  ) {
    const comment = await this.interactionsService.addComment(
      userId,
      contentId,
      dto.comment,
      dto.parentId,
    );
    return {
      success: true,
      data: comment,
      error: null,
    };
  }

  @Get(':id/comments')
  async getComments(
    @Param('id') contentId: string,
    @Query() query: InteractionPaginationDto,
  ) {
    const result = await this.interactionsService.getComments(
      contentId,
      query.page || 1,
      query.limit || 20,
    );
    return {
      success: true,
      data: result.comments,
      error: null,
      meta: { pagination: result.meta },
    };
  }

  // ── Bookmarks ──

  @Post(':id/bookmark')
  @HttpCode(HttpStatus.OK)
  async bookmark(
    @Param('id') contentId: string,
    @CurrentUserId() userId: string,
  ) {
    await this.interactionsService.bookmark(userId, contentId);
    return {
      success: true,
      data: { message: 'Content bookmarked successfully' },
      error: null,
    };
  }

  @Delete(':id/bookmark')
  @HttpCode(HttpStatus.OK)
  async unbookmark(
    @Param('id') contentId: string,
    @CurrentUserId() userId: string,
  ) {
    await this.interactionsService.unbookmark(userId, contentId);
    return {
      success: true,
      data: { message: 'Bookmark removed successfully' },
      error: null,
    };
  }

  @Get('bookmarks')
  async getBookmarks(
    @CurrentUserId() userId: string,
    @Query() query: InteractionPaginationDto,
  ) {
    const result = await this.interactionsService.getBookmarks(
      userId,
      query.page || 1,
      query.limit || 20,
    );
    return {
      success: true,
      data: result.contentIds,
      error: null,
      meta: { pagination: result.meta },
    };
  }

  // ── Reposts ──

  @Post(':id/repost')
  @HttpCode(HttpStatus.OK)
  async repost(
    @Param('id') contentId: string,
    @CurrentUserId() userId: string,
  ) {
    await this.interactionsService.repost(userId, contentId);
    return {
      success: true,
      data: { message: 'Content reposted successfully' },
      error: null,
    };
  }

  @Delete(':id/repost')
  @HttpCode(HttpStatus.OK)
  async unrepost(
    @Param('id') contentId: string,
    @CurrentUserId() userId: string,
  ) {
    await this.interactionsService.unrepost(userId, contentId);
    return {
      success: true,
      data: { message: 'Repost removed successfully' },
      error: null,
    };
  }
}
