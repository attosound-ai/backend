import {
  CanActivate,
  ExecutionContext,
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
}

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  private readonly jwtSecret = process.env.JWT_SECRET || '';

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    // First check X-User-ID header (internal service-to-service calls)
    const headerUserId = request.headers['x-user-id'] as string;
    if (headerUserId) {
      (request as any).userId = headerUserId;
      (request as any).userRole =
        (request.headers['x-user-role'] as string) || 'user';
      return true;
    }

    // Otherwise validate JWT from Authorization header
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing authentication');
    }

    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, this.jwtSecret) as JwtPayload;
      (request as any).userId = payload.sub;
      (request as any).userRole = payload.role || 'user';
      return true;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Token validation failed';
      this.logger.warn(`JWT validation failed: ${message}`);
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
