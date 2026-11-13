import { KafkaConsumer } from "./kafka.consumer";

// The consumer only needs the class as an injection token. The real module
// loads expo-server-sdk, which ships as ES modules that jest does not parse.
jest.mock("../push/push.service", () => ({ PushService: class {} }));

const VIDEO_URL =
  "https://res.cloudinary.com/atto/video/upload/v1759700000/chat/abc123.mp4";

/**
 * `message.sent` from the chat service to the push of the recipient. The
 * body used to be the raw `content`, which for a video is its Cloudinary URL.
 */
describe("KafkaConsumer message.sent push body", () => {
  let sendPush: jest.Mock;
  let createNotification: jest.Mock;
  let consumer: KafkaConsumer;

  beforeEach(() => {
    sendPush = jest.fn().mockResolvedValue(undefined);
    createNotification = jest.fn().mockResolvedValue({});
    consumer = new KafkaConsumer(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { notification: { create: createNotification } } as any,
      { sendPush } as any,
      { getUser: jest.fn().mockResolvedValue({ username: "suicideking" }) } as any,
    );
    // Quiet: the handler logs every message it processes.
    (consumer as any).logger = {
      log: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  });

  /** Deliver one event the way kafkajs does, in the envelope of the chat service. */
  async function deliver(data: Record<string, unknown>): Promise<void> {
    const event = {
      event: "message.sent",
      data: {
        conversation_id: "22222222-2222-2222-2222-222222222222",
        message_id: "11111111-1111-1111-1111-111111111111",
        sender_id: "277",
        recipient_id: "266",
        created_at: "2026-10-06T12:00:00.000000Z",
        ...data,
      },
      timestamp: "2026-10-06T12:00:00.000000Z",
    };
    await (consumer as any).handleMessage({
      topic: "message.sent",
      message: { value: Buffer.from(JSON.stringify(event)) },
    });
    // The push is fire and forget: let its promise chain settle.
    await new Promise((resolve) => setImmediate(resolve));
  }

  function pushBody(): string | undefined {
    expect(sendPush).toHaveBeenCalledTimes(1);
    const [recipientId, type, actorId, actorUsername, referenceId, body] =
      sendPush.mock.calls[0];
    expect(recipientId).toBe("266");
    expect(type).toBe("message");
    expect(actorId).toBe("277");
    expect(actorUsername).toBe("suicideking");
    expect(referenceId).toBe("22222222-2222-2222-2222-222222222222");
    return body;
  }

  it("describes a video instead of showing its URL", async () => {
    await deliver({ content: VIDEO_URL, content_type: "video" });
    expect(pushBody()).toBe("suicideking: 📹 Video");
  });

  it("uses the metadata of the event (voice note length)", async () => {
    await deliver({
      content: VIDEO_URL,
      content_type: "audio",
      metadata: { durationMs: 12000, waveform: [0.2, 0.8] },
    });
    expect(pushBody()).toBe("suicideking: 🎤 Voice note (0:12)");
  });

  it("works without metadata, as events of an older chat service arrive", async () => {
    await deliver({ content: VIDEO_URL, content_type: "file" });
    expect(pushBody()).toBe("suicideking: 📎 File");
  });

  it("still sends a text message as written, a pasted link included", async () => {
    await deliver({ content: "https://attosound.com", content_type: "text" });
    expect(pushBody()).toBe("suicideking: https://attosound.com");
  });

  it("keeps the generic body when there is no content", async () => {
    await deliver({ content_type: "text" });
    expect(pushBody()).toBeUndefined();
  });

  it("still records the notification of the message", async () => {
    await deliver({ content: VIDEO_URL, content_type: "video" });
    expect(createNotification).toHaveBeenCalledWith({
      data: {
        recipientId: "266",
        type: "message",
        actorId: "277",
        referenceId: "22222222-2222-2222-2222-222222222222",
        isRead: false,
      },
    });
  });
});
