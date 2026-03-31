import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "../common/guards/auth.guard";
import { CurrentUserId } from "../common/decorators/current-user.decorator";
import { NotificationsService } from "./notifications.service";
import { NotificationPaginationDto } from "./dto/notification.dto";

@Controller("api/v1/notifications")
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

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

  @Patch("read-all")
  @HttpCode(HttpStatus.OK)
  async markAllRead(@CurrentUserId() userId: string) {
    const count = await this.notificationsService.markAllRead(userId);
    return {
      success: true,
      data: { message: `${count} notifications marked as read` },
      error: null,
    };
  }

  @Patch("read-by-actor")
  @HttpCode(HttpStatus.OK)
  async markReadByActor(
    @CurrentUserId() userId: string,
    @Body() body: { type: string; actorId: string },
  ) {
    const count = await this.notificationsService.markReadByTypeAndActor(
      userId,
      body.type,
      body.actorId,
    );
    return {
      success: true,
      data: { message: `${count} notifications marked as read` },
      error: null,
    };
  }

  @Patch(":id/read")
  @HttpCode(HttpStatus.OK)
  async markAsRead(
    @Param("id") notificationId: string,
    @CurrentUserId() userId: string,
  ) {
    await this.notificationsService.markAsRead(notificationId, userId);
    return {
      success: true,
      data: { message: "Notification marked as read" },
      error: null,
    };
  }

  @Get("unread-count")
  async getUnreadCount(@CurrentUserId() userId: string) {
    const count = await this.notificationsService.getUnreadCount(userId);
    return {
      success: true,
      data: { count },
      error: null,
    };
  }
}
