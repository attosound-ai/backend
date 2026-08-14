import { Injectable, Logger } from "@nestjs/common";
import Expo, { ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import { UsersClientService } from "../users-client/users-client.service";
import { AnalyticsService } from "../analytics/analytics.service";

/**
 * Fallback push delivery for telephony events.
 *
 * The Twilio Voice SDK push (PushKit on iOS, FCM data on Android) is the
 * primary channel for incoming calls — it wakes the app and triggers
 * CallKit / our in-app UI. But if the Voice SDK never answers (device
 * unregistered, watchdog killed the app, push-credential mismatch, network
 * blip during the dial timeout window), the call dies silently and the
 * user has zero signal anything happened.
 *
 * This service is the safety net: when a dial completes without an answer
 * (no-answer / busy / failed / canceled) on an inbound bridge call, we
 * send a regular APNS/FCM notification through Expo Push so the user sees
 * a "missed call from X" entry in their notification center.
 *
 * Patterned after social-service's `PushService` to keep the operational
 * surface familiar (same Expo client, same DeviceNotRegistered handling).
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly expo = new Expo();

  constructor(
    private readonly usersClient: UsersClientService,
    private readonly analytics: AnalyticsService,
  ) {}

  /**
   * Fire-and-forget missed-call push to a user's registered devices.
   * Never throws — push delivery failure must not affect call bookkeeping.
   *
   * @param recipientUserId — the bridge owner (the account the caller dialled)
   * @param callerDisplay — human-readable caller identity (E.164 for PSTN,
   *   @username for app-to-app). Used verbatim in the notification body.
   * @param callSid — Twilio CallSid, embedded in `data` so the client can
   *   deep-link to a call detail screen if/when one exists.
   * @param fanoutUserIds — optional extra recipient IDs (linked accounts on
   *   the same device). When provided, every linked account gets the
   *   notification so the user sees the missed call regardless of which
   *   session is currently active in the app.
   */
  async sendMissedCallPush(
    recipientUserId: string,
    callerDisplay: string,
    callSid: string,
    fanoutUserIds?: number[],
  ): Promise<void> {
    try {
      // Collect every user we need to notify: the bridge owner plus any
      // additional linked accounts (deduped).
      const userIds = new Set<string>([recipientUserId]);
      if (fanoutUserIds) {
        for (const id of fanoutUserIds) {
          if (Number.isFinite(id) && id > 0) {
            userIds.add(String(id));
          }
        }
      }

      // Fetch tokens for every recipient in parallel. Per-user failures are
      // swallowed in UsersClientService so a single bad ID can't sink the
      // batch.
      const tokenLists = await Promise.all(
        Array.from(userIds).map((uid) =>
          this.usersClient.getActivePushTokens(uid).then((tokens) => ({
            userId: uid,
            tokens,
          })),
        ),
      );

      // Dedup by push TOKEN, not by user. An Expo push token is per app
      // INSTALL, not per account — so when several linked accounts are signed
      // in on the SAME device (the person-merge / account-switch case) they all
      // resolve to the SAME token. Fanning out per-account then pushed to that
      // one token once per account, so the user saw the SAME missed-call
      // notification twice on one device (recipients=2, messages_sent=2 in
      // backend_missed_call_push). The token is the actual Expo delivery target
      // and is unique per install, so collapsing on it sends exactly ONE
      // notification per install while genuinely different devices (different
      // installs => different tokens) each still get theirs. We deliberately do
      // NOT key on deviceId here: it is Constants.deviceName client-side, which
      // collides across devices sharing a default name and could wrongly drop a
      // real device's notification — a missed notification is worse than a rare
      // duplicate from token rotation (the stale token gets DeviceNotRegistered
      // and is cleaned up anyway).
      const messages: ExpoPushMessage[] = [];
      const seenTokens = new Set<string>();
      let duplicateTokens = 0;
      for (const { userId, tokens } of tokenLists) {
        for (const t of tokens) {
          if (!Expo.isExpoPushToken(t.token)) continue;
          if (seenTokens.has(t.token)) {
            duplicateTokens += 1;
            continue;
          }
          seenTokens.add(t.token);
          messages.push({
            to: t.token,
            title: "ATTO SOUND",
            body: `Missed call from ${callerDisplay}`,
            data: {
              type: "missed_call",
              call_sid: callSid,
              account_id: userId,
              caller: callerDisplay,
            },
            sound: "default" as const,
            priority: "high" as const,
            channelId: "default",
          });
        }
      }

      if (messages.length === 0) {
        this.logger.debug(
          "No active push tokens for missed-call recipients (sid=%s)",
          callSid,
        );
        this.analytics.capture(recipientUserId, "backend_missed_call_push", {
          call_sid: callSid,
          caller: callerDisplay,
          recipients: userIds.size,
          messages_sent: 0,
          no_tokens: true,
        });
        return;
      }

      const chunks = this.expo.chunkPushNotifications(messages);
      let deviceNotRegistered = 0;
      let chunkErrors = 0;
      for (const chunk of chunks) {
        try {
          const tickets: ExpoPushTicket[] =
            await this.expo.sendPushNotificationsAsync(chunk);
          for (const ticket of tickets) {
            if (
              ticket.status === "error" &&
              ticket.details?.error === "DeviceNotRegistered"
            ) {
              deviceNotRegistered += 1;
              this.logger.warn(
                "Missed-call push DeviceNotRegistered (sid=%s) — token should be deactivated",
                callSid,
              );
            }
          }
        } catch (err) {
          chunkErrors += 1;
          this.logger.warn(
            "Missed-call push chunk failed (sid=%s): %s",
            callSid,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      this.logger.log(
        "Sent missed-call push to %d device(s) across %d account(s) for call %s",
        messages.length,
        userIds.size,
        callSid,
      );

      this.analytics.capture(recipientUserId, "backend_missed_call_push", {
        call_sid: callSid,
        caller: callerDisplay,
        recipients: userIds.size,
        messages_sent: messages.length,
        // Number of same-device duplicate tokens collapsed. > 0 means a user had
        // multiple linked accounts sharing one device and would previously have
        // received one duplicate notification per collapsed token.
        duplicate_tokens: duplicateTokens,
        device_not_registered: deviceNotRegistered,
        chunk_errors: chunkErrors,
        no_tokens: false,
      });
    } catch (err) {
      // Outer catch is paranoia — every internal step already swallows.
      this.logger.error(
        "sendMissedCallPush failed unexpectedly (sid=%s): %s",
        callSid,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
