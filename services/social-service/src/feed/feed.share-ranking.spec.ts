// The real PushService loads expo-server-sdk, which jest does not parse.
jest.mock("../push/push.service", () => ({ PushService: class {} }));

import { FeedService } from "./feed.service";
import { InteractionCounts } from "../interactions/interactions.service";

/**
 * Nov 18 2026: the number a post shows counts every destination it was sent
 * to, but the ranking keeps counting people (the SHARE rows), so one person
 * sending a post to 40 chats cannot lift it above a post three people shared.
 */
describe("feed ranking counts people who shared, not destinations", () => {
  const now = new Date().toISOString();
  const content = (id: string) => ({
    id,
    author_id: "500",
    content_type: "image",
    text_content: "",
    file_paths: [],
    metadata: {},
    tags: [],
    created_at: now,
    updated_at: now,
  });

  function serviceWith(counts: Record<string, InteractionCounts>) {
    const contents = [content("sent-to-40-chats"), content("shared-by-3")];
    const grpc = {
      listRecentContent: jest.fn().mockResolvedValue({ contents, meta: { has_more: false } }),
      getContentByAuthor: jest.fn().mockResolvedValue({ contents: [], meta: {} }),
      getContentBatch: jest.fn().mockResolvedValue({ contents }),
      getUsersBatch: jest.fn().mockResolvedValue([{ id: "500", username: "author" }]),
    };
    const pipeline = { zadd: jest.fn(), zremrangebyrank: jest.fn(), expire: jest.fn(), exec: jest.fn() };
    const redis = { client: () => ({ pipeline: () => pipeline }) };
    const interactions = {
      getInteractionCountsBatch: jest.fn().mockResolvedValue(new Map(Object.entries(counts))),
      getUserInteractionsBatch: jest.fn().mockResolvedValue(new Map()),
    };
    const follows = { getFollowingIds: jest.fn().mockResolvedValue([]) };
    return new FeedService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      redis as any,
      grpc as any,
      interactions as any,
      follows as any,
    );
  }

  const base = { likesCount: 0, commentsCount: 0, repostsCount: 0 };

  it("three people beat one person sending to forty chats", async () => {
    const svc = serviceWith({
      "sent-to-40-chats": { ...base, sharesCount: 40, sharersCount: 1 },
      "shared-by-3": { ...base, sharesCount: 3, sharersCount: 3 },
    });
    const { posts } = await svc.getFeed("1", 0, 10);
    expect(posts.map((p) => p.id)).toEqual(["shared-by-3", "sent-to-40-chats"]);
    // The cards still show every destination.
    expect(posts.find((p) => p.id === "sent-to-40-chats")!.interactions.sharesCount).toBe(40);
    expect((posts[0].interactions as any).sharersCount).toBeUndefined();
  });

  it("the same people give the same rank whatever the destinations", async () => {
    const svc = serviceWith({
      "sent-to-40-chats": { ...base, sharesCount: 40, sharersCount: 2 },
      "shared-by-3": { ...base, sharesCount: 2, sharersCount: 2, likesCount: 1 },
    });
    const { posts } = await svc.getFeed("1", 0, 10);
    // Equal people; the one like decides, not the 40 destinations.
    expect(posts[0].id).toBe("shared-by-3");
  });
});
