import { createHash } from "crypto";

/**
 * Whether an EXPIRED session token still belongs to an open session (Nov 12
 * 2026).
 *
 * Telephony accepts an expired session token signed by us for
 * EXPIRED_GRACE_S (30 days, see verified-user-id.ts): a VoIP push can wake
 * the app with an expired token and old builds cannot change. Since a
 * password reset now closes every session of the account, that grace would
 * keep a closed session alive on the calls path for up to 30 days. So the
 * grace only applies after user-service confirms, at POST
 * /auth/session-check, that the session was not closed since.
 *
 * Fresh (unexpired) tokens are never checked: they end on their own within
 * the 15 minutes of the access token, like everywhere else.
 *
 * If user-service does not answer (down, slow), the answer is "unknown" and
 * the caller keeps today's behaviour (accept): an outage must not drop
 * incoming calls.
 */
export type SessionVerdict = "open" | "closed" | "unknown";

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const OPEN_TTL_MS = 60_000;
const CLOSED_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 5000;

export class ExpiredSessionCheck {
  private readonly cache = new Map<
    string,
    { verdict: SessionVerdict; until: number }
  >();

  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
    private readonly timeoutMs = 2500,
    private readonly now: () => number = Date.now,
  ) {}

  async check(token: string): Promise<SessionVerdict> {
    const key = createHash("sha256").update(token).digest("hex");
    const hit = this.cache.get(key);
    if (hit && hit.until > this.now()) return hit.verdict;

    const verdict = await this.ask(token);
    if (verdict !== "unknown") {
      if (this.cache.size >= MAX_ENTRIES) this.cache.clear();
      this.cache.set(key, {
        verdict,
        until: this.now() + (verdict === "open" ? OPEN_TTL_MS : CLOSED_TTL_MS),
      });
    }
    return verdict;
  }

  private async ask(token: string): Promise<SessionVerdict> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/auth/session-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        signal: controller.signal,
      });
      if (!res.ok) return "unknown";
      const body = (await res.json()) as { data?: { valid?: unknown } };
      if (typeof body?.data?.valid !== "boolean") return "unknown";
      return body.data.valid ? "open" : "closed";
    } catch {
      return "unknown";
    } finally {
      clearTimeout(timer);
    }
  }
}
