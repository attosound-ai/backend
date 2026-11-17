import { NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import {
  CountsRepository,
  CountType,
} from "../redis/repositories/counts.repository";
import { InteractionsService } from "./interactions.service";

// The service only needs the class as an injection token. The real module
// loads expo-server-sdk, which ships as ES modules that jest does not parse.
jest.mock("../push/push.service", () => ({ PushService: class {} }));

/**
 * The number of comments a post shows against the comments its list shows,
 * on a real PostgreSQL: the rule lives in a Prisma filter over a relation,
 * and a double of Prisma would only repeat what the test already believes.
 *
 * Needs an empty database with the schema of this service:
 *
 *   docker run -d --rm --name atto-social-test -e POSTGRES_PASSWORD=prueba \
 *     -e POSTGRES_DB=social_test -p 127.0.0.1:55434:5432 postgres:16
 *   export SOCIAL_TEST_DATABASE_URL=postgresql://postgres:prueba@127.0.0.1:55434/social_test
 *   DATABASE_URL=$SOCIAL_TEST_DATABASE_URL npx prisma db push --skip-generate
 *   npx jest comment-count
 *
 * Without SOCIAL_TEST_DATABASE_URL the suite is skipped. It deletes every
 * comment of the database it is given, so it refuses anything that is not
 * on this machine.
 */
const url = process.env.SOCIAL_TEST_DATABASE_URL;
const onThisMachine = !!url && /@(127\.0\.0\.1|localhost)[:/]/.test(url);
const suite = onThisMachine ? describe : describe.skip;

/** The Redis counters, with the contract of CountsRepository and no Redis. */
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
    return new Map(
      ids.map((id) => [id, this.values.get(this.key(type, id)) ?? null] as const),
    );
  }
  async setMany(type: CountType, entries: ReadonlyArray<{ id: string; count: number }>) {
    for (const e of entries) this.values.set(this.key(type, e.id), e.count);
  }
  /** What ten minutes do to the cache: every number is counted again. */
  expire() {
    this.values.clear();
  }
}

