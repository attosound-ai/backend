import * as jwt from "jsonwebtoken";

/**
 * Token telephony-service presents to user-service on its server to server
 * routes (GET /users/:id/push-tokens and /users/:id/linked-account-ids).
 *
 * Nov 12 2026: those routes answered anyone, through Kong and through
 * user-service's own public domain. user-service now requires a token signed
 * with the shared JWT_SECRET whose scope is "service", whose issuer is this
 * one and whose life is at most five minutes (see
 * user-service/internal/middleware/internal_caller.go). It names no user, so
 * no route that wants a person accepts it.
 */
export const TELEPHONY_SERVICE_TOKEN_ISSUER =
  "atto-sound-telephony-service-internal";
export const TELEPHONY_SERVICE_TOKEN_SUBJECT = "service:telephony-service";
export const SERVICE_TOKEN_TTL_S = 60;

/** A fresh one minute service token, or null when there is no secret. */
export function internalServiceToken(
  secret: string | undefined,
  nowS: number = Math.floor(Date.now() / 1000),
): string | null {
  if (!secret) return null;
  return jwt.sign(
    {
      sub: TELEPHONY_SERVICE_TOKEN_SUBJECT,
      scope: "service",
      iss: TELEPHONY_SERVICE_TOKEN_ISSUER,
      iat: nowS,
      exp: nowS + SERVICE_TOKEN_TTL_S,
    },
    secret,
    { algorithm: "HS256" },
  );
}

/** Headers for an internal call to user-service. */
export function internalHeaders(
  secret: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = internalServiceToken(secret);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
