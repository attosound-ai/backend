import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { AuthGuard } from './auth.guard';

// Nov 12 2026: the 2FA temporary token (issued after the password alone,
// before the second factor) is signed with the shared secret. This guard
// accepted it as a session, so the password alone opened every social route.
const SECRET = 'test-secret-2fa';

function ctx(token: string): ExecutionContext {
  const req: any = { headers: { authorization: `Bearer ${token}` } };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('AuthGuard and the 2FA temporary token', () => {
  const prev = process.env.JWT_SECRET;
  let guard: AuthGuard;
  beforeAll(() => {
    process.env.JWT_SECRET = SECRET;
    guard = new AuthGuard();
    (guard as any).logger = { warn: jest.fn() };
  });
  afterAll(() => {
    process.env.JWT_SECRET = prev;
  });

  it('rejects the legacy 2FA token (numeric sub, no scope) with 401', () => {
    const tok = jwt.sign({ sub: '281' }, SECRET, { issuer: 'atto-sound-2fa', expiresIn: 300 });
    expect(() => guard.canActivate(ctx(tok))).toThrow(UnauthorizedException);
  });

  it('rejects the current 2FA token (scope 2fa_pending) with 401', () => {
    const tok = jwt.sign({ sub: '2fa:281', scope: '2fa_pending' }, SECRET, {
      issuer: 'atto-sound-2fa',
      expiresIn: 300,
    });
    expect(() => guard.canActivate(ctx(tok))).toThrow(UnauthorizedException);
  });

  it('still accepts a normal session token', () => {
    const tok = jwt.sign({ sub: '281', scope: 'user', role: 'listener' }, SECRET, {
      issuer: 'atto-sound-user-service',
      expiresIn: 900,
    });
    expect(guard.canActivate(ctx(tok))).toBe(true);
  });
});
