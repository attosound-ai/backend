import { readFileSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import {
  CountsRepository,
  CountType,
} from "../redis/repositories/counts.repository";
import { InteractionsService } from "./interactions.service";
import { BACKFILL_LEGACY_SHARES_SQL } from "./post-shares";
import { PostSharesBackfill } from "./post-shares.backfill";

// The real module loads expo-server-sdk, which jest does not parse.
jest.mock("../push/push.service", () => ({ PushService: class {} }));

/**
 * Shares per destination on a real PostgreSQL (Nov 18 2026): the unique key
 * with ON CONFLICT DO NOTHING, the copy of the SHARE rows that runs at start,
 * and the migration file next to what `prisma db push` builds.
 *
 * Needs a database with the schema of this service, as comment-count.db.spec:
 *
 *   DATABASE_URL=$SOCIAL_TEST_DATABASE_URL npx prisma db push --skip-generate
 *   npx jest post-shares.db
 *
 * Without SOCIAL_TEST_DATABASE_URL the suite is skipped. It deletes every
 * share and interaction of the database it is given, so it refuses anything
 * that is not on this machine.
 */
const url = process.env.SOCIAL_TEST_DATABASE_URL;
const onThisMachine = !!url && /@(127\.0\.0\.1|localhost)[:/]/.test(url);
const suite = onThisMachine ? describe : describe.skip;

class CountsInMemory extends CountsRepository {
  private readonly values = new Map<string, number>();
  private key = (type: CountType, id: string) => `${type}:${id}`;
  async getOrCompute(type: CountType, id: string, loader: () => Promise<number>) {
    const k = this.key(type, id);
    if (!this.values.has(k)) this.values.set(k, await loader());
    return this.values.get(k)!;
  }
  async increment(type: CountType, id: string) {
    const k = this.key(type, id);
    if (!this.values.has(k)) return -1;
    this.values.set(k, this.values.get(k)! + 1);
    return this.values.get(k)!;
  }
  async decrement(type: CountType, id: string) {
    const k = this.key(type, id);
    if (!this.values.has(k)) return -1;
    this.values.set(k, Math.max(0, this.values.get(k)! - 1));
    return this.values.get(k)!;
  }
  async set(type: CountType, id: string, count: number) {
    this.values.set(this.key(type, id), count);
  }
  async invalidate(type: CountType, id: string) {
    this.values.delete(this.key(type, id));
  }
  async getMany(type: CountType, ids: readonly string[]) {
    return new Map(ids.map((id) => [id, this.values.get(this.key(type, id)) ?? null] as const));
  }
  async setMany(type: CountType, entries: ReadonlyArray<{ id: string; count: number }>) {
    for (const e of entries) this.values.set(this.key(type, e.id), e.count);
  }
  expire() {
    this.values.clear();
  }
}

const chat = (n: number) => `6afa6730-6bb5-4c1e-9d3a-${String(n).padStart(12, "0")}`;

suite("shares per destination, on PostgreSQL", () => {
  const POST = "post-share-1";
  const AUTHOR = "278";

  let prisma: PrismaClient;
  let counts: CountsInMemory;
  let service: InteractionsService;
  let pushes: number;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.postShare.deleteMany({});
    await prisma.interaction.deleteMany({});
    await prisma.notification.deleteMany({});
    counts = new CountsInMemory();
    pushes = 0;
    service = new InteractionsService(
      prisma as any,
      counts,
      {
        getContent: async () => ({ author_id: AUTHOR }),
        getUser: async (id: string) => ({ id, username: `user${id}` }),
      } as any,
      { send: async () => undefined } as any,
      {
        sendPush: async () => {
          pushes++;
        },
      } as any,
    );
    (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  });

  async function shown(): Promise<{ sharesCount: number; sharersCount: number }> {
    counts.expire();
    return (await service.getInteractionCountsBatch([POST])).get(POST)!;
  }

  it("8 chats count 8, the same chat again counts nothing, one person", async () => {
    for (let i = 1; i <= 8; i++) {
      await service.share("300", POST, { channel: "chat", conversationId: chat(i) });
    }
    const again = await service.share("300", POST, { channel: "chat", conversationId: chat(3) });
    expect(again.counted).toBe(false);
    expect(await shown()).toEqual(expect.objectContaining({ sharesCount: 8, sharersCount: 1 }));
    expect(await prisma.notification.count({ where: { type: "share" } })).toBe(1);
    await new Promise((r) => setImmediate(r));
    expect(pushes).toBe(1);
  });

  it("parallel sends to the same chat insert one row", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        service.share("300", POST, { channel: "chat", conversationId: chat(1) }),
      ),
    );
    expect(results.filter((r) => r.counted)).toHaveLength(1);
    expect(results.filter((r) => r.firstShare)).toHaveLength(1);
    expect(await prisma.postShare.count()).toBe(1);
    expect(await prisma.interaction.count()).toBe(1);
  });

  it("the start time copy gives each old SHARE row one legacy row, once", async () => {
    // Shares made before the deploy: SHARE rows only.
    await prisma.interaction.createMany({
      data: [
        { userId: "300", contentId: POST, type: "SHARE" },
        { userId: "301", contentId: POST, type: "SHARE" },
        { userId: "300", contentId: "post-share-2", type: "SHARE" },
        { userId: "300", contentId: POST, type: "LIKE" },
      ],
    });
    // Someone who already shared with the new app is left alone.
    await service.share("302", POST, { channel: "chat", conversationId: chat(1) });

    const backfill = new PostSharesBackfill(prisma as any);
    (backfill as any).logger = { log: jest.fn(), error: jest.fn() };
    expect(await backfill.run()).toBe(3);
    expect(await backfill.run()).toBe(0);

    const rows = await prisma.postShare.findMany({ orderBy: { userId: "asc" } });
    expect(rows.filter((r) => r.channel === "legacy")).toHaveLength(3);
    expect(rows.filter((r) => r.userId === "302").map((r) => r.channel)).toEqual(["chat"]);
    expect(await shown()).toEqual(expect.objectContaining({ sharesCount: 3, sharersCount: 3 }));

    // An old share then sent to a chat with the new app: the old one stays.
    await service.share("300", POST, { channel: "chat", conversationId: chat(7) });
    expect((await shown()).sharesCount).toBe(4);
  });

  it("the migration file builds what db push builds and copies the same rows", async () => {
    // A schema of its own with the table the migration reads from.
    const schema = "post_shares_migration_test";
    const sql = readFileSync(
      join(__dirname, "../../prisma/migrations/20261118_post_shares/migration.sql"),
      "utf8",
    );
    const statements = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        await tx.$executeRawUnsafe(`CREATE TYPE "InteractionType" AS ENUM ('LIKE', 'COMMENT', 'SHARE')`);
        await tx.$executeRawUnsafe(`CREATE TABLE "interactions" (
          "id" TEXT PRIMARY KEY, "user_id" TEXT NOT NULL, "content_id" TEXT NOT NULL,
          "type" "InteractionType" NOT NULL, "comment" TEXT,
          "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
        await tx.$executeRawUnsafe(`INSERT INTO "interactions" ("id", "user_id", "content_id", "type") VALUES
          ('i1', '300', 'p1', 'SHARE'), ('i2', '301', 'p1', 'SHARE'), ('i3', '300', 'p1', 'LIKE')`);
        // Twice: every statement can run again on a deploy that repeats it.
        for (let run = 0; run < 2; run++) {
          for (const s of statements) await tx.$executeRawUnsafe(s);
          const n = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "post_shares"`);
          expect(Number(n[0].n)).toBe(2);
        }
        // Same statement as the one that runs at start.
        expect(await tx.$executeRawUnsafe(BACKFILL_LEGACY_SHARES_SQL)).toBe(0);
      });

      // Same columns and index names as the table db push made from schema.prisma.
      const shape = async (s: string) => ({
        columns: await prisma.$queryRawUnsafe<unknown[]>(
          `SELECT column_name::text, data_type::text, is_nullable::text, column_default::text FROM information_schema.columns
           WHERE table_schema = $1::text AND table_name = 'post_shares' ORDER BY column_name`,
          s,
        ),
        indexes: await prisma.$queryRawUnsafe<unknown[]>(
          `SELECT indexname::text, replace(indexdef, $1::text || '.', '') AS def FROM pg_indexes
           WHERE schemaname = $1::text AND tablename = 'post_shares' ORDER BY indexname`,
          s,
        ),
      });
      const [pushed] = await prisma.$queryRawUnsafe<{ s: string }[]>(
        `SELECT table_schema::text AS s FROM information_schema.tables
         WHERE table_name = 'post_shares' AND table_schema <> $1::text LIMIT 1`,
        schema,
      );
      const fromMigration = await shape(schema);
      const fromPush = await shape(pushed.s);
      expect(fromMigration.columns).toEqual(fromPush.columns);
      expect(fromMigration.indexes).toEqual(fromPush.indexes);
      expect(fromMigration.indexes).toHaveLength(3);
    } finally {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });
});
