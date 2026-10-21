/**
 * What a chat message reads like in a push notification, the way WhatsApp
 * does it: a short description of what was sent, never the address of the
 * file. A media message keeps its hosted URL in `content`, so composing the
 * body from `content` alone put a raw Cloudinary link on the lock screen.
 *
 * Pure: no I/O and no dates, so every case is unit tested.
 */

/** Longest text shown before the ellipsis (the limit the push always had). */
export const TEXT_PREVIEW_MAX = 100;
/** Longest file or contact name shown before the ellipsis. */
export const NAME_PREVIEW_MAX = 60;

const ELLIPSIS = "…";

/**
 * Fixed labels of the message types that need nothing else. The wording is
 * the one the app shows in its conversation list (`media.preview*` in the
 * English locale of the app), so the push and the app agree.
 */
const LABELS: Record<string, string> = {
  image: "📷 Photo",
  video: "📹 Video",
  video_note: "🎥 Video note",
  location: "📍 Location",
  post: "🎵 Post",
};

const VOICE_LABEL = "🎤 Voice note";
const FILE_LABEL = "📎 File";
const CONTACT_LABEL = "👤 Contact";
const ATTACHMENT_LABEL = "📎 Attachment";

/**
 * The preview of one chat message for a push body.
 *
 * @param contentType `content_type` of the message; absent reads as text.
 * @param content     the text, or the hosted URL (JSON for a contact).
 * @param metadata    the message metadata, as an object or as JSON text.
 * @returns the preview, or `undefined` when there is nothing to show, so the
 *   caller keeps its generic "sent you a message" body.
 */
export function chatPushPreview(
  contentType: string | null | undefined,
  content: string | null | undefined,
  metadata?: unknown,
): string | undefined {
  const type = normalizeType(contentType);
  const meta = asRecord(metadata);

  // Only text is shown as written, and that includes a pasted link.
  if (type === "text") return textPreview(content);

  const fixed = Object.prototype.hasOwnProperty.call(LABELS, type)
    ? LABELS[type]
    : undefined;
  if (fixed) return fixed;

  switch (type) {
    case "audio": {
      const duration = formatDuration(meta?.durationMs);
      return duration ? `${VOICE_LABEL} (${duration})` : VOICE_LABEL;
    }
    case "file": {
      const name = cleanFileName(meta?.fileName);
      return name ? `📎 ${name}` : FILE_LABEL;
    }
    case "contact": {
      const name = contactName(content, meta);
      return name ? `${CONTACT_LABEL}: ${name}` : CONTACT_LABEL;
    }
    default:
      // A type this service does not know yet. Its content may be a hosted
      // file like the others, and an address is never shown.
      if (typeof content === "string" && containsUrl(content)) {
        return ATTACHMENT_LABEL;
      }
      return textPreview(content);
  }
}

/**
 * Milliseconds as minutes:seconds ("0:05", "12:34"), rounded like the voice
 * note bubble of the app. Anything that is not a positive length is null.
 */
export function formatDuration(durationMs: unknown): string | null {
  const ms =
    typeof durationMs === "number"
      ? durationMs
      : typeof durationMs === "string" && durationMs.trim() !== ""
        ? Number(durationMs)
        : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  if (total < 1) return null;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function normalizeType(contentType: string | null | undefined): string {
  if (typeof contentType !== "string") return "text";
  const type = contentType.trim().toLowerCase();
  return type === "" ? "text" : type;
}

function textPreview(content: string | null | undefined): string | undefined {
  if (typeof content !== "string" || content === "") return undefined;
  return truncate(content, TEXT_PREVIEW_MAX);
}

/** Cut at `max` UTF-16 units without leaving half an emoji at the end. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? max - 1 : max) + ELLIPSIS;
}

/** Any `scheme://` in the text: http, https, and local ones like file://. */
function containsUrl(text: string): boolean {
  return /[a-z][a-z0-9+.-]*:\/\//i.test(text);
}

/** One line, trimmed, or null when it is empty or carries an address. */
function cleanLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/[\p{Cc}\s]+/gu, " ").trim();
  if (line === "" || containsUrl(line)) return null;
  return line;
}

/**
 * The file name without its folders. A long one keeps its extension, which
 * tells more than the middle of the name: "a very long na….pdf".
 */
function cleanFileName(value: unknown): string | null {
  const line = cleanLine(value);
  if (!line) return null;
  const name = (line.split(/[\\/]/).pop() ?? "").trim();
  if (name === "") return null;

  const chars = Array.from(name);
  if (chars.length <= NAME_PREVIEW_MAX) return name;

  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? Array.from(name.slice(dot)) : [];
  // A dot far from the end is part of the name, not an extension.
  if (extension.length < 2 || extension.length > 8) {
    return chars.slice(0, NAME_PREVIEW_MAX - 1).join("") + ELLIPSIS;
  }
  const head = chars.slice(0, NAME_PREVIEW_MAX - extension.length - 1);
  return head.join("") + ELLIPSIS + extension.join("");
}

/** The shared contact's name: the metadata first, then the JSON content. */
function contactName(
  content: string | null | undefined,
  meta: Record<string, unknown> | null,
): string | null {
  const fromMetadata = asRecord(meta?.contact)?.name;
  const fromContent = asRecord(content)?.name;
  const name = cleanLine(fromMetadata) ?? cleanLine(fromContent);
  if (!name) return null;
  const chars = Array.from(name);
  if (chars.length <= NAME_PREVIEW_MAX) return name;
  return chars.slice(0, NAME_PREVIEW_MAX - 1).join("") + ELLIPSIS;
}

/** An object as is, JSON text decoded, anything else null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("{")) return null;
    try {
      return asRecord(JSON.parse(text));
    } catch {
      return null;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}
