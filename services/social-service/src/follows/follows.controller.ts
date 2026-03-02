import {
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
import { FollowsService } from './follows.service';
import { PaginationQueryDto } from './dto/follow.dto';

@Controller('api/v1/users')
@UseGuards(AuthGuard)
export class FollowsController {
  constructor(private readonly followsService: FollowsService) {}

  @Post(':id/follow')
  @HttpCode(HttpStatus.OK)
  async follow(
    @Param('id') followingId: string,
    @CurrentUserId() userId: string,
  ) {
    await this.followsService.follow(userId, followingId);
    return {
      success: true,
      data: { message: 'Successfully followed user' },
      error: null,
    };
  }

  @Delete(':id/follow')
  @HttpCode(HttpStatus.OK)
  async unfollow(
    @Param('id') followingId: string,
    @CurrentUserId() userId: string,
  ) {
    await this.followsService.unfollow(userId, followingId);
    return {
      success: true,
      data: { message: 'Successfully unfollowed user' },
      error: null,
    };
  }

  @Get(':id/followers')
  async getFollowers(
    @Param('id') userId: string,
    @Query() query: PaginationQueryDto,
    @CurrentUserId() currentUserId: string,
  ) {
    const result = await this.followsService.getFollowers(
      userId,
      query.page || 1,
      query.limit || 20,
      currentUserId,
    );
    return {
      success: true,
      data: result.users,
      error: null,
      meta: { pagination: result.meta },
    };
  }

  @Get(':id/following')
  async getFollowing(
    @Param('id') userId: string,
    @Query() query: PaginationQueryDto,
    @CurrentUserId() currentUserId: string,
  ) {
    const result = await this.followsService.getFollowing(
      userId,
      query.page || 1,
      query.limit || 20,
      currentUserId,
    );
    return {
      success: true,
      data: result.users,
      error: null,
      meta: { pagination: result.meta },
    };
  }
}
