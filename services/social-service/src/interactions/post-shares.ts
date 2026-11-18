import { BadRequestException } from "@nestjs/common";

/**
 * Shares counted per destination (Nov 18 2026, client report: a post sent to
 * 8 chats showed 1). A share is one row of `post_shares` per (person, post,
 * channel, target): each chat a post goes to counts once, and sending it to
 * the same chat again does not. The SHARE row of `interactions` stays one per
 * person: it decides the notice to the author and the feed ranking.
 */

/** What the app sends in the body of POST /posts/:id/share. */
export const SHARE_CHANNELS = ["chat", "external", "link"] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

/** A share that did not say where it went: app builds before Nov 18 2026
 *  and the SHARE rows copied from `interactions`. One per person and post. */
export const LEGACY_CHANNEL = "legacy";

/** Destinations one person can add to the count of one post. */
export const MAX_TARGETS_PER_POST = 50;

export interface ShareTargetInput {
  channel?: string | null;
  conversationId?: string | null;
}

export interface ShareTarget {
  channel: ShareChannel | typeof LEGACY_CHANNEL;
  /** The conversation id for `chat`; empty for every other channel. */
  targetKey: string;
}

/**
 * The row key of a share. No body (or an empty one) is the legacy share. The
 * DTO already checked the channel and the uuid; this refuses the combinations
 * a field by field check cannot see.
 */
export function shareTargetOf(input?: ShareTargetInput | null): ShareTarget {
  const channel = input?.channel ?? undefined;
  const conversationId = input?.conversationId?.trim() || undefined;

  if (!channel) {
    if (conversationId) {
      throw new BadRequestException("conversationId needs channel 'chat'");
    }
    return { channel: LEGACY_CHANNEL, targetKey: "" };
  }
  if (!(SHARE_CHANNELS as readonly string[]).includes(channel)) {
    throw new BadRequestException(
      `channel must be one of: ${SHARE_CHANNELS.join(", ")}`,
    );
  }
  if (conversationId && channel !== "chat") {
    throw new BadRequestException("conversationId is only for channel 'chat'");
  }
  // A chat share without its chat still counts, once, like the app's own
  // fallback (shareRequestBody in the front).
  return {
    channel: channel as ShareChannel,
    targetKey: channel === "chat" && conversationId ? conversationId.toLowerCase() : "",
  };
}

/**
 * One 'legacy' row for every person who shared a post and has none yet. Runs
 * at every start (PostSharesBackfill) and is the same statement as the
 * migration 20261118_post_shares: a person with any row is skipped and the id
 * is the SHARE interaction's id, so it never adds a row twice. A share made by
 * the new code writes both rows in one transaction, so this never sees the
 * SHARE row without its post_shares row.
 */
export const BACKFILL_LEGACY_SHARES_SQL = `
INSERT INTO "post_shares" ("id", "user_id", "content_id", "channel", "target_key", "created_at")
SELECT i."id", i."user_id", i."content_id", '${LEGACY_CHANNEL}', '', i."created_at"
FROM "interactions" i
WHERE i."type" = 'SHARE'
  AND NOT EXISTS (
    SELECT 1 FROM "post_shares" ps
    WHERE ps."user_id" = i."user_id" AND ps."content_id" = i."content_id"
  )
ON CONFLICT DO NOTHING`;
