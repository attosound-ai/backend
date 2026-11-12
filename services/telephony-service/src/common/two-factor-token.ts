/**
 * The 2FA temporary token is handed out after the password alone, before the
 * second factor, and is signed with the shared secret. It is never a session
 * (Nov 12 2026): until then telephony read it as one, expired or not for up
 * to 30 days. Old shape: only the issuer. New shape: issuer and scope.
 */
export const ISSUER_TWO_FACTOR = "atto-sound-2fa";
export const SCOPE_TWO_FACTOR_PENDING = "2fa_pending";

export function isTwoFactorPendingToken(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return p.iss === ISSUER_TWO_FACTOR || p.scope === SCOPE_TWO_FACTOR_PENDING;
}
