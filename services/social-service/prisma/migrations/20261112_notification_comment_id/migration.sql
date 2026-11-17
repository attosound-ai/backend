-- The comment a "comment" notice points at (Nov 12 2026). Nullable and
-- additive: old rows keep NULL and old code never reads it.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "comment_id" TEXT;
