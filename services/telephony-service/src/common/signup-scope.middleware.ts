import { Injectable, NestMiddleware, ForbiddenException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';

const SCOPE_SIGNUP_PENDING = 'signup_pending';

/**
 * Rejects requests carrying a signup_pending JWT.
 *
 * The telephony controllers historically read `X-User-ID` directly rather
 * than validating the JWT; the wider X-User-ID hardening project will fix
 * that separately. This middleware exists *only* so that a signup_pending
 * token coming from a misconfigured frontend cannot reach telephony
 * endpoints. It's narrow on purpose — full JWT auth lives elsewhere.
 */
@Injectable()
export class SignupScopeMiddleware implements NestMiddleware {
  private readonly secret = process.env.JWT_SECRET || '';

  use(req: Request, _res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ') || !this.secret) {
      next();
      return;
    }
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, this.secret, {
        ignoreExpiration: true,
      }) as Record<string, unknown>;
      if (payload?.scope === SCOPE_SIGNUP_PENDING) {
        throw new ForbiddenException(
          'insufficient_scope: finish registration first',
        );
      }
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      // Malformed/expired tokens are someone else's problem — pass through.
    }
    next();
  }
}
