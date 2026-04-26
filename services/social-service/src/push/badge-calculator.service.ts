import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Counts unread items that should be reflected on the app icon badge.
 *
 * Source of truth: the `notifications` table — every push-worthy event
 * (likes, follows, comments, reposts, messages) is materialized as a
 * Notification row. Counting unread rows gives a single, consistent
 * total for the iOS/Android app icon badge.
 *
 * Single Responsibility: only computes counts. Has no opinion on how the
 * count is delivered to the device.
 */
@Injectable()
export class BadgeCalculator {
  private readonly logger = new Logger(BadgeCalculator.name);

  constructor(private readonly prisma: PrismaService) {}

  async getUnreadCount(recipientId: string): Promise<number> {
    try {
      return await this.prisma.notification.count({
        where: { recipientId, isRead: false },
      });
    } catch (err) {
      // Never let a count failure block a push from going out — better to
      // ship the push without a badge than to swallow it entirely.
      this.logger.warn(
        `Failed to count unread notifications for ${recipientId}: ${(err as Error).message}`,
      );
      return 0;
    }
  }

  async getUnreadCountsBatch(
    recipientIds: string[],
  ): Promise<Map<string, number>> {
    if (recipientIds.length === 0) return new Map();
    try {
      const rows = await this.prisma.notification.groupBy({
        by: ["recipientId"],
        where: { recipientId: { in: recipientIds }, isRead: false },
        _count: { _all: true },
      });
      const map = new Map<string, number>();
      for (const id of recipientIds) map.set(id, 0);
      for (const r of rows) map.set(r.recipientId, r._count._all);
      return map;
    } catch (err) {
      this.logger.warn(
        `Failed batch unread count: ${(err as Error).message}`,
      );
      return new Map(recipientIds.map((id) => [id, 0]));
    }
  }
}
