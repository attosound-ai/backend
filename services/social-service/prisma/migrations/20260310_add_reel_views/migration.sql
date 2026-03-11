-- CreateTable: reel_views (for FYP watch-time signals)
CREATE TABLE "reel_views" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "content_id" TEXT NOT NULL,
    "watch_ms" INTEGER NOT NULL,
    "replays" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reel_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reel_views_content_id_idx" ON "reel_views"("content_id");

-- CreateIndex
CREATE INDEX "reel_views_user_id_idx" ON "reel_views"("user_id");
