import { ForbiddenException, NotFoundException } from "@nestjs/common";
// The real PushService loads expo-server-sdk, which jest does not parse.
jest.mock("../push/push.service", () => ({ PushService: class {} }));

import { InteractionsService } from "./interactions.service";

/**
 * A reply is edited and deleted like any comment: only its own author may,
 * whoever wrote the comment above it (Nov 12 2026, David could not edit or
 * delete replies; the block was the app's menu, never this service).
 */
const REPLY = {
  id: "r1",
  userId: "7",
  contentId: "post1",
  parentId: "c1",
  text: "hola",
  isDeleted: false,
  isEdited: false,
  createdAt: new Date("2026-11-12T10:00:00Z"),
};

function build(found: typeof REPLY | null) {
  const prisma = {
    comment: {
      findUnique: jest.fn().mockResolvedValue(found),
      update: jest
        .fn()
        .mockImplementation(({ data }) => Promise.resolve({ ...REPLY, ...data })),
      count: jest.fn().mockResolvedValue(4),
    },
  };
  const counts = { set: jest.fn().mockResolvedValue(undefined) };
  const grpc = { getUser: jest.fn().mockResolvedValue(null) };
  const kafka = { send: jest.fn().mockResolvedValue(undefined) };
  const svc = new InteractionsService(
    prisma as any,
    counts as any,
    grpc as any,
    kafka as any,
    {} as any,
  );
  return { svc, prisma, counts, kafka };
}

describe("editing and deleting a reply", () => {
  it("its author edits it, under somebody else's comment", async () => {
    const { svc, prisma } = build(REPLY);
    const out = await svc.editComment("7", "r1", "editado");
    expect(prisma.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1" } }),
    );
    expect(out.comment).toBe("editado");
    expect(out.parentId).toBe("c1");
    expect(out.isEdited).toBe(true);
  });

  it("its author deletes it and the post count is counted again", async () => {
    const { svc, prisma, counts, kafka } = build(REPLY);
    await svc.deleteComment("7", "r1");
    expect(prisma.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1" },
        data: expect.objectContaining({ isDeleted: true }),
      }),
    );
    expect(counts.set).toHaveBeenCalledWith("comments", "post1", 4);
    expect(kafka.send).toHaveBeenCalledWith(
      "interaction.deleted",
      expect.objectContaining({ id: "r1", content_id: "post1" }),
    );
  });

  it("nobody else may edit or delete it", async () => {
    const { svc } = build(REPLY);
    await expect(svc.editComment("9", "r1", "x")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.deleteComment("9", "r1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("a reply already deleted is not found", async () => {
    const { svc } = build({ ...REPLY, isDeleted: true });
    await expect(svc.deleteComment("7", "r1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
