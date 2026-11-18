import { ArgumentMetadata, BadRequestException, ValidationPipe } from "@nestjs/common";
import {
  CountsRepository,
  CountType,
} from "../redis/repositories/counts.repository";
import { ShareDto } from "./dto/interaction.dto";
import { InteractionsService } from "./interactions.service";
import { InteractionsController } from "./interactions.controller";
import { MAX_TARGETS_PER_POST, shareTargetOf } from "./post-shares";

// The real module loads expo-server-sdk, which jest does not parse.
jest.mock("../push/push.service", () => ({ PushService: class {} }));

/**
 * A post sent to 8 chats showed 1 (Nov 18 2026): one SHARE row per person and
 * post, and a Redis counter that went up on every call and fell back to the
 * row count after 10 minutes. Shares are now one `post_shares` row per
 * destination; the SHARE row stays one per person.
 */

type Row = Record<string, any>;

/** The few Prisma calls share() and the counts make, over arrays, with the
 *  unique keys of schema.prisma enforced the way ON CONFLICT DO NOTHING does. */
function prismaInMemory() {
  const postShares: Row[] = [];
  const interactions: Row[] = [];
  const notifications: Row[] = [];
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === "object" && "in" in v ? v.in.includes(row[k]) : row[k] === v,
    );
  const createMany =
    (table: Row[], key: string[]) =>
    async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const d of data) {
        const dup = table.some((r) => key.every((k) => r[k] === (d[k] ?? "")));
        if (dup && !skipDuplicates) throw new Error("unique violation");
        if (dup) continue;
        table.push({ targetKey: "", ...d, createdAt: new Date() });
        count++;
      }
      return { count };
    };
  const groupBy =
    (table: Row[]) =>
    async ({ where }: { where: Row }) => {
      const out = new Map<string, number>();
      for (const r of table.filter((r) => matches(r, where))) {
        out.set(r.contentId, (out.get(r.contentId) ?? 0) + 1);
      }
      return [...out].map(([contentId, n]) => ({ contentId, _count: { contentId: n } }));
    };
  return {
    postShares,
    interactions,
    notifications,
    postShare: {
      count: async ({ where }: { where: Row }) => postShares.filter((r) => matches(r, where)).length,
      createMany: createMany(postShares, ["userId", "contentId", "channel", "targetKey"]),
      groupBy: groupBy(postShares),
    },
    interaction: {
      count: async ({ where }: { where: Row }) => interactions.filter((r) => matches(r, where)).length,
      createMany: createMany(interactions, ["userId", "contentId", "type"]),
      groupBy: groupBy(interactions),
    },
    comment: { groupBy: async () => [], count: async () => 0 },
    repost: { groupBy: async () => [], count: async () => 0 },
    notification: {
      create: async ({ data }: { data: Row }) => {
        notifications.push(data);
        return data;
      },
    },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  };
}

