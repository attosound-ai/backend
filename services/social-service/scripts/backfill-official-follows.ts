/**
 * One-time backfill: make every EXISTING user follow the official ATTO SOUND
 * account, mirroring the auto-follow that new signups now get for free
 * (see KafkaConsumer.autoFollowOfficialAccount).
 *
 * Why a script (and not pure SQL): the authoritative list of all users lives
 * in the user-service Postgres DB, which is SEPARATE from social-service's DB
 * where the `follows` table lives — so we read the user ids from one and write
 * follow edges into the other. We reuse Prisma for both connections and only
 * run a raw `SELECT` against user-service, so its schema never has to match
 * social-service's Prisma models.
 *
 * Idempotent: `createMany({ skipDuplicates: true })` means re-running is safe
 * and only inserts the edges that are missing. Batches are isolated: if one
 * batch fails (e.g. a transient DB blip) the run continues and reports the
 * exact failed ranges so you can re-run to repair just those.
 *
 * The follow-graph Redis caches do NOT need touching here — they carry a 1h TTL
 * (see follow-graph.repository.ts) and re-materialize from Postgres on the next
 * cold read, so feeds/stats reflect the backfill within the hour automatically.
 *
 * Telemetry: every line is structured JSON (feature="official_auto_follow") so
 * the run is greppable in Railway/CI logs and failures carry the exact context
 * + a remediation hint. See common/telemetry/official-follow.telemetry.ts.
 *
 * Usage (run from services/social-service after `npm install`):
 *
 *   OFFICIAL_ACCOUNT_ID=152 \
 *   DATABASE_URL="<social-service postgres url>" \
 *   USER_SERVICE_DATABASE_URL="<user-service postgres url>" \
 *   npx ts-node scripts/backfill-official-follows.ts [--dry-run]
 *
 * On Railway, grab each DATABASE_URL from the respective Postgres service.
 * Pass --dry-run first to print the user count without writing anything.
 */
import { PrismaClient } from "@prisma/client";
import {
  officialFollowLog,
  errorFields,
  type OfficialFollowEvent,
  type OfficialFollowLevel,
  type OfficialFollowFields,
} from "../src/common/telemetry/official-follow.telemetry";

/** Emit one structured telemetry line to the right console stream. */
function emit(
  event: OfficialFollowEvent,
  level: OfficialFollowLevel,
  fields: OfficialFollowFields = {},
): void {
  const line = officialFollowLog(event, level, fields);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

async function main(): Promise<void> {
  const officialId = process.env.OFFICIAL_ACCOUNT_ID;
  if (!officialId) {
    emit("backfill.config_invalid", "error", {
      remediation:
        "OFFICIAL_ACCOUNT_ID env is required (the ATTO account's numeric user id, e.g. 152).",
    });
    throw new Error("OFFICIAL_ACCOUNT_ID env is required");
  }
  const userDbUrl = process.env.USER_SERVICE_DATABASE_URL;
  if (!userDbUrl) {
    emit("backfill.config_invalid", "error", {
      officialId,
      remediation:
        "USER_SERVICE_DATABASE_URL env is required (user-service Postgres connection string).",
    });
    throw new Error("USER_SERVICE_DATABASE_URL env is required");
  }
  const dryRun = process.argv.includes("--dry-run");
  const startedAt = Date.now();

  emit("backfill.start", "log", { officialId, dryRun });

  // social-service DB (default DATABASE_URL) — where the follow edges go.
  const social = new PrismaClient();
  // user-service DB — source of truth for the full user list. We only run a
  // raw SELECT against it, so the Prisma schema mismatch is irrelevant.
  const usersDb = new PrismaClient({
    datasources: { db: { url: userDbUrl } },
  });

  try {
    const rows = await usersDb.$queryRawUnsafe<{ id: string }[]>(
      "SELECT id::text AS id FROM users",
    );
    const followerIds = rows
      .map((r) => r.id)
      .filter((id) => id && id !== officialId);

    emit("backfill.users_loaded", "log", {
      officialId,
      dryRun,
      usersTotal: rows.length,
      toFollow: followerIds.length,
    });

    if (dryRun) {
      emit("backfill.done", "log", {
        officialId,
        dryRun: true,
        usersTotal: rows.length,
        toFollow: followerIds.length,
        insertedNew: 0,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const BATCH = 1000;
    let insertedNew = 0;
    let processed = 0;
    const failedBatches: { batchIndex: number; start: number; end: number }[] =
      [];

    for (let i = 0; i < followerIds.length; i += BATCH) {
      const batch = followerIds.slice(i, i + BATCH);
      const batchIndex = Math.floor(i / BATCH);
      const batchStart = i;
      const batchEnd = Math.min(i + BATCH, followerIds.length);

      try {
        const res = await social.follow.createMany({
          data: batch.map((followerId) => ({
            followerId,
            followingId: officialId,
          })),
          skipDuplicates: true,
        });
        insertedNew += res.count;
        processed = batchEnd;
        emit("backfill.batch_ok", "log", {
          officialId,
          batchIndex,
          batchStart,
          batchEnd,
          insertedNew: res.count,
          processed,
          toFollow: followerIds.length,
        });
      } catch (err) {
        // Isolate the failure: record the range and keep going so a single bad
        // batch doesn't abort the whole backfill. Re-running repairs the gap.
        failedBatches.push({ batchIndex, start: batchStart, end: batchEnd });
        emit("backfill.batch_failed", "error", {
          officialId,
          batchIndex,
          batchStart,
          batchEnd,
          toFollow: followerIds.length,
          ...errorFields(err),
          remediation:
            "This range was NOT written. The script is idempotent — re-run it to retry only the missing edges once the underlying DB issue is resolved.",
        });
      }
    }

    emit("backfill.done", failedBatches.length ? "warn" : "log", {
      officialId,
      dryRun: false,
      usersTotal: rows.length,
      toFollow: followerIds.length,
      insertedNew,
      alreadyExisted: processed - insertedNew,
      failedBatchCount: failedBatches.length,
      failedBatches,
      durationMs: Date.now() - startedAt,
      remediation: failedBatches.length
        ? "Some batches failed — re-run this script (idempotent) to repair them."
        : "Redis follow-graph caches self-heal within 1h (TTL); cold reads reflect it immediately.",
    });
  } finally {
    await Promise.allSettled([social.$disconnect(), usersDb.$disconnect()]);
  }
}

main().catch((err) => {
  emit("backfill.failed", "error", {
    ...errorFields(err),
    remediation:
      "Backfill aborted before completing. Fix the error above (commonly a bad DATABASE_URL / USER_SERVICE_DATABASE_URL or network/DB outage) and re-run — it is idempotent.",
  });
  process.exit(1);
});
