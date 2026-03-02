import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUserId } from '../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';
import { NotificationPaginationDto } from './dto/notification.dto';

@Controller('api/v1/notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
  ) {}

  @Get()
  async getNotifications(
    @CurrentUserId() userId: string,
    @Query() query: NotificationPaginationDto,
  ) {
    const result = await this.notificationsService.getNotifications(
      userId,
      query.page || 1,
      query.limit || 20,
    );
    return {
      success: true,
      data: result.notifications,
      error: null,
      meta: { pagination: result.meta },
    };
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  async markAsRead(
    @Param('id') notificationId: string,
    @CurrentUserId() userId: string,
  ) {
    await this.notificationsService.markAsRead(notificationId, userId);
    return {
      success: true,
      data: { message: 'Notification marked as read' },
      error: null,
    };
  }

  @Get('unread-count')
  async getUnreadCount(@CurrentUserId() userId: string) {
    const count = await this.notificationsService.getUnreadCount(userId);
    return {
      success: true,
      data: { count },
      error: null,
    };
  }
}
