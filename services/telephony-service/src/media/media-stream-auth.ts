import { validateRequest } from "twilio";

/**
 * Who may open /telephony/media-stream.
 *
 * Nov 12 2026: the WebSocket accepted anyone. Whoever connected could send a
 * `start` frame with any callId and userId and then `media` frames, and on
 * `stop` the audio was saved as a segment of that call (and published to
 * Kafka), so a stranger could put audio into someone's call recording.
 *
 * Twilio signs the WebSocket handshake with X-Twilio-Signature, the same
 * HMAC SHA1 as webhooks: base64(HMAC(authToken, url + sorted POST params)),
 * where a handshake has no POST params, so only the URL is signed. The URL is
 * the one we gave streams.create: WEBHOOK_BASE_URL with http replaced by ws,
 * plus /telephony/media-stream (see CallsService.startStream). Twilio's docs
 * do not say in writing whether the signed string keeps the wss scheme or
 * uses https, so both are tried, each with and without the port (twilio's
 * own validateRequest does that). All candidates are built from our own
 * configured host and the requested path, never from the Host header, and
 * none can match without the auth token. In log mode the variant that matched
 * is reported, so the first deploy shows which one Twilio really uses.
 *
 * MEDIA_STREAM_SIGNATURE:
 *   log      (default) never refuse; report what enforce would have done.
 *   enforce  refuse a bad or missing signature at the handshake, and drop a
 *            stream whose call is not live (see CallsService.verifyStreamCall).
 */

export type MediaStreamMode = "log" | "enforce";

export function mediaStreamMode(raw: string | undefined): MediaStreamMode {
  return (raw ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "log";
}

/** The URLs Twilio may have signed for this handshake, most likely first. */
export function signedUrlCandidates(
  webhookBaseUrl: string,
  requestUrl: string,
): { variant: string; url: string }[] {
  const base = webhookBaseUrl.replace(/\/+$/, "");
  const path = requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`;
  const wsBase = base.replace(/^http/i, "ws");
  const httpBase = base.replace(/^ws/i, "http");
  const out: { variant: string; url: string }[] = [
    { variant: "ws_scheme", url: `${wsBase}${path}` },
    { variant: "http_scheme", url: `${httpBase}${path}` },
  ];
  // A query string Twilio did not sign (a proxy adding one) must not break it.
  const q = path.indexOf("?");
  if (q >= 0) {
    const bare = path.slice(0, q);
    out.push(
      { variant: "ws_scheme_no_query", url: `${wsBase}${bare}` },
      { variant: "http_scheme_no_query", url: `${httpBase}${bare}` },
    );
  }
  return out;
}

export type SignatureCheck =
  | { valid: true; variant: string }
  | { valid: false; reason: "no_auth_token" | "missing_signature" | "bad_signature" };

export function checkMediaStreamSignature(
  authToken: string | undefined,
  signature: string | string[] | undefined,
  webhookBaseUrl: string,
  requestUrl: string,
): SignatureCheck {
  if (!authToken) return { valid: false, reason: "no_auth_token" };
  const sig = Array.isArray(signature) ? signature[0] : signature;
  if (!sig) return { valid: false, reason: "missing_signature" };
  for (const c of signedUrlCandidates(webhookBaseUrl, requestUrl)) {
    try {
      // wss: is not a scheme URL() knows a default port for, so the "with
      // port" try inside validateRequest is wrong for it, but the "without
      // port" one is exactly the URL; the https candidate covers the rest.
      if (validateRequest(authToken, sig, c.url, {})) {
        return { valid: true, variant: c.variant };
      }
    } catch {
      // A malformed URL is just a candidate that does not match.
    }
  }
  return { valid: false, reason: "bad_signature" };
}