/** The Redis counters, with the contract of CountsRepository and no Redis. */
class CountsInMemory extends CountsRepository {
  readonly values = new Map<string, number>();
  readonly increments: string[] = [];
  private key = (type: CountType, id: string) => `${type}:${id}`;
  async getOrCompute(type: CountType, id: string, loader: () => Promise<number>) {
    const k = this.key(type, id);
    if (!this.values.has(k)) this.values.set(k, await loader());
    return this.values.get(k)!;
  }
  async increment(type: CountType, id: string) {
    this.increments.push(type);
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
  /** What ten minutes do to the cache: every number is counted again. */
  expire() {
    this.values.clear();
  }
}

const POST = "post-1";
const AUTHOR = "278";
const SENDER = "300";
const chat = (n: number) => `6afa6730-6bb5-4c1e-9d3a-${String(n).padStart(12, "0")}`;

function setup() {
  const prisma = prismaInMemory();
  const counts = new CountsInMemory();
  const kafka = { send: jest.fn().mockResolvedValue(undefined) };
  const push = { sendPush: jest.fn().mockResolvedValue(undefined) };
  const service = new InteractionsService(
    prisma as any,
    counts,
    {
      getContent: async () => ({ author_id: AUTHOR }),
      getUser: async (id: string) => ({ id, username: `user${id}` }),
    } as any,
    kafka as any,
    push as any,
  );
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { prisma, counts, kafka, push, service };
}

/** The number on the card, as the feed reads it, after the cache expires. */
async function shown(ctx: ReturnType<typeof setup>, expire = true) {
  if (expire) ctx.counts.expire();
  const batch = await ctx.service.getInteractionCountsBatch([POST]);
  return batch.get(POST)!;
}

/** firePush runs after a gRPC promise; let it settle. */
const settle = () => new Promise((r) => setImmediate(r));

describe("shares counted per destination", () => {
  it("8 different chats count 8, and still 8 after the cache expires", async () => {
    const ctx = setup();
    await shown(ctx); // seed the cache, as an open feed does
    for (let i = 1; i <= 8; i++) {
      await ctx.service.share(SENDER, POST, { channel: "chat", conversationId: chat(i) });
    }
    expect((await shown(ctx, false)).sharesCount).toBe(8);
    expect((await shown(ctx)).sharesCount).toBe(8);
    expect(ctx.prisma.interactions).toHaveLength(1);
  });

  it("the same chat twice counts once and does not move Redis", async () => {
    const ctx = setup();
    await shown(ctx);
    const first = await ctx.service.share(SENDER, POST, { channel: "chat", conversationId: chat(1) });
    const again = await ctx.service.share(SENDER, POST, {
      channel: "chat",
      conversationId: chat(1).toUpperCase(),
    });
    expect(first.counted).toBe(true);
    expect(again.counted).toBe(false);
    expect(ctx.counts.increments.filter((t) => t === "shares")).toHaveLength(1);
    expect((await shown(ctx, false)).sharesCount).toBe(1);
    expect((await shown(ctx)).sharesCount).toBe(1);
    // The live update goes out only when the number moved.
    const created = ctx.kafka.send.mock.calls.filter(([topic]) => topic === "interaction.created");
    expect(created).toHaveLength(1);
  });

  it("external and link count once each per person", async () => {
    const ctx = setup();
    await ctx.service.share(SENDER, POST, { channel: "external" });
    await ctx.service.share(SENDER, POST, { channel: "external" });
    await ctx.service.share(SENDER, POST, { channel: "link" });
    await ctx.service.share(SENDER, POST, { channel: "chat" }); // chat without its id
    await ctx.service.share(SENDER, POST, { channel: "chat" });
    expect((await shown(ctx)).sharesCount).toBe(3);
  });

  it("without a body (older builds) it counts once per person, as before", async () => {
    const ctx = setup();
    await ctx.service.share(SENDER, POST);
    await ctx.service.share(SENDER, POST, undefined);
    await ctx.service.share(SENDER, POST, {});
    await ctx.service.share("301", POST);
    expect((await shown(ctx)).sharesCount).toBe(2);
    expect(ctx.prisma.postShares.map((r) => r.channel)).toEqual(["legacy", "legacy"]);
  });

  it("a share without a body after known destinations adds nothing", async () => {
    const ctx = setup();
    await ctx.service.share(SENDER, POST, { channel: "chat", conversationId: chat(1) });
    const old = await ctx.service.share(SENDER, POST);
    expect(old.counted).toBe(false);
    expect((await shown(ctx)).sharesCount).toBe(1);
  });

  it("notifies and pushes the author only the first time a person shares", async () => {
    const ctx = setup();
    const results = [];
    for (let i = 1; i <= 8; i++) {
      results.push(await ctx.service.share(SENDER, POST, { channel: "chat", conversationId: chat(i) }));
    }
    await ctx.service.share(SENDER, POST, { channel: "external" });
    await settle();
    expect(results.map((r) => r.firstShare)).toEqual([true, false, false, false, false, false, false, false]);
    expect(ctx.push.sendPush).toHaveBeenCalledTimes(1);
    expect(ctx.prisma.notifications).toHaveLength(1);
    const triggers = ctx.kafka.send.mock.calls.filter(([topic]) => topic === "notification.trigger");
    expect(triggers).toHaveLength(1);

    // A second person is a second notice.
    await ctx.service.share("301", POST, { channel: "chat", conversationId: chat(9) });
    await settle();
    expect(ctx.push.sendPush).toHaveBeenCalledTimes(2);
  });

  it("no notice when the author shares their own post", async () => {
    const ctx = setup();
    await ctx.service.share(AUTHOR, POST, { channel: "chat", conversationId: chat(1) });
    await settle();
    expect(ctx.push.sendPush).not.toHaveBeenCalled();
    expect(ctx.prisma.notifications).toHaveLength(0);
  });

  it("the people who shared stay apart from the number shown", async () => {
    const ctx = setup();
    for (let i = 1; i <= 8; i++) {
      await ctx.service.share(SENDER, POST, { channel: "chat", conversationId: chat(i) });
    }
    await ctx.service.share("301", POST);
    const counts = await shown(ctx);
    expect(counts.sharesCount).toBe(9);
    expect(counts.sharersCount).toBe(2);
    expect((await ctx.service.getInteractionCounts(POST)).sharesCount).toBe(9);
  });

  it(`one person adds at most ${MAX_TARGETS_PER_POST} destinations to one post`, async () => {
    const ctx = setup();
    for (let i = 1; i <= MAX_TARGETS_PER_POST + 5; i++) {
      await ctx.service.share(SENDER, POST, { channel: "chat", conversationId: chat(i) });
    }
    expect((await shown(ctx)).sharesCount).toBe(MAX_TARGETS_PER_POST);
    // The cap is per person: someone else still counts.
    await ctx.service.share("301", POST, { channel: "chat", conversationId: chat(1) });
    expect((await shown(ctx)).sharesCount).toBe(MAX_TARGETS_PER_POST + 1);
  });
});

describe("the body of POST /posts/:id/share", () => {
  // The global pipe of main.ts.
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: false,
    transformOptions: { enableImplicitConversion: true },
  });
  const meta: ArgumentMetadata = { type: "body", metatype: ShareDto, data: undefined };
  const check = (body: unknown) => pipe.transform(body, meta);

