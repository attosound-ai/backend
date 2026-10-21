import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';

interface JwtPayload {
  sub: string;
  username: string;
  email: string;
  role: string;
  scope?: string;
}

// Tokens carrying this scope are limited to /signup/* on user-service and
// MUST NOT reach the social service. Treat their presence here as 403 rather
// than 401 — the token is valid, just out of scope.
const SCOPE_SIGNUP_PENDING = 'signup_pending';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  private readonly jwtSecret = process.env.JWT_SECRET || '';

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    // JWT is the only trust path (Bug #6 hardening). The X-User-ID
    // header used to be accepted as a fallback for "internal
    // service-to-service" calls, but in practice clients could (and did)
    // set it to any value — a private-network defense is not a security
    // boundary on its own. Kong strips the header at the edge anyway
    // so a request reaching this guard with X-User-ID has come from
    // somewhere bypassing the gateway and should NOT be trusted.
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing authentication');
    }

    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, this.jwtSecret) as JwtPayload;
      if (payload.scope === SCOPE_SIGNUP_PENDING) {
        throw new ForbiddenException(
          'insufficient_scope: finish registration first',
        );
      }
      (request as any).userId = payload.sub;
      (request as any).userRole = payload.role || 'user';
      return true;
    } catch (error: unknown) {
      if (error instanceof ForbiddenException) throw error;
      const message =
        error instanceof Error ? error.message : 'Token validation failed';
      this.logger.warn(`JWT validation failed: ${message}`);
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
