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
