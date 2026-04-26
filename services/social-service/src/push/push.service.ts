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
  new_post: (a) => `${a} just posted`,
};

type DeepLinkFn = (
  referenceId: string | null,
  actorId: string,
  actorUsername?: string,
) => string | null;

const DEEP_LINK: Record<string, DeepLinkFn> = {
  follow: (_ref, actorId) => `/user/${actorId}`,
  like: (ref) => (ref ? `/post/${ref}` : null),
  comment: (ref) => (ref ? `/post/${ref}` : null),
  repost: (ref) => (ref ? `/post/${ref}` : null),
  share: (ref) => (ref ? `/post/${ref}` : null),
  message: (ref, actorId, actorUsername) => {
    if (!ref) return null;
    // `participantName` here is the @username — the front uses this URL
    // param as the chat header label. Renaming the key would require a
    // coordinated frontend change (see chat.tsx / messages.tsx).
    const params = new URLSearchParams({
      conversationId: ref,
      participantId: actorId,
      participantName: actorUsername || "",
    });
    return `/chat?${params.toString()}`;
  },
  new_post: (ref) => (ref ? `/post/${ref}` : null),
};

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly expo = new Expo();

  constructor(private readonly grpcClients: GrpcClientsService) {}

  /**
   * Send a push notification to a recipient. Fire-and-forget — never throws.
   *
   * @param actorUsername — the actor's @username. NEVER pass displayName or
   *   any real-name field here: the body is rendered verbatim to the user
   *   and Atto's policy is that real names are never surfaced to anyone.
   */
  async sendPush(
    recipientId: string,
    type: string,
    actorId: string,
    actorUsername: string,
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

      // Defensive: if a caller ever passes a value that looks like a real
      // name (contains a space, which usernames cannot), drop it and log
      // so the regression is visible in production instead of silently
      // shipping real names in pushes.
      let safeActorUsername = actorUsername;
      if (actorUsername && actorUsername.includes(" ")) {
        this.logger.warn(
          `sendPush received non-username value "${actorUsername}" for actor ${actorId} (type=${type}); falling back to "Someone"`,
        );
        safeActorUsername = "Someone";
      }

      const recipientUsername = recipient?.username;
      const body = customBody || bodyFn(safeActorUsername);
      const url = DEEP_LINK[type]?.(
        referenceId ?? null,
        actorId,
        safeActorUsername,
      );

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

  /**
   * Fan out a single push notification to many recipients.
   *
   * Used by feed fanout (new_post) where one author triggers a push to all
   * their followers. Body and deep link are computed once; per-recipient
   * data (push tokens + multi-account `account_username`) are fetched in
   * parallel. Expo handles batching the actual delivery via chunkPushNotifications.
   *
   * @param actorUsername — same contract as sendPush: must be the @username,
   *   never a real-name field.
   */
  async sendPushBulk(
    recipientIds: string[],
    type: string,
    actorId: string,
    actorUsername: string,
    referenceId?: string | null,
  ): Promise<void> {
    if (recipientIds.length === 0) return;
    try {
      const bodyFn = PUSH_BODY[type];
      if (!bodyFn) {
        this.logger.warn(`sendPushBulk: no body template for type "${type}"`);
        return;
      }

      let safeActorUsername = actorUsername;
      if (actorUsername && actorUsername.includes(" ")) {
        this.logger.warn(
          `sendPushBulk received non-username value "${actorUsername}" for actor ${actorId} (type=${type}); falling back to "Someone"`,
        );
        safeActorUsername = "Someone";
      }

      const body = bodyFn(safeActorUsername);
      const url = DEEP_LINK[type]?.(
        referenceId ?? null,
        actorId,
        safeActorUsername,
      );

      // TODO: replace per-id getPushTokens with a GetPushTokensBatch RPC
      // when the user-service supports it. Current cost: 1 gRPC roundtrip
      // per follower. Acceptable up to a few thousand; revisit at scale.
      const [tokensList, recipients] = await Promise.all([
        Promise.all(
          recipientIds.map((id) => this.grpcClients.getPushTokens(id)),
        ),
        this.grpcClients.getUsersBatch(recipientIds),
      ]);

      const recipientUsernameById = new Map(
        recipients.map((r) => [r.id, r.username]),
      );

      const messages: ExpoPushMessage[] = [];
      for (let i = 0; i < recipientIds.length; i++) {
        const recipientId = recipientIds[i];
        const tokens = tokensList[i];
        if (!tokens || tokens.length === 0) continue;
        const recipientUsername = recipientUsernameById.get(recipientId);
        for (const t of tokens) {
          if (!Expo.isExpoPushToken(t.token)) continue;
          messages.push({
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
          });
        }
      }

      if (messages.length === 0) return;

      const chunks = this.expo.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        try {
          await this.expo.sendPushNotificationsAsync(chunk);
        } catch (err) {
          this.logger.error(
            `Bulk push chunk failed: ${(err as Error).message}`,
          );
        }
      }

      this.logger.debug(
        `Bulk push sent: ${messages.length} message(s) for ${type} to ${recipientIds.length} recipient(s)`,
      );
    } catch (error) {
      this.logger.error(`Bulk push failed: ${error.message}`);
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
