/**
 * Structured telemetry for the "official account auto-follow" feature.
 *
 * Two call sites emit these events:
 *   1. KafkaConsumer.autoFollowOfficialAccount  — every new signup (user.created)
 *   2. scripts/backfill-official-follows.ts      — the one-time backfill
 *
 * Why structured (single-line JSON) and not free-text logs: social-service has
 * no metrics/Sentry backend, so the ONLY place a prod failure surfaces is the
 * Railway log stream. Free-text lines aren't queryable; a stable JSON shape is.
 * Every line carries `feature` + `event` so you can filter the entire feature
 * with one query and pivot by `event`/`outcome`, e.g. in Railway logs:
 *
 *   feature="official_auto_follow"                         → all activity
 *   feature="official_auto_follow" level="error"           → only failures
 *   event="signup_auto_follow.skipped_unconfigured"        → env not set in prod
 *   event="signup_auto_follow.db_failed"                   → users NOT followed
 *
 * Each failure event includes `errorName`/`errorMessage`/`errorStack` plus the
 * exact `userId`/`officialId` so you know precisely WHAT broke and for WHOM,
 * and `remediation` so you know HOW to fix it without leaving the log line.
 */

export const OFFICIAL_FOLLOW_FEATURE = "official_auto_follow";

export type OfficialFollowEvent =
  // ── signup path (KafkaConsumer) ──
  | "signup_auto_follow.skipped_unconfigured" // OFFICIAL_ACCOUNT_ID env not set
  | "signup_auto_follow.skipped_self" // the official account signed up
  | "signup_auto_follow.already_following" // idempotent redelivery / re-run
  | "signup_auto_follow.success" // new follow edge created
  | "signup_auto_follow.cache_warm_failed" // DB ok, Redis warm failed (self-heals)
  | "signup_auto_follow.db_failed" // edge NOT created — user won't see ATTO posts
  // ── backfill path (script) ──
  | "backfill.config_invalid" // missing required env
  | "backfill.start"
  | "backfill.users_loaded"
  | "backfill.batch_ok"
  | "backfill.batch_failed"
  | "backfill.done"
  | "backfill.failed";

export type OfficialFollowLevel = "debug" | "log" | "warn" | "error";

export interface OfficialFollowFields {
  /** The user who should follow the official account. */
  userId?: string;
  /** The official ATTO SOUND account id (OFFICIAL_ACCOUNT_ID). */
  officialId?: string;
  /** Whether the DB write created a new edge, hit a duplicate, or was skipped. */
  outcome?: "created" | "duplicate" | "skipped" | "error";
  /** Wall-clock duration of the operation, ms. */
  durationMs?: number;

  // ── backfill aggregates ──
  dryRun?: boolean;
  usersTotal?: number;
  toFollow?: number;
  batchIndex?: number;
  batchStart?: number;
  batchEnd?: number;
  insertedNew?: number;
  alreadyExisted?: number;

  // ── error context (present on *_failed / *_invalid) ──
  errorName?: string;
  errorMessage?: string;
  errorStack?: string;
  /** One-line, copy-pasteable hint for how to resolve this exact failure. */
  remediation?: string;

  [key: string]: unknown;
}

/** Normalize any thrown value into stable, loggable error fields. */
export function errorFields(err: unknown): {
  errorName: string;
  errorMessage: string;
  errorStack?: string;
} {
  if (err instanceof Error) {
    return {
      errorName: err.name,
      errorMessage: err.message,
      errorStack: err.stack,
    };
  }
  return { errorName: "NonError", errorMessage: String(err) };
}

/**
 * Build the single-line JSON payload for one telemetry event. The caller decides
 * how to emit it (NestJS Logger in the service, console in the standalone
 * script) and at what level — the `level` is embedded so it's filterable even
 * when the transport doesn't preserve its own severity.
 */
export function officialFollowLog(
  event: OfficialFollowEvent,
  level: OfficialFollowLevel,
  fields: OfficialFollowFields = {},
): string {
  return JSON.stringify({
    feature: OFFICIAL_FOLLOW_FEATURE,
    event,
    level,
    ...fields,
  });
}
