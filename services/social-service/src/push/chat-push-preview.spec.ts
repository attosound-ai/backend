import {
  chatPushPreview,
  formatDuration,
  NAME_PREVIEW_MAX,
  TEXT_PREVIEW_MAX,
} from "./chat-push-preview";

const VIDEO_URL =
  "https://res.cloudinary.com/atto/video/upload/v1759700000/chat/abc123.mp4";
const IMAGE_URL =
  "https://res.cloudinary.com/atto/image/upload/v1759700000/chat/abc123.jpg";
const AUDIO_URL =
  "https://res.cloudinary.com/atto/video/upload/v1759700000/chat/voice.m4a";
const FILE_URL =
  "https://res.cloudinary.com/atto/raw/upload/v1759700000/chat/report.pdf";

/** No preview may ever carry the address of a file. */
function expectNoUrl(preview: string | undefined): void {
  expect(preview).toBeDefined();
  expect(preview).not.toMatch(/:\/\//);
  expect(preview).not.toContain("cloudinary");
}

describe("chatPushPreview", () => {
  describe("text", () => {
    it("shows the text as written", () => {
      expect(chatPushPreview("text", "see you at 8")).toBe("see you at 8");
    });

    it("keeps a pasted link, because people do send links", () => {
      expect(chatPushPreview("text", "https://attosound.com/x")).toBe(
        "https://attosound.com/x",
      );
      expect(chatPushPreview("text", VIDEO_URL)).toBe(VIDEO_URL);
    });

    it("reads a missing type as text, the default of the chat service", () => {
      expect(chatPushPreview(undefined, "hello")).toBe("hello");
      expect(chatPushPreview(null, "hello")).toBe("hello");
      expect(chatPushPreview("", "hello")).toBe("hello");
      expect(chatPushPreview("  ", "https://a.co/b")).toBe("https://a.co/b");
    });

    it("keeps the 100 character limit the push always had", () => {
      const exact = "a".repeat(TEXT_PREVIEW_MAX);
      expect(chatPushPreview("text", exact)).toBe(exact);
      expect(chatPushPreview("text", exact + "b")).toBe(exact + "…");
    });

    it("does not cut an emoji in half at the limit", () => {
      const text = "a".repeat(TEXT_PREVIEW_MAX - 1) + "😀 and more";
      expect(chatPushPreview("text", text)).toBe(
        "a".repeat(TEXT_PREVIEW_MAX - 1) + "…",
      );
    });

    it("has nothing to show without content", () => {
      expect(chatPushPreview("text", "")).toBeUndefined();
      expect(chatPushPreview("text", undefined)).toBeUndefined();
      expect(chatPushPreview("text", null)).toBeUndefined();
    });
  });

  describe("media, with the labels of the app", () => {
    it("image", () => {
      expect(chatPushPreview("image", IMAGE_URL)).toBe("📷 Photo");
    });

    it("video (the reported bug: the body was the Cloudinary URL)", () => {
      expect(chatPushPreview("video", VIDEO_URL)).toBe("📹 Video");
      expect(
        chatPushPreview("video", VIDEO_URL, { durationMs: 9000, width: 720 }),
      ).toBe("📹 Video");
    });

    it("video note", () => {
      expect(chatPushPreview("video_note", VIDEO_URL)).toBe("🎥 Video note");
    });

    it("location", () => {
      expect(chatPushPreview("location", "4.6097,-74.0817")).toBe(
        "📍 Location",
      );
    });

    it("shared post, whose content is the link of the post", () => {
      expect(
        chatPushPreview("post", "https://atto.sound/post/42", {
          post: { id: "42", type: "audio", coverUrl: IMAGE_URL },
          caption: "listen to this",
        }),
      ).toBe("🎵 Post");
    });

    it("ignores case and spaces around the type", () => {
      expect(chatPushPreview("VIDEO", VIDEO_URL)).toBe("📹 Video");
      expect(chatPushPreview(" Image ", IMAGE_URL)).toBe("📷 Photo");
    });

    it("needs no content and no metadata", () => {
      expect(chatPushPreview("image", undefined)).toBe("📷 Photo");
      expect(chatPushPreview("video", "", null)).toBe("📹 Video");
      expect(chatPushPreview("video_note", null, undefined)).toBe(
        "🎥 Video note",
      );
      expect(chatPushPreview("post", null)).toBe("🎵 Post");
    });
  });

  describe("audio", () => {
    it("is a voice note", () => {
      expect(chatPushPreview("audio", AUDIO_URL)).toBe("🎤 Voice note");
      expect(chatPushPreview("audio", AUDIO_URL, null)).toBe("🎤 Voice note");
      expect(chatPushPreview("audio", AUDIO_URL, {})).toBe("🎤 Voice note");
    });

    it("adds the length when it is known", () => {
      expect(chatPushPreview("audio", AUDIO_URL, { durationMs: 12000 })).toBe(
        "🎤 Voice note (0:12)",
      );
      expect(chatPushPreview("audio", AUDIO_URL, { durationMs: 5000 })).toBe(
        "🎤 Voice note (0:05)",
      );
      expect(chatPushPreview("audio", AUDIO_URL, { durationMs: 62000 })).toBe(
        "🎤 Voice note (1:02)",
      );
      expect(chatPushPreview("audio", AUDIO_URL, { durationMs: 754000 })).toBe(
        "🎤 Voice note (12:34)",
      );
    });

    it("reads metadata that arrives as JSON text", () => {
      expect(
        chatPushPreview("audio", AUDIO_URL, '{"durationMs":62000}'),
      ).toBe("🎤 Voice note (1:02)");
    });

    it("ignores a length that is zero, negative or not a number", () => {
      for (const durationMs of [
        0,
        -5000,
        NaN,
        Infinity,
        -Infinity,
        null,
        undefined,
        "",
        "soon",
        {},
        [],
        true,
      ]) {
        expect(chatPushPreview("audio", AUDIO_URL, { durationMs })).toBe(
          "🎤 Voice note",
        );
      }
    });

    it("ignores metadata that is not an object", () => {
      for (const metadata of ["", "not json", "[1,2]", "{broken", 7, [], true]) {
        expect(chatPushPreview("audio", AUDIO_URL, metadata)).toBe(
          "🎤 Voice note",
        );
      }
    });
  });

  describe("file", () => {
    it("shows the file name", () => {
      expect(
        chatPushPreview("file", FILE_URL, { fileName: "Contract v2.pdf" }),
      ).toBe("📎 Contract v2.pdf");
    });

    it("falls back to File without a usable name", () => {
      expect(chatPushPreview("file", FILE_URL)).toBe("📎 File");
      expect(chatPushPreview("file", FILE_URL, {})).toBe("📎 File");
      expect(chatPushPreview("file", FILE_URL, { fileName: "" })).toBe(
        "📎 File",
      );
      expect(chatPushPreview("file", FILE_URL, { fileName: "   " })).toBe(
        "📎 File",
      );
      expect(chatPushPreview("file", FILE_URL, { fileName: 42 })).toBe(
        "📎 File",
      );
    });

    it("never shows a name that is an address", () => {
      expect(chatPushPreview("file", FILE_URL, { fileName: FILE_URL })).toBe(
        "📎 File",
      );
    });

    it("drops the folders and the line breaks of a name", () => {
      expect(
        chatPushPreview("file", FILE_URL, {
          fileName: "/var/mobile/Containers/tmp/song\n master.wav",
        }),
      ).toBe("📎 song master.wav");
      expect(
        chatPushPreview("file", FILE_URL, { fileName: "C:\\docs\\a.txt" }),
      ).toBe("📎 a.txt");
    });

    it("shortens a very long name and keeps its extension", () => {
      const preview = chatPushPreview("file", FILE_URL, {
        fileName: "a".repeat(300) + ".pdf",
      });
      const name = preview!.slice("📎 ".length);
      expect(Array.from(name)).toHaveLength(NAME_PREVIEW_MAX);
      expect(name).toBe("a".repeat(NAME_PREVIEW_MAX - 5) + "….pdf");
    });

    it("shortens a very long name that has no extension", () => {
      const preview = chatPushPreview("file", FILE_URL, {
        fileName: "b".repeat(300),
      });
      expect(preview).toBe("📎 " + "b".repeat(NAME_PREVIEW_MAX - 1) + "…");
    });

    it("leaves a name at the limit untouched", () => {
      const fileName = "c".repeat(NAME_PREVIEW_MAX - 4) + ".wav";
      expect(chatPushPreview("file", FILE_URL, { fileName })).toBe(
        `📎 ${fileName}`,
      );
    });
  });

  describe("contact", () => {
    it("shows the name carried by the metadata", () => {
      expect(
        chatPushPreview("contact", "{}", {
          contact: { name: "Larry Stone", phone: "+18605550100" },
        }),
      ).toBe("👤 Contact: Larry Stone");
    });

    it("shows the name carried by the JSON content", () => {
      expect(
        chatPushPreview(
          "contact",
          JSON.stringify({ name: "Larry Stone", phone: "+18605550100" }),
        ),
      ).toBe("👤 Contact: Larry Stone");
    });

    it("never shows the phone or the raw JSON", () => {
      const content = JSON.stringify({ phone: "+18605550100" });
      expect(chatPushPreview("contact", content)).toBe("👤 Contact");
      expect(chatPushPreview("contact", content, { contact: {} })).toBe(
        "👤 Contact",
      );
    });

    it("falls back to Contact when nothing can be read", () => {
      expect(chatPushPreview("contact", "{}")).toBe("👤 Contact");
      expect(chatPushPreview("contact", "not json")).toBe("👤 Contact");
      expect(chatPushPreview("contact", undefined)).toBe("👤 Contact");
      expect(chatPushPreview("contact", '{"name":"   "}')).toBe("👤 Contact");
      expect(chatPushPreview("contact", '{"name":7}')).toBe("👤 Contact");
    });

    it("shortens a very long name", () => {
      const preview = chatPushPreview("contact", "{}", {
        contact: { name: "n".repeat(200) },
      });
      expect(preview).toBe(
        "👤 Contact: " + "n".repeat(NAME_PREVIEW_MAX - 1) + "…",
      );
    });
  });

  describe("a type this service does not know", () => {
    it("is an attachment when its content is an address", () => {
      expect(chatPushPreview("sticker", IMAGE_URL)).toBe("📎 Attachment");
      expect(chatPushPreview("gif", "http://example.com/a.gif")).toBe(
        "📎 Attachment",
      );
      expect(chatPushPreview("gif", "  HTTPS://EXAMPLE.COM/a.gif ")).toBe(
        "📎 Attachment",
      );
    });

    it("is an attachment when an address hides inside its content", () => {
      expect(chatPushPreview("sticker", `{"url":"${IMAGE_URL}"}`)).toBe(
        "📎 Attachment",
      );
      expect(chatPushPreview("document", "file:///var/tmp/a.pdf")).toBe(
        "📎 Attachment",
      );
    });

    it("shows content that is not an address, as before", () => {
      expect(chatPushPreview("system", "Larry joined")).toBe("Larry joined");
      expect(chatPushPreview("system", "x".repeat(150))).toBe(
        "x".repeat(TEXT_PREVIEW_MAX) + "…",
      );
    });

    it("has nothing to show without content", () => {
      expect(chatPushPreview("sticker", "")).toBeUndefined();
      expect(chatPushPreview("sticker", undefined)).toBeUndefined();
    });

    it("is not fooled by the name of an object property", () => {
      expect(chatPushPreview("constructor", IMAGE_URL)).toBe("📎 Attachment");
      expect(chatPushPreview("toString", IMAGE_URL)).toBe("📎 Attachment");
      expect(chatPushPreview("__proto__", IMAGE_URL)).toBe("📎 Attachment");
    });
  });

  it("never returns an address for anything that is not text", () => {
    const types = [
      "image",
      "video",
      "video_note",
      "audio",
      "file",
      "contact",
      "location",
      "post",
      "sticker",
      "unknown_future_type",
    ];
    const metadatas = [
      undefined,
      null,
      {},
      { fileName: FILE_URL, durationMs: 1000, contact: { name: IMAGE_URL } },
      { thumbnailUrl: IMAGE_URL, post: { videoUrl: VIDEO_URL } },
    ];
    for (const type of types) {
      for (const metadata of metadatas) {
        for (const content of [VIDEO_URL, `{"name":"${IMAGE_URL}"}`]) {
          expectNoUrl(chatPushPreview(type, content, metadata));
        }
      }
    }
  });
});

describe("formatDuration", () => {
  it("writes minutes and two digit seconds", () => {
    expect(formatDuration(5000)).toBe("0:05");
    expect(formatDuration(12000)).toBe("0:12");
    expect(formatDuration(62000)).toBe("1:02");
    expect(formatDuration(754000)).toBe("12:34");
    expect(formatDuration(60000)).toBe("1:00");
  });

  it("rounds to the second, like the voice note bubble of the app", () => {
    expect(formatDuration(12400)).toBe("0:12");
    expect(formatDuration(12600)).toBe("0:13");
    expect(formatDuration(59600)).toBe("1:00");
  });

  it("keeps counting minutes past the hour", () => {
    expect(formatDuration(3723000)).toBe("62:03");
  });

  it("accepts a number written as text", () => {
    expect(formatDuration("62000")).toBe("1:02");
  });

  it("is null for zero, negative, too short or not a number", () => {
    for (const value of [
      0,
      -1,
      -62000,
      400,
      NaN,
      Infinity,
      -Infinity,
      null,
      undefined,
      "",
      " ",
      "abc",
      {},
      [],
      true,
    ]) {
      expect(formatDuration(value)).toBeNull();
    }
  });
});
