// The push module pulls an ESM only SDK that jest does not load; getStats never pushes.
jest.mock("../push/push.service", () => ({ PushService: class {} }));

import { FollowsService } from "./follows.service";

function serviceWith(follows: Array<{ followerId: string; followingId: string }>) {
  const prisma = {
    follow: {
      count: jest.fn(async ({ where }: { where: { followerId?: string; followingId?: string } }) =>
        follows.filter(
          (f) =>
            (where.followerId === undefined || f.followerId === where.followerId) &&
            (where.followingId === undefined || f.followingId === where.followingId),
        ).length,
      ),
    },
  };
  const counts = { getOrCompute: jest.fn(async () => 8) };
  const service = new FollowsService(
    prisma as never,
    counts as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma };
}

const GRAPH = [
  { followerId: "301", followingId: "152" },
  { followerId: "153", followingId: "152" },
  { followerId: "152", followingId: "153" },
];

describe("FollowsService.getStats", () => {
  it("Nov 5: says the viewer follows the profile, so a profile opened from a chat shows Following", async () => {
    const { service } = serviceWith(GRAPH);
    const stats = await service.getStats("152", "301");
    expect(stats).toEqual({ followersCount: 2, followingCount: 1, postsCount: 8, isFollowing: true });
  });

  it("says false when the viewer does not follow the profile", async () => {
    const { service } = serviceWith(GRAPH);
    const stats = await service.getStats("153", "301");
    expect(stats.isFollowing).toBe(false);
  });

  it("leaves isFollowing out for the viewer's own profile and when there is no viewer", async () => {
    const { service } = serviceWith(GRAPH);
    expect(await service.getStats("152", "152")).not.toHaveProperty("isFollowing");
    expect(await service.getStats("152")).not.toHaveProperty("isFollowing");
  });
});
