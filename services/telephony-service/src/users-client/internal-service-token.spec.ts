import * as jwt from "jsonwebtoken";
import { ConfigService } from "@nestjs/config";
import { CacheService } from "../cache/cache.service";
import { UsersClientService } from "./users-client.service";
import {
  internalServiceToken,
  SERVICE_TOKEN_TTL_S,
  TELEPHONY_SERVICE_TOKEN_ISSUER,
  TELEPHONY_SERVICE_TOKEN_SUBJECT,
} from "./internal-service-token";

const SECRET = "test-secret-please-ignore";

describe("internalServiceToken", () => {
  it("signs a one minute service token user-service accepts", () => {
    const now = 1_800_000_000;
    const tok = internalServiceToken(SECRET, now)!;
    const claims = jwt.verify(tok, SECRET, {
      algorithms: ["HS256"],
      clockTimestamp: now,
    }) as jwt.JwtPayload;

    // Same contract as user-service RequireInternalCallerOrOwner.
    expect(claims.scope).toBe("service");
    expect(claims.iss).toBe(TELEPHONY_SERVICE_TOKEN_ISSUER);
    expect(claims.sub).toBe(TELEPHONY_SERVICE_TOKEN_SUBJECT);
    expect(String(claims.sub).startsWith("service:")).toBe(true);
    expect(Number.isNaN(Number(claims.sub))).toBe(true);
    expect(claims.exp! - claims.iat!).toBe(SERVICE_TOKEN_TTL_S);
    expect(SERVICE_TOKEN_TTL_S).toBeLessThanOrEqual(5 * 60);
  });

  it("returns null without a secret instead of signing with an empty key", () => {
    expect(internalServiceToken("")).toBeNull();
    expect(internalServiceToken(undefined)).toBeNull();
  });
});

describe("UsersClientService internal calls carry the service token", () => {
  let fetchMock: jest.Mock;
  let svc: UsersClientService;

  beforeEach(() => {
    const store = new Map<string, unknown>();
    const cache = {
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (k: string, v: unknown) => void store.set(k, v)),
    } as unknown as CacheService;
    const config = {
      get: (key: string) =>
        ({
          "userService.url": "http://user-service.test",
          "userService.timeoutMs": 500,
          "jwt.secret": SECRET,
        })[key],
    } as unknown as ConfigService;
    fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { tokens: [], userIds: [7, 8] } }),
    }));
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    svc = new UsersClientService(config, cache);
  });

  function bearerOfCall(i: number): jwt.JwtPayload {
    const init = fetchMock.mock.calls[i][1] as RequestInit;
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toMatch(/^Bearer /);
    return jwt.verify(auth.slice(7), SECRET) as jwt.JwtPayload;
  }

  it("push-tokens", async () => {
    await svc.getActivePushTokens("7");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://user-service.test/users/7/push-tokens",
    );
    expect(bearerOfCall(0).scope).toBe("service");
  });

  it("linked-account-ids", async () => {
    expect(await svc.getLinkedAccountIds("7")).toEqual([7, 8]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://user-service.test/users/7/linked-account-ids",
    );
    expect(bearerOfCall(0).iss).toBe(TELEPHONY_SERVICE_TOKEN_ISSUER);
  });
});
