import { createHmac } from "crypto";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  checkMediaStreamSignature,
  mediaStreamMode,
  signedUrlCandidates,
} from "./media-stream-auth";
import { MediaGateway } from "./media.gateway";
import { CallsService } from "../calls/calls.service";

Logger.overrideLogger(false);

/**
 * Nov 12 2026: /telephony/media-stream accepted any WebSocket, so anyone
 * could feed audio into a call's recording. These cases fail on the gateway
 * before the fix (it attached the listener for every socket and saved every
 * stop).
 */

const AUTH_TOKEN = "12345678901234567890123456789012";
const BASE = "https://telephony.example.com";
const PATH = "/telephony/media-stream";

/** Exactly what Twilio does: base64(HMAC-SHA1(token, url + sorted params)), no params here. */
function twilioSign(url: string, token = AUTH_TOKEN): string {
  return createHmac("sha1", token).update(Buffer.from(url, "utf-8")).digest("base64");
}

describe("media stream handshake signature", () => {
  it("accepts the signature Twilio computes over the wss URL we hand to streams.create", () => {
    // CallsService.startStream builds the URL as WEBHOOK_BASE_URL with http -> ws.
    const streamUrl = `${BASE.replace("http", "ws")}${PATH}`;
    expect(streamUrl).toBe("wss://telephony.example.com/telephony/media-stream");
    expect(checkMediaStreamSignature(AUTH_TOKEN, twilioSign(streamUrl), BASE, PATH)).toEqual({
      valid: true,
      variant: "ws_scheme",
    });
  });

  it("also accepts it when Twilio signed the https form, or with the default port", () => {
    expect(
      checkMediaStreamSignature(AUTH_TOKEN, twilioSign(`${BASE}${PATH}`), BASE, PATH),
    ).toEqual({ valid: true, variant: "http_scheme" });
    expect(
      checkMediaStreamSignature(
        AUTH_TOKEN,
        twilioSign("https://telephony.example.com:443/telephony/media-stream"),
        BASE,
        PATH,
      ),
    ).toEqual({ valid: true, variant: "http_scheme" });
  });

  it("signs the query string when there is one, and tolerates one Twilio did not sign", () => {
    const withQuery = `${PATH}?callId=abc`;
    expect(
      checkMediaStreamSignature(AUTH_TOKEN, twilioSign(`wss://telephony.example.com${withQuery}`), BASE, withQuery),
    ).toMatchObject({ valid: true, variant: "ws_scheme" });
    expect(
      checkMediaStreamSignature(AUTH_TOKEN, twilioSign(`wss://telephony.example.com${PATH}`), BASE, withQuery),
    ).toMatchObject({ valid: true, variant: "ws_scheme_no_query" });
  });

  it("refuses a missing signature, a forged one, another account's, and another host's", () => {
    const url = `wss://telephony.example.com${PATH}`;
    expect(checkMediaStreamSignature(AUTH_TOKEN, undefined, BASE, PATH)).toEqual({
      valid: false,
      reason: "missing_signature",
    });
    expect(checkMediaStreamSignature(AUTH_TOKEN, "Zm9yZ2Vk", BASE, PATH)).toMatchObject({ valid: false });
    expect(
      checkMediaStreamSignature(AUTH_TOKEN, twilioSign(url, "another-accounts-token-0000000000"), BASE, PATH),
    ).toMatchObject({ valid: false, reason: "bad_signature" });
    expect(
      checkMediaStreamSignature(AUTH_TOKEN, twilioSign(`wss://evil.example.com${PATH}`), BASE, PATH),
    ).toMatchObject({ valid: false, reason: "bad_signature" });
    expect(checkMediaStreamSignature("", twilioSign(url), BASE, PATH)).toEqual({
      valid: false,
      reason: "no_auth_token",
    });
  });

  it("builds candidates from our base URL only, with a trailing slash or not", () => {
    expect(signedUrlCandidates(`${BASE}/`, PATH).map((c) => c.url)).toEqual([
      "wss://telephony.example.com/telephony/media-stream",
      "https://telephony.example.com/telephony/media-stream",
    ]);
  });

  it("defaults to log; only the exact word enforce enforces", () => {
    expect(mediaStreamMode(undefined)).toBe("log");
    expect(mediaStreamMode("")).toBe("log");
    expect(mediaStreamMode("ENFORCE ")).toBe("enforce");
    expect(mediaStreamMode("true")).toBe("log");
  });
});

// ── Gateway ──

type Listener = (event: { data: string }) => void;

function fakeClient() {
  const c = {
    listener: null as Listener | null,
    addEventListener: jest.fn((_: string, l: Listener) => {
      c.listener = l;
    }),
    close: jest.fn(),
  };
  return c;
}

