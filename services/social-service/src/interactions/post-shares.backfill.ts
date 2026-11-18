import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { BACKFILL_LEGACY_SHARES_SQL } from "./post-shares";

/**
 * Copies the SHARE rows that have no `post_shares` row yet (Nov 18 2026).
 *
 * The deploy creates tables with `prisma db push`, which never runs the SQL of
 * prisma/migrations, so the copy of the migration 20261118_post_shares runs
 * here. It inserts only (ON CONFLICT DO NOTHING), skips every person who
 * already has a row, and does not hold the start: a failure is logged and the
 * service keeps serving; the next start tries again.
 */
@Injectable()
export class PostSharesBackfill implements OnApplicationBootstrap {
  private readonly logger = new Logger(PostSharesBackfill.name);

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    void this.run();
  }

  async run(): Promise<number> {
    try {
      const inserted = await this.prisma.$executeRawUnsafe(
        BACKFILL_LEGACY_SHARES_SQL,
      );
      this.logger.log(`post_shares backfill: ${inserted} legacy rows inserted`);
      return inserted;
    } catch (err) {
      this.logger.error(
        `post_shares backfill failed: ${(err as Error).message}`,
      );
      return -1;
    }
  }
}
