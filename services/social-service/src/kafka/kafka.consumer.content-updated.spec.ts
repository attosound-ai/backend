import { KafkaConsumer } from "./kafka.consumer";

// The consumer only needs the class as an injection token. The real module
// loads expo-server-sdk, which ships as ES modules that jest does not parse.
jest.mock("../push/push.service", () => ({ PushService: class {} }));

/**
 * `content.updated` from content-service. Since Oct 27 2026 the app's edit
 * screen can tag people, and the event carries only the ids that edit tagged
 * for the first time; each of them gets the same mention a new post gives.
 */
describe("KafkaConsumer content.updated tags", () => {
  let sendPushBulk: jest.Mock;
  let createMany: jest.Mock;
  let consumer: KafkaConsumer;

  beforeEach(() => {
    sendPushBulk = jest.fn().mockResolvedValue(undefined);
    createMany = jest.fn().mockResolvedValue({ count: 1 });
    consumer = new KafkaConsumer(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { notification: { createMany } } as any,
      { sendPushBulk } as any,
      { getUser: jest.fn().mockResolvedValue({ username: "suicideking" }) } as any,
    );
    (consumer as any).logger = {
      log: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  });

  async function deliver(data: Record<string, unknown>): Promise<void> {
    const event = {
      event: "content.updated",
      data: {
        content_id: "6ae132fdefc6bc677c7ee9f6",
        author_id: "153",
        updated_at: "2026-10-27T23:29:07Z",
        ...data,
      },
      timestamp: "2026-10-27T23:29:07Z",
    };
    await (consumer as any).handleMessage({
      topic: "content.updated",
      message: { value: Buffer.from(JSON.stringify(event)) },
    });
    // The push is fire and forget: let its promise chain settle.
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("tells a person the edit tagged, as a mention of the post", async () => {
    await deliver({ tagged_user_ids: ["167"] });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          recipientId: "167",
          type: "mention",
          actorId: "153",
          referenceId: "6ae132fdefc6bc677c7ee9f6",
          isRead: false,
        },
      ],
    });
    expect(sendPushBulk).toHaveBeenCalledWith(
      ["167"],
      "mention",
      "153",
      "suicideking",
      "6ae132fdefc6bc677c7ee9f6",
    );
  });

  it("tells nobody for an edit that tagged nobody new, or only the author", async () => {
    await deliver({});
    await deliver({ tagged_user_ids: [] });
    await deliver({ tagged_user_ids: ["153"] });
    expect(createMany).not.toHaveBeenCalled();
    expect(sendPushBulk).not.toHaveBeenCalled();
  });
});
