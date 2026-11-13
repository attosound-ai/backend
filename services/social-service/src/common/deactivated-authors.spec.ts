// expo-server-sdk ships ESM that ts-jest does not transform; the other specs
// stub the push service the same way.
jest.mock("../push/push.service", () => ({ PushService: class {} }));

import { hideDeactivatedAuthors, withoutAuthors } from "./deactivated-authors";
import { FeedService } from "../feed/feed.service";
import { KafkaConsumer } from "../kafka/kafka.consumer";
import { DeactivatedUsersRepository } from "../redis/repositories/deactivated-users.repository";

/** In memory stand in for the Redis SET. */
class MemoryDeactivated extends DeactivatedUsersRepository {
  readonly ids = new Set<string>();
  async add(userIds: string[]) {
    userIds.forEach((id) => this.ids.add(String(id)));
  }
  async remove(userIds: string[]) {
    userIds.forEach((id) => this.ids.delete(String(id)));
  }
  async among(userIds: string[]) {
    return new Set(userIds.map(String).filter((id) => this.ids.has(id)));
  }
}

describe("deletion grace: hide what deactivated accounts authored", () => {
  const posts = [
    { id: "p1", author_id: "280" },
    { id: "p2", author_id: "281" },
    { id: "p3", author_id: 281 as unknown as string },
  ];

  it("withoutAuthors drops every item of a hidden author, numbers or strings", () => {
    expect(withoutAuthors(posts, (p) => p.author_id, new Set(["281"])).map((p) => p.id)).toEqual(["p1"]);
    expect(withoutAuthors(posts, (p) => p.author_id, new Set())).toBe(posts);
  });

  it("hideDeactivatedAuthors hides nothing without a repository", async () => {
    expect(await hideDeactivatedAuthors(posts, (p) => p.author_id, undefined)).toBe(posts);
  });

  it("hideDeactivatedAuthors asks the repository", async () => {
    const repo = new MemoryDeactivated();
    await repo.add(["281"]);
    const out = await hideDeactivatedAuthors(posts, (p) => p.author_id, repo);
    expect(out.map((p) => p.id)).toEqual(["p1"]);
  });

  it("the Kafka events move an account in and out of the hidden set and drop its cached profile", async () => {
    const repo = new MemoryDeactivated();
    const invalidateUserCache = jest.fn().mockResolvedValue(undefined);
    const consumer = new KafkaConsumer(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      { invalidateUserCache } as any,
      repo,
    );
    (consumer as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    await consumer.handleUserDeactivated({ userIds: ["281", "282"] });
    expect([...repo.ids].sort()).toEqual(["281", "282"]);
    expect(invalidateUserCache).toHaveBeenCalledWith("281");

    await consumer.handleUserReactivated({ userIds: ["281"] });
    expect([...repo.ids]).toEqual(["282"]);
    expect(invalidateUserCache).toHaveBeenCalledTimes(3);

    await consumer.handleUserDeactivated({});
    expect([...repo.ids]).toEqual(["282"]);
  });

  function feedWith(repo?: DeactivatedUsersRepository) {
    const grpc = {
      getContent: jest.fn(async (id: string) => ({ id, author_id: id === "p2" ? "281" : "280", created_at: new Date().toISOString() })),
      getContentByAuthor: jest.fn(async () => ({
        contents: [{ id: "p2", author_id: "281", created_at: new Date().toISOString() }],
        meta: { has_more: false, next_cursor: "", total: 1 },
      })),
      getUsersBatch: jest.fn(async (ids: string[]) => ids.map((id) => ({ id, username: `u${id}` }))),
    };
    const interactions = {
      getInteractionCountsBatch: jest.fn(async () => new Map()),
      getUserInteractionsBatch: jest.fn(async () => new Map()),
    };
    const follows = { getFollowingIds: jest.fn(async () => []) };
    const svc = new FeedService(
      {} as any, {} as any, {} as any, {} as any, {} as any,
      grpc as any, interactions as any, follows as any,
      repo,
    );
    return { svc, grpc };
  }

  it("a post of an account in grace answers 404, like a deleted post", async () => {
    const repo = new MemoryDeactivated();
    await repo.add(["281"]);
    const { svc } = feedWith(repo);
    await expect(svc.getPost("p2", "280")).rejects.toThrow("Post not found");
    await expect(svc.getPost("p1", "280")).resolves.toMatchObject({ id: "p1", authorId: "280" });
  });

  it("the profile of an account in grace shows no posts, and shows them again after recovery", async () => {
    const repo = new MemoryDeactivated();
    await repo.add(["281"]);
    const { svc, grpc } = feedWith(repo);
    const hidden = await svc.getUserPosts("281", "280", "", 20);
    expect(hidden.posts).toHaveLength(0);
    expect(grpc.getContentByAuthor).not.toHaveBeenCalled();

    await repo.remove(["281"]);
    const shown = await svc.getUserPosts("281", "280", "", 20);
    expect(shown.posts.map((p) => p.id)).toEqual(["p2"]);
  });
});