function fakeMedia() {
  const sessions = new Map<string, Record<string, unknown>>();
  return {
    sessions,
    startSession: jest.fn((streamSid: string, callSid: string, callId: string, userId: string, track: string) => {
      sessions.set(streamSid, {
        streamSid, callSid, callId, userId, track,
        inboundChunks: [] as Buffer[], outboundChunks: [] as Buffer[],
        framesLabeledInbound: 0, framesLabeledOutbound: 0, framesMissingLabel: 0, framesLabeledOther: 0,
        firstOutboundTs: null, startTimestamp: 0,
      });
    }),
    appendChunk: jest.fn((streamSid: string, payload: string) => {
      const s = sessions.get(streamSid);
      if (s) (s.inboundChunks as Buffer[]).push(Buffer.from(payload, "base64"));
    }),
    getSession: jest.fn((sid: string) => sessions.get(sid)),
    discardSession: jest.fn((sid: string) => sessions.delete(sid)),
    finalizeSession: jest.fn(async (sid: string) => {
      sessions.delete(sid);
      return { storageBucket: "b", storageKey: "k", durationMs: 20, fileSizeBytes: 1, startMs: 0, endMs: 20 };
    }),
  };
}

function gateway(mode: string | undefined, callOk = true) {
  if (mode === undefined) delete process.env.MEDIA_STREAM_SIGNATURE;
  else process.env.MEDIA_STREAM_SIGNATURE = mode;
  const media = fakeMedia();
  const calls = {
    verifyStreamCall: jest.fn(async () =>
      callOk
        ? { ok: true, reason: "live", twilioStatus: "in-progress" }
        : { ok: false, reason: "call_not_found", twilioStatus: null },
    ),
    getNextSegmentIndex: jest.fn(async () => 1),
    saveSegment: jest.fn(async (d: Record<string, unknown>) => ({ id: "seg-1", ...d })),
  };
  const kafka = { publish: jest.fn() };
  const analytics = { capture: jest.fn() };
  const config = {
    get: (k: string) => (k === "twilio.authToken" ? AUTH_TOKEN : k === "webhookBaseUrl" ? BASE : undefined),
  } as unknown as ConfigService;
  const gw = new MediaGateway(media as never, calls as never, kafka as never, analytics as never, config);
  return { gw, media, calls, kafka, analytics };
}

const signedRequest = (sig?: string) =>
  ({
    url: PATH,
    headers: sig === undefined ? {} : { "x-twilio-signature": sig },
  }) as never;
const GOOD_SIG = twilioSign(`wss://telephony.example.com${PATH}`);

const CALL_SID = `CA${"a".repeat(32)}`;
const frames = (streamSid: string) => ({
  start: JSON.stringify({
    event: "start",
    start: { streamSid, callSid: CALL_SID, tracks: ["inbound", "outbound"], customParameters: { callId: "call-1", userId: "10" } },
  }),
  media: JSON.stringify({ event: "media", streamSid, media: { payload: "AAAA", timestamp: "20", track: "inbound" } }),
  stop: JSON.stringify({ event: "stop", streamSid }),
});

