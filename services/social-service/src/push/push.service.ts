import { Injectable, Logger } from "@nestjs/common";
import Expo, {
  ExpoPushMessage,
  ExpoPushTicket,
  ExpoPushSuccessTicket,
} from "expo-server-sdk";
import { GrpcClientsService } from "../grpc/grpc-clients.service";

const PUSH_BODY: Record<string, (actor: string) => string> = {
  follow: (a) => `${a} followed you`,
  like: (a) => `${a} liked your post`,
  comment: (a) => `${a} commented on your post`,
  repost: (a) => `${a} reposted your post`,
  share: (a) => `${a} shared your post`,
  message: (a) => `${a} sent you a message`,
};

type DeepLinkFn = (
  referenceId: string | null,
  actorId: string,
  actorDisplayName?: string,
) => string | null;

const DEEP_LINK: Record<string, DeepLinkFn> = {
  follow: (_ref, actorId) => `/user/${actorId}`,
  like: (ref) => (ref ? `/post/${ref}` : null),
  comment: (ref) => (ref ? `/post/${ref}` : null),
  repost: (ref) => (ref ? `/post/${ref}` : null),
  share: (ref) => (ref ? `/post/${ref}` : null),
  message: (ref, actorId, actorName) => {
    if (!ref) return null;
    const params = new URLSearchParams({
      conversationId: ref,
      participantId: actorId,
      participantName: actorName || "",
    });
    return `/chat?${params.toString()}`;
  },
};

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly expo = new Expo();

  constructor(private readonly grpcClients: GrpcClientsService) {}

  /**
   * Send a push notification to a recipient. Fire-and-forget — never throws.
   * Skips message and welcome types (messages use WebSocket banner).
   */
  async sendPush(
    recipientId: string,
    type: string,
    actorId: string,
    actorDisplayName: string,
    referenceId?: string | null,
    customBody?: string,
  ): Promise<void> {
    try {
      if (type === "welcome") return;

      const bodyFn = PUSH_BODY[type];
      if (!bodyFn) return;

      const [tokens, recipient] = await Promise.all([
        this.grpcClients.getPushTokens(recipientId),
        this.grpcClients.getUser(recipientId),
      ]);
      if (!tokens || tokens.length === 0) return;

      const recipientUsername = recipient?.username;
      const body = customBody || bodyFn(actorDisplayName);
      const url = DEEP_LINK[type]?.(referenceId ?? null, actorId, actorDisplayName);

      const messages: ExpoPushMessage[] = tokens
        .filter((t) => Expo.isExpoPushToken(t.token))
        .map((t) => ({
          to: t.token,
          title: "ATTO SOUND",
          body,
          data: {
            ...(url ? { url } : {}),
            account_id: recipientId,
            account_username: recipientUsername || undefined,
          },
          sound: "default" as const,
          priority: "high" as const,
          channelId: "default",
        }));

      if (messages.length === 0) return;

      const chunks = this.expo.chunkPushNotifications(messages);
      const ticketIds: string[] = [];

      for (const chunk of chunks) {
        const tickets: ExpoPushTicket[] =
          await this.expo.sendPushNotificationsAsync(chunk);
        for (const ticket of tickets) {
          if (ticket.status === "ok") {
            ticketIds.push((ticket as ExpoPushSuccessTicket).id);
          } else if (
            ticket.status === "error" &&
            ticket.details?.error === "DeviceNotRegistered"
          ) {
            // Token invalid — deactivate it
            const failedToken = (chunk[0] as { to: string }).to;
            this.logger.warn(
              `DeviceNotRegistered for token ${failedToken}, should deactivate`,
            );
          }
        }
      }

      this.logger.debug(
        `Push sent to ${messages.length} device(s) for ${type} notification to user ${recipientId}`,
      );

      // Check receipts after 15 minutes (fire-and-forget)
      if (ticketIds.length > 0) {
        setTimeout(() => this.checkReceipts(ticketIds), 15 * 60 * 1000);
      }
    } catch (error) {
      this.logger.error(`Push notification failed: ${error.message}`);
    }
  }

  private async checkReceipts(ticketIds: string[]): Promise<void> {
    try {
      const chunks = this.expo.chunkPushNotificationReceiptIds(ticketIds);
      for (const chunk of chunks) {
        const receipts =
          await this.expo.getPushNotificationReceiptsAsync(chunk);
        for (const [, receipt] of Object.entries(receipts)) {
          if (
            receipt.status === "error" &&
            receipt.details?.error === "DeviceNotRegistered"
          ) {
            this.logger.warn(
              "DeviceNotRegistered in receipt — token should be deactivated",
            );
          }
        }
      }
    } catch (error) {
      this.logger.error(`Receipt check failed: ${error.message}`);
    }
  }
}