  it("accepts what the app sends, and no body at all", async () => {
    await expect(check({ channel: "chat", conversationId: chat(1) })).resolves.toBeDefined();
    await expect(check({ channel: "external" })).resolves.toBeDefined();
    await expect(check({ channel: "link" })).resolves.toBeDefined();
    await expect(check({ channel: "chat" })).resolves.toBeDefined();
    await expect(check(undefined)).resolves.toBeDefined();
    await expect(check({})).resolves.toBeDefined();
  });

  it("refuses an unknown channel and a conversation id that is not a uuid", async () => {
    await expect(check({ channel: "legacy" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(check({ channel: "sms" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(check({ channel: "chat", conversationId: "abc" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      check({ channel: "chat", conversationId: "x".repeat(5000) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("drops fields it does not know", async () => {
    const dto = await check({ channel: "link", userId: "1" });
    expect(dto).toEqual(expect.objectContaining({ channel: "link" }));
    expect((dto as any).userId).toBeUndefined();
  });

  it("the endpoint hands its body to the pipe as a ShareDto", () => {
    // An optional parameter would be typed Object, and the pipe would let
    // anything through without a word.
    const types = Reflect.getMetadata("design:paramtypes", InteractionsController.prototype, "share");
    expect(types[2]).toBe(ShareDto);
  });

  it("refuses a conversation id outside a chat", () => {
    expect(() => shareTargetOf({ channel: "link", conversationId: chat(1) })).toThrow(
      BadRequestException,
    );
    expect(() => shareTargetOf({ conversationId: chat(1) })).toThrow(BadRequestException);
  });

  it("keys a share by its channel and its chat", () => {
    expect(shareTargetOf(undefined)).toEqual({ channel: "legacy", targetKey: "" });
    expect(shareTargetOf({})).toEqual({ channel: "legacy", targetKey: "" });
    expect(shareTargetOf({ channel: "external" })).toEqual({ channel: "external", targetKey: "" });
    expect(shareTargetOf({ channel: "chat", conversationId: chat(1).toUpperCase() })).toEqual({
      channel: "chat",
      targetKey: chat(1),
    });
  });
});
