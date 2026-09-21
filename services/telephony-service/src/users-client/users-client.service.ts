import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CacheService } from "../cache/cache.service";

const CACHE_TTL_SECONDS = 300; // 5 minutes
const NEGATIVE_CACHE_TTL_SECONDS = 60; // 1 minute for misses
const NEGATIVE_CACHE_VALUE = "__missing__";

/**
 * Read-through HTTP client for user-service public profile endpoint.
 *
 * Used by the Twilio outgoing-call webhook to enrich the TwiML
 * `<Client>` invitation with a `DisplayName` parameter, so the
 * recipient's iOS CallKit / Android notification banner shows
 * `@username` instead of the raw `client:user-{id}` identity.
 *
 * Single Responsibility: resolve a userId → username, fast and
 * fail-soft. Network errors / timeouts return `null`; the caller
 * falls back to the existing `from` identity, which means the only
 * regression on failure is "looks the same as before this feature".
 */
@Injectable()
export class UsersClientService {
  private readonly logger = new Logger(UsersClientService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    config: ConfigService,
    private readonly cache: CacheService,
  ) {
    this.baseUrl = config.get<string>("userService.url") ?? "";
    this.timeoutMs = config.get<number>("userService.timeoutMs") ?? 500;
  }

  /**
   * Resolve a numeric userId → username.
   * Returns `null` for unknown users, network errors, or timeouts —
   * never throws. Twilio webhooks are latency-sensitive so the
   * timeout is intentionally tight (configured via USER_SERVICE_TIMEOUT_MS).
   *
   * Caches both hits (5 min) and misses (1 min, sentinel value) to
   * absorb webhook bursts during a phone-call storm without hammering
   * user-service.
   */
  async getUsernameById(userId: string): Promise<string | null> {
    if (!userId) return null;

    const cacheKey = `users:username:${userId}`;
    const cached = await this.cache.get<string>(cacheKey);
    if (cached === NEGATIVE_CACHE_VALUE) return null;
    if (cached) return cached;

    const username = await this.fetchUsername(userId);

    if (username) {
      await this.cache.set(cacheKey, username, CACHE_TTL_SECONDS);
      return username;
    }

    await this.cache.set(
      cacheKey,
      NEGATIVE_CACHE_VALUE,
      NEGATIVE_CACHE_TTL_SECONDS,
    );
    return null;
  }

  /**
   * Resolve the full set of linked account IDs for a user (representative
   * + every managed creator under the same representative). Used by the
   * Twilio incoming-call webhook to fan out `<Dial><Client>...</Client></Dial>`
   * across all reachable identities for a device — without this, a PSTN
   * call to one bridge only rings the currently-registered Voice SDK
   * identity, dropping calls to the user's linked accounts.
   *
   * Fail-soft contract: on any error (timeout, network, 404, missing
   * endpoint pre-deploy) returns a single-element array `[Number(userId)]`
   * so the webhook keeps emitting the legacy single-client TwiML. Never
   * throws. Caller can treat the result as the authoritative target set.
   *
   * Hit cache 5 min, miss cache 1 min, same TTLs as getUsernameById.
   */
  async getLinkedAccountIds(userId: string): Promise<number[]> {
    const fallback = (): number[] => {
      const n = Number(userId);
      return Number.isFinite(n) && n > 0 ? [n] : [];
    };
    if (!userId) return fallback();

    const cacheKey = `users:linked:${userId}`;
    const cached = await this.cache.get<number[] | string>(cacheKey);
    if (cached === NEGATIVE_CACHE_VALUE) return fallback();
    if (Array.isArray(cached) && cached.length > 0) return cached;

    const ids = await this.fetchLinkedAccountIds(userId);
    if (ids && ids.length > 0) {
      await this.cache.set(cacheKey, ids, CACHE_TTL_SECONDS);
      return ids;
    }

    await this.cache.set(
      cacheKey,
      NEGATIVE_CACHE_VALUE,
      NEGATIVE_CACHE_TTL_SECONDS,
    );
    return fallback();
  }

