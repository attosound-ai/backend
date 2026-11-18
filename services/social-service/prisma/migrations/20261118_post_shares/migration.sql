-- Shares counted per destination (Nov 18 2026). Additive: a new table, its
-- indexes and a copy of the SHARE rows that exist today. Nothing existing is
-- changed or deleted.
--
-- The deploy runs `prisma db push` (Dockerfile), which creates the table from
-- schema.prisma; the copy below also runs at every start of the service
-- (src/interactions/post-shares.backfill.ts, same statement), so this file is
-- the record of the change and works the same under `prisma migrate deploy`.
-- Every statement can run twice.

CREATE TABLE IF NOT EXISTS "post_shares" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "content_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "target_key" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_shares_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "post_shares_user_id_content_id_channel_target_key_key"
    ON "post_shares"("user_id", "content_id", "channel", "target_key");

CREATE INDEX IF NOT EXISTS "post_shares_content_id_idx" ON "post_shares"("content_id");

-- One 'legacy' row for every person who shared a post and has no row yet.
-- The id is the SHARE interaction's id, so a second run inserts nothing.
INSERT INTO "post_shares" ("id", "user_id", "content_id", "channel", "target_key", "created_at")
SELECT i."id", i."user_id", i."content_id", 'legacy', '', i."created_at"
FROM "interactions" i
WHERE i."type" = 'SHARE'
  AND NOT EXISTS (
    SELECT 1 FROM "post_shares" ps
    WHERE ps."user_id" = i."user_id" AND ps."content_id" = i."content_id"
  )
ON CONFLICT DO NOTHING;
