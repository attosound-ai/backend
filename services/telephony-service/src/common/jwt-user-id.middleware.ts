import { Injectable, NestMiddleware, Logger } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import * as jwt from "jsonwebtoken";

/**
 * Verifies the Bearer JWT signature and overrides any client-supplied
 * `X-User-ID` header with the verified `sub` (or `user_id`) claim.
 *
 * Controllers continue to read `@Headers("x-user-id")` for ergonomic
 * dependency injection, but with this middleware the value is guaranteed
 * to come from a JWT signed with the shared secret — never from raw
 * client input. Closes the X-User-ID impersonation vector (Bug #6):
 * previously a client could send their own JWT *plus* `X-User-ID:
 * <victim-id>` and the controllers would happily mint Voice tokens,
 * call records, etc. attributed to the victim.
 *
 * Kong already strips the inbound header at the edge (see
 * gateway/kong.yml.template `request-transformer` plugin) — this
 * middleware is the in-service defense in depth and the source of
 * truth for the value the controllers read.
 *
 * Skipped on:
 *  - Twilio webhook paths (TwilioSignatureGuard handles them) — they
 *    arrive without a Bearer token, the signature is the auth.
 *  - Health checks — should never require auth.
 *  - Media-stream WebSocket upgrade — Twilio doesn't send JWT.
 *
 * If a request has no Bearer token, the middleware does nothing. The
 * downstream guard / controller decides whether to reject. We don't
 * blanket-401 here because some endpoints are legitimately public.
 */
@Injectable()
export class JwtUserIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger(JwtUserIdMiddleware.name);
  private readonly secret = process.env.JWT_SECRET || "";

  /** Path prefixes that must NOT be touched by this middleware. */
  private static readonly SKIP_PREFIXES = [
    "/telephony/webhooks/",
    "/telephony/media-stream",
    "/health",
  ];

  use(req: Request, _res: Response, next: NextFunction): void {
    const path = req.path || req.url || "";
    if (JwtUserIdMiddleware.SKIP_PREFIXES.some((p) => path.startsWith(p))) {
      // Defensive: even on skipped paths, drop a client-supplied X-User-ID
      // so a misconfigured client can't bypass the JWT path by routing
      // through a webhook URL.
      delete req.headers["x-user-id"];
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ") || !this.secret) {
      // No JWT: drop any client-supplied X-User-ID so unauthenticated
      // requests cannot impersonate by header alone. Downstream guard
      // will 401 if the endpoint requires auth.
      delete req.headers["x-user-id"];
      next();
      return;
    }

    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, this.secret) as Record<string, unknown>;
      const sub =
        typeof payload.sub === "string"
          ? payload.sub
          : typeof payload.user_id === "string"
            ? payload.user_id
            : typeof payload.sub === "number"
              ? String(payload.sub)
              : null;
      if (sub) {
        // Overwrite — never trust the inbound value.
        req.headers["x-user-id"] = sub;
      } else {
        delete req.headers["x-user-id"];
      }
    } catch (err) {
      // Invalid / expired token: drop X-User-ID and let downstream guards
      // surface the auth error. We don't 401 here to keep the middleware
      // composable with public endpoints that simply tolerate an absent
      // user.
      this.logger.warn(
        "JWT verification failed (%s) — dropping X-User-ID",
        err instanceof Error ? err.message : String(err),
      );
      delete req.headers["x-user-id"];
    }

    next();
  }
}