  private async fetchLinkedAccountIds(
    userId: string,
  ): Promise<number[] | null> {
    if (!this.baseUrl) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(
        `${this.baseUrl}/users/${userId}/linked-account-ids`,
        { signal: controller.signal, headers: { Accept: "application/json" } },
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        this.logger.warn(
          "linked-account-ids lookup non-OK for userId=%s: %d",
          userId,
          res.status,
        );
        return null;
      }
      const payload = (await res.json()) as unknown;
      return this.extractLinkedIds(payload);
    } catch (err) {
      this.logger.warn(
        "linked-account-ids lookup failed for userId=%s: %s",
        userId,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Tolerate two possible response shapes:
   *  - `{ data: { userIds: [...] } }` (envelope used by APIResponse)
   *  - `{ userIds: [...] }`           (raw shape)
   * Coerce every entry to a finite positive number; drop everything else.
   */
  private extractLinkedIds(payload: unknown): number[] | null {
    if (!payload || typeof payload !== "object") return null;
    const obj = payload as Record<string, unknown>;
    const raw =
      (obj.userIds as unknown) ??
      (obj.data as Record<string, unknown> | undefined)?.userIds;
    if (!Array.isArray(raw)) return null;
    const ids = raw
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0);
    return ids.length > 0 ? ids : null;
  }

  /**
   * Fetch active Expo push tokens for a user. Used by the missed-call
   * fallback path: when an inbound dial fails to reach the Voice SDK, we
   * send a regular APNS/FCM notification through Expo so the user still
   * sees a "missed call from X" entry instead of the call silently
   * vanishing.
   *
   * Fail-soft: on any error (network, 404, missing endpoint) returns an
   * empty array so the caller skips sending without surfacing an error.
   * No cache — the table is small per user and `is_active` can flip
   * between requests (token rotation, logout), so a stale cache is worse
   * than the extra round-trip.
   */
  async getActivePushTokens(
    userId: string,
  ): Promise<Array<{ token: string; platform: string; deviceId: string }>> {
    if (!userId || !this.baseUrl) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/users/${userId}/push-tokens`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [];
      const payload = (await res.json()) as unknown;
      return this.extractPushTokens(payload);
    } catch (err) {
      this.logger.warn(
        "push-tokens lookup failed for userId=%s: %s",
        userId,
        err instanceof Error ? err.message : String(err),
      );
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private extractPushTokens(
    payload: unknown,
  ): Array<{ token: string; platform: string; deviceId: string }> {
    if (!payload || typeof payload !== "object") return [];
    const obj = payload as Record<string, unknown>;
    const raw =
      (obj.tokens as unknown) ??
      (obj.data as Record<string, unknown> | undefined)?.tokens;
    if (!Array.isArray(raw)) return [];
    const out: Array<{ token: string; platform: string; deviceId: string }> =
      [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const token = typeof e.token === "string" ? e.token : null;
      if (!token) continue;
      out.push({
        token,
        platform: typeof e.platform === "string" ? e.platform : "",
        deviceId: typeof e.deviceId === "string" ? e.deviceId : "",
      });
    }
    return out;
  }

  private async fetchUsername(userId: string): Promise<string | null> {
    if (!this.baseUrl) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/users/${userId}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (res.status === 404) return null;
      if (!res.ok) {
        this.logger.warn(
          "user lookup non-OK for userId=%s: %d",
          userId,
          res.status,
        );
        return null;
      }

      const payload = (await res.json()) as unknown;
      return this.extractUsername(payload);
    } catch (err) {
      this.logger.warn(
        "user lookup failed for userId=%s: %s",
        userId,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Tolerate two possible response shapes:
   *  - `{ data: { username, ... } }`  (envelope used by other services)
   *  - `{ username, ... }`            (raw shape)
   * If user-service ever changes its response wrapper we keep working
   * without a coordinated deploy.
   */
  private extractUsername(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const obj = payload as Record<string, unknown>;
    const direct = obj.username;
    if (typeof direct === "string" && direct.length > 0) return direct;

    const nested = (obj.data as Record<string, unknown> | undefined)?.username;
    if (typeof nested === "string" && nested.length > 0) return nested;

    return null;
  }
}