suite("the number of comments of a post, on PostgreSQL", () => {
  const POST = "post-1";
  const OTHER_POST = "post-2";
  const AUTHOR = "278";
  const READER = "300";

  let prisma: PrismaClient;
  let counts: CountsInMemory;
  let service: InteractionsService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Replies first: they point at their comment.
    await prisma.comment.deleteMany({ where: { parentId: { not: null } } });
    await prisma.comment.deleteMany({});
    await prisma.notification.deleteMany({});
    counts = new CountsInMemory();
    service = new InteractionsService(
      prisma as any,
      counts,
      {
        getContent: async () => ({ author_id: AUTHOR }),
        getUser: async (id: string) => ({ id, username: `user${id}` }),
        getUsersBatch: async (ids: string[]) =>
          ids.map((id) => ({ id, username: `user${id}` })),
      } as any,
      { send: async () => undefined } as any,
      { sendPush: async () => undefined } as any,
    );
    (service as any).logger = { log: jest.fn(), error: jest.fn() };
  });

  /** What the post shows next to the bubble, the way the feed asks for it. */
  async function shownInFeed(postId = POST): Promise<number> {
    const batch = await service.getInteractionCountsBatch([postId]);
    return batch.get(postId)!.commentsCount;
  }

  /** What the post shows when it is asked for alone. */
  async function shownAlone(postId = POST): Promise<number> {
    return (await service.getInteractionCounts(postId)).commentsCount;
  }

  /** Every comment and reply a reader finds on opening the list, all pages. */
  async function listed(postId = POST): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const { comments, meta } = await service.getComments(postId, page, 20);
      for (const c of comments) {
        ids.push(c.id, ...(c.replies ?? []).map((r) => r.id));
      }
      if (page >= meta.totalPages) return ids;
    }
  }

  async function expectNumberToMatchTheList(postId = POST) {
    const inList = (await listed(postId)).length;
    expect(await shownAlone(postId)).toBe(inList);
    expect(await shownInFeed(postId)).toBe(inList);
    counts.expire();
    expect(await shownInFeed(postId)).toBe(inList);
    counts.expire();
    expect(await shownAlone(postId)).toBe(inList);
  }

  it("does not bring deleted comments back when the number is counted again (Oct 7 2026: 3 shown, 1 in the list)", async () => {
    const kept = await service.addComment(READER, POST, "stays");
    const first = await service.addComment(READER, POST, "deleted one");
    const second = await service.addComment(AUTHOR, POST, "deleted two");
    await service.deleteComment(READER, first.id);
    await service.deleteComment(AUTHOR, second.id);

    counts.expire();

    expect(await listed()).toEqual([kept.id]);
    expect(await shownInFeed()).toBe(1);
    counts.expire();
    expect(await shownAlone()).toBe(1);
  });

  it("counts a reply, and takes the replies away with their comment", async () => {
    const top = await service.addComment(READER, POST, "comment");
    await service.addComment(AUTHOR, POST, "reply one", top.id);
    await service.addComment(READER, POST, "reply two", top.id);
    const other = await service.addComment(AUTHOR, POST, "another comment");
    expect(await shownInFeed()).toBe(4);
    await expectNumberToMatchTheList();

    await service.deleteComment(READER, top.id);

    expect(await listed()).toEqual([other.id]);
    expect(await shownInFeed()).toBe(1);
    await expectNumberToMatchTheList();
  });

  it("takes one off for a deleted reply and leaves its comment", async () => {
    const top = await service.addComment(READER, POST, "comment");
    const reply = await service.addComment(AUTHOR, POST, "reply", top.id);

    await service.deleteComment(AUTHOR, reply.id);

    expect(await listed()).toEqual([top.id]);
    expect(await shownInFeed()).toBe(1);
    await expectNumberToMatchTheList();
  });

  it("repairs a number that had already drifted the next time a comment is deleted", async () => {
    await service.addComment(READER, POST, "stays");
    const gone = await service.addComment(READER, POST, "goes");
    await counts.set("comments", POST, 9);

    await service.deleteComment(READER, gone.id);

    expect(await shownInFeed()).toBe(1);
  });

  it("hangs an answer to a reply from the comment of that reply, where the list shows it", async () => {
    const top = await service.addComment(READER, POST, "comment");
    const reply = await service.addComment(AUTHOR, POST, "reply", top.id);

    const answer = await service.addComment(READER, POST, "answer to the reply", reply.id);

    expect(answer.parentId).toBe(top.id);
    expect(await listed()).toEqual([top.id, reply.id, answer.id]);
    await expectNumberToMatchTheList();
  });

  it("refuses a reply to a deleted comment, to a reply of a deleted comment and to a comment of another post", async () => {
    const top = await service.addComment(READER, POST, "comment");
    const reply = await service.addComment(AUTHOR, POST, "reply", top.id);
    const elsewhere = await service.addComment(READER, OTHER_POST, "other post");
    await service.deleteComment(READER, top.id);

    await expect(service.addComment(AUTHOR, POST, "late", top.id)).rejects.toThrow(NotFoundException);
    await expect(service.addComment(AUTHOR, POST, "late", reply.id)).rejects.toThrow(NotFoundException);
    await expect(service.addComment(AUTHOR, POST, "wrong post", elsewhere.id)).rejects.toThrow(NotFoundException);
    await expect(service.addComment(AUTHOR, POST, "nothing", "00000000-0000-0000-0000-000000000000")).rejects.toThrow(NotFoundException);

    expect(await shownInFeed()).toBe(0);
    expect(await shownInFeed(OTHER_POST)).toBe(1);
  });

  it("lists every reply of a comment, not the first three", async () => {
    const top = await service.addComment(READER, POST, "comment");
    const replies: string[] = [];
    for (let i = 1; i <= 5; i++) {
      replies.push((await service.addComment(AUTHOR, POST, `reply ${i}`, top.id)).id);
    }

    expect(await listed()).toEqual([top.id, ...replies]);
    await expectNumberToMatchTheList();
  });

  it("keeps the numbers of two posts apart in one feed request", async () => {
    const a = await service.addComment(READER, POST, "one");
    await service.addComment(READER, POST, "two");
    await service.addComment(READER, OTHER_POST, "three");
    await service.deleteComment(READER, a.id);
    counts.expire();

    const batch = await service.getInteractionCountsBatch([POST, OTHER_POST, "post-without-comments"]);

    expect(batch.get(POST)!.commentsCount).toBe(1);
    expect(batch.get(OTHER_POST)!.commentsCount).toBe(1);
    expect(batch.get("post-without-comments")!.commentsCount).toBe(0);
  });

  it("shows the number of the list after any run of comments, replies and deletions", async () => {
    // A fixed seed: the run is the same every time, so a failure can be replayed.
    let seed = 20261007;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
    const alive: Array<{ id: string; userId: string }> = [];

    for (let step = 0; step < 150; step++) {
      const dice = random();
      const userId = pick([AUTHOR, READER]);
      const visible = new Set(await listed());
      const open = alive.filter((c) => visible.has(c.id));

      if (dice < 0.4 || open.length === 0) {
        const c = await service.addComment(userId, POST, `comment ${step}`);
        alive.push({ id: c.id, userId });
      } else if (dice < 0.75) {
        const c = await service.addComment(userId, POST, `reply ${step}`, pick(open).id);
        alive.push({ id: c.id, userId });
      } else {
        const victim = pick(open);
        await service.deleteComment(victim.userId, victim.id);
      }
      if (random() < 0.2) counts.expire();

      const inList = (await listed()).length;
      expect([step, await shownInFeed()]).toEqual([step, inList]);
    }
    await expectNumberToMatchTheList();
  }, 120_000);
});
