import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
// The real PushService loads expo-server-sdk, which jest does not parse.
jest.mock("../push/push.service", () => ({ PushService: class {} }));

import { FeedService } from "./feed.service";
import { ContentUnavailableError } from "../grpc/grpc-clients.service";

/**
 * GET /posts/:id says 404 only when the post is gone, so the app can tell the
 * person it was deleted; a content service that did not answer is a 503
 * (Nov 12 2026, opening a post from a notice).
 */
function serviceWith(getContentOrMissing: jest.Mock): FeedService {
  const grpc = { getContentOrMissing } as any;
  return new FeedService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    grpc,
    {} as any,
    {} as any,
  );
}

describe("FeedService.getPost", () => {
  it("a missing post is a 404", async () => {
    const svc = serviceWith(jest.fn().mockResolvedValue(null));
    await expect(svc.getPost("abc", "1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("content service not answering is a 503, not a 404", async () => {
    const svc = serviceWith(
      jest.fn().mockRejectedValue(new ContentUnavailableError("deadline")),
    );
    await expect(svc.getPost("abc", "1")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("any other error is not swallowed", async () => {
    const svc = serviceWith(jest.fn().mockRejectedValue(new TypeError("boom")));
    await expect(svc.getPost("abc", "1")).rejects.toBeInstanceOf(TypeError);
  });
});