async function send(client: ReturnType<typeof fakeClient>, raw: string) {
  client.listener!({ data: raw });
  // Let the async handler (and the call check) settle.
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

describe("media stream gateway", () => {
  afterEach(() => {
    delete process.env.MEDIA_STREAM_SIGNATURE;
  });

  it("enforce: closes an unsigned socket at the handshake without reading anything", () => {
    const { gw } = gateway("enforce");
    const client = fakeClient();
    gw.handleConnection(client as never, signedRequest());
    expect(client.close).toHaveBeenCalledWith(1008, "unauthorized");
    expect(client.addEventListener).not.toHaveBeenCalled();
  });

  it("enforce: a forged signature is closed too", () => {
    const { gw } = gateway("enforce");
    const client = fakeClient();
    gw.handleConnection(client as never, signedRequest(twilioSign(`wss://telephony.example.com${PATH}`, "x".repeat(32))));
    expect(client.close).toHaveBeenCalledWith(1008, "unauthorized");
  });

  it("enforce: a signed socket for a call that is not live is dropped and nothing is saved", async () => {
    const { gw, media, calls, kafka } = gateway("enforce", false);
    const client = fakeClient();
    gw.handleConnection(client as never, signedRequest(GOOD_SIG));
    const f = frames("MZ1");
    await send(client, f.start);
    await send(client, f.media);
    await send(client, f.stop);
    expect(calls.verifyStreamCall).toHaveBeenCalledWith(CALL_SID, "call-1", "10");
    expect(media.discardSession).toHaveBeenCalledWith("MZ1");
    expect(client.close).toHaveBeenCalledWith(1008, "unauthorized");
    expect(calls.saveSegment).not.toHaveBeenCalled();
    expect(kafka.publish).not.toHaveBeenCalled();
  });

  it("enforce: a signed socket for a live call records as before", async () => {
    const { gw, calls, analytics } = gateway("enforce");
    const client = fakeClient();
    gw.handleConnection(client as never, signedRequest(GOOD_SIG));
    const f = frames("MZ2");
    await send(client, f.start);
    await send(client, f.media);
    await send(client, f.stop);
    expect(client.close).not.toHaveBeenCalled();
    expect(calls.saveSegment).toHaveBeenCalledWith(expect.objectContaining({ callId: "call-1", twilioStreamSid: "MZ2" }));
    expect(analytics.capture).toHaveBeenCalledWith("10", "backend_media_stream_auth", expect.objectContaining({
      stage: "start", signature_valid: true, signature_variant: "ws_scheme", call_ok: true, would_refuse: false,
    }));
  });

  it("log (default): an unsigned socket still records, and says enforce would have refused it", async () => {
    const { gw, calls, analytics } = gateway(undefined, false);
    const client = fakeClient();
    gw.handleConnection(client as never, signedRequest());
    const f = frames("MZ3");
    await send(client, f.start);
    await send(client, f.media);
    await send(client, f.stop);
    expect(client.close).not.toHaveBeenCalled();
    expect(calls.saveSegment).toHaveBeenCalled();
    expect(analytics.capture).toHaveBeenCalledWith(null, "backend_media_stream_auth", expect.objectContaining({
      stage: "handshake", mode: "log", signature_valid: false, signature_reason: "missing_signature", refused: false,
    }));
    expect(analytics.capture).toHaveBeenCalledWith("10", "backend_media_stream_auth", expect.objectContaining({
      stage: "start", mode: "log", would_refuse: true, refused: false, call_reason: "call_not_found",
    }));
  });

  it("in any mode a socket cannot feed or stop another socket's stream", async () => {
    const { gw, media, calls } = gateway(undefined);
    const victim = fakeClient();
    const intruder = fakeClient();
    gw.handleConnection(victim as never, signedRequest(GOOD_SIG));
    gw.handleConnection(intruder as never, signedRequest());
    const v = frames("MZ-VICTIM");
    await send(victim, v.start);
    await send(intruder, v.media);
    await send(intruder, v.stop);
    expect(media.appendChunk).not.toHaveBeenCalled();
    expect(calls.saveSegment).not.toHaveBeenCalled();
    expect(media.sessions.has("MZ-VICTIM")).toBe(true);
  });
});

// ── The call check ──

describe("CallsService.verifyStreamCall", () => {
  function svcWith(row: Record<string, unknown> | null, leg: { status?: string; error?: { status?: number } }) {
    const config = { get: (k: string) => (k === "twilio.accountSid" ? `AC${"0".repeat(32)}` : k === "twilio.authToken" ? AUTH_TOKEN : undefined) } as unknown as ConfigService;
    const callRepo = { findOne: jest.fn(async () => row) };
    const svc = new CallsService({} as never, callRepo as never, {} as never, config, { capture: jest.fn() } as never);
    const fetch = jest.fn(async () => {
      if (leg.error) throw leg.error;
      return { status: leg.status };
    });
    (svc as unknown as { twilioClient: unknown }).twilioClient = { calls: () => ({ fetch }) };
    return svc;
  }
  const CALL_ID = "00000000-0000-4000-8000-000000000001";
  const live = { id: CALL_ID, userId: "10", status: "in-progress", endedAt: null };

  it("passes a live call of that user", async () => {
    await expect(svcWith(live, { status: "in-progress" }).verifyStreamCall(CALL_SID, CALL_ID, "10")).resolves.toMatchObject({ ok: true, reason: "live" });
  });
  it("refuses a made up, foreign, ended or not live call", async () => {
    await expect(svcWith(null, { status: "in-progress" }).verifyStreamCall(CALL_SID, CALL_ID, "10")).resolves.toMatchObject({ ok: false, reason: "call_not_found" });
    await expect(svcWith(live, { status: "in-progress" }).verifyStreamCall(CALL_SID, CALL_ID, "20")).resolves.toMatchObject({ ok: false, reason: "user_mismatch" });
    await expect(svcWith({ ...live, status: "completed", endedAt: new Date() }, { status: "in-progress" }).verifyStreamCall(CALL_SID, CALL_ID, "10")).resolves.toMatchObject({ ok: false });
    await expect(svcWith(live, { status: "completed" }).verifyStreamCall(CALL_SID, CALL_ID, "10")).resolves.toMatchObject({ ok: false, reason: "leg_not_live" });
    await expect(svcWith(live, { error: { status: 404 } }).verifyStreamCall(CALL_SID, CALL_ID, "10")).resolves.toMatchObject({ ok: false, reason: "leg_not_found" });
    await expect(svcWith(live, { status: "in-progress" }).verifyStreamCall("not-a-sid", CALL_ID, "10")).resolves.toMatchObject({ ok: false, reason: "bad_call_sid" });
    await expect(svcWith(live, { status: "in-progress" }).verifyStreamCall(CALL_SID, "x", "10")).resolves.toMatchObject({ ok: false, reason: "bad_call_id" });
  });
  it("lets the database decide when Twilio cannot be reached", async () => {
    await expect(svcWith(live, { error: { status: 500 } }).verifyStreamCall(CALL_SID, CALL_ID, "10")).resolves.toMatchObject({ ok: true, reason: "twilio_unreachable" });
  });
});
