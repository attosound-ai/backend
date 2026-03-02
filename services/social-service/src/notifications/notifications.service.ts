import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GrpcClientsService } from '../grpc/grpc-clients.service';
import { NotificationResponseDto } from './dto/notification.dto';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly grpcClients: GrpcClientsService,
  ) {}

  async getNotifications(
    userId: string,
    page: number,
    limit: number,
  ): Promise<{
    notifications: NotificationResponseDto[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({
        where: { recipientId: userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.notification.count({
        where: { recipientId: userId },
      }),
    ]);

    // Fetch actor details via gRPC
    const actorIds = [
      ...new Set(
        notifications
          .map((n) => n.actorId)
          .filter((id) => id !== 'system'),
      ),
    ];

    const actors = await this.grpcClients.getUsersBatch(actorIds);
    const actorMap = new Map(actors.map((a) => [a.id, a]));

    const enrichedNotifications: NotificationResponseDto[] =
      notifications.map((notification) => {
        const actor = actorMap.get(notification.actorId);
        return {
          id: notification.id,
          recipientId: notification.recipientId,
          type: notification.type,
          actorId: notification.actorId,
          referenceId: notification.referenceId,
          isRead: notification.isRead,
          createdAt: notification.createdAt.toISOString(),
          actor:
            notification.actorId === 'system'
              ? {
                  id: 'system',
                  username: 'system',
                  displayName: 'Atto Sound',
                  avatar: null,
                }
              : actor
                ? {
                    id: actor.id,
                    username: actor.username,
                    displayName: actor.display_name || actor.username,
                    avatar: actor.avatar || null,
                  }
                : {
                    id: notification.actorId,
                    username: 'unknown',
                    displayName: 'Unknown User',
                    avatar: null,
                  },
        };
      });

    return {
      notifications: enrichedNotifications,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async markAsRead(notificationId: string, userId: string): Promise<void> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    if (notification.recipientId !== userId) {
      throw new ForbiddenException(
        'Cannot mark another user\'s notification as read',
      );
    }

    await this.prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });

    this.logger.debug(`Notification ${notificationId} marked as read`);
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: {
        recipientId: userId,
        isRead: false,
      },
    });
  }
}
