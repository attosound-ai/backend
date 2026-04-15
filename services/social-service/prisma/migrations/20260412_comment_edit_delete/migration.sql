-- Add edit/delete tracking fields to comments table
ALTER TABLE "comments"
  ADD COLUMN "is_edited" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "edited_at" TIMESTAMPTZ,
  ADD COLUMN "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deleted_at" TIMESTAMPTZ;
