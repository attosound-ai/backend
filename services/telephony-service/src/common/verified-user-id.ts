import { UnauthorizedException } from "@nestjs/common";
import * as jwt from "jsonwebtoken";

/**
 * The user behind a request, only from a JWT signed with our secret.
 *
 * Oct 12 2026: the controllers fell back to base64 decoding the Bearer token
 * WITHOUT checking its signature whenever JwtUserIdMiddleware had dropped
 * X-User-ID. Kong does not verify JWTs for /telephony, so a token with any
 * `sub` and a made up signature listed that user's calls and projects and
 * minted a Voice token for their identity (verified against production with
 * our own test account). Now the signature is always checked.
 *
 * An expired token signed by us is still accepted for EXPIRED_GRACE_S: the
 * fallback existed because the app sometimes asks for a Voice token with an
 * expired session token (5 times in the 8 days of logs, a VoIP push waking a
 * backgrounded app), and old builds cannot be changed. Signed by us means it
 * was issued to that user; past the grace it is refused.
 */
export const EXPIRED_GRACE_S = 30 * 24 * 60 * 60;

function subOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  for (const v of [p.sub, p.user_id]) {
    if (typeof v === "string" && v) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** The verified user id, or null. Never trusts an unsigned or foreign token. */
export function verifiedUserIdFromBearer(
  authHeader: string | undefined,
  secret: string = process.env.JWT_SECRET || "",
  nowS: number = Math.floor(Date.now() / 1000),
): string | null {
  if (!secret || !authHeader?.startsWith("Bearer ")) return null;
  try {
    const payload = jwt.verify(authHeader.slice(7), secret, {
      ignoreExpiration: true,
    }) as jwt.JwtPayload;
    if (typeof payload.exp === "number" && nowS - payload.exp > EXPIRED_GRACE_S) {
      return null;
    }
    return subOf(payload);
  } catch {
    return null;
  }
}

/**
 * X-User-ID is only present when JwtUserIdMiddleware set it from a verified,
 * unexpired token (it deletes any value the client sent). Otherwise the
 * Bearer token must verify here.
 */
export function resolveVerifiedUserId(
  headerUserId: string | undefined,
  authHeader: string | undefined,
): string {
  if (headerUserId) return headerUserId;
  const uid = verifiedUserIdFromBearer(authHeader);
  if (uid) return uid;
  throw new UnauthorizedException("User ID not found");
}
