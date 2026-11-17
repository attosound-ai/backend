import { ConfigService } from "@nestjs/config";
import { UsersClientService } from "./users-client.service";
import { CacheService } from "../cache/cache.service";

describe("UsersClientService", () => {
  let cacheStore: Map<string, unknown>;
  let cache: jest.Mocked<CacheService>;
  let config: ConfigService;
  let svc: UsersClientService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    cacheStore = new Map();

    cache = {
      get: jest.fn(async <T,>(k: string) => (cacheStore.get(k) ?? null) as T | null),
      set: jest.fn(async (k: string, v: unknown) => {
        cacheStore.set(k, v);
      }),
    } as unknown as jest.Mocked<CacheService>;

    config = {
      get: (key: string) => {
        if (key === "userService.url") return "http://user-service.test";
        if (key === "userService.timeoutMs") return 500;
        return undefined;
      },
    } as unknown as ConfigService;

    fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;

    svc = new UsersClientService(config, cache);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }

  it("returns the username from a successful enveloped response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { username: "ninanina", id: 39 } }),
    );

    expect(await svc.getUsernameById("39")).toBe("ninanina");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the username from a raw (non-enveloped) response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ username: "ninanina" }));

    expect(await svc.getUsernameById("39")).toBe("ninanina");
  });

  it("caches successful lookups so the second call hits Redis", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { username: "alice" } }));

    expect(await svc.getUsernameById("42")).toBe("alice");
    expect(await svc.getUsernameById("42")).toBe("alice");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("negative-caches a 404 so a second call does not re-hit user-service", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 404));

    expect(await svc.getUsernameById("999")).toBeNull();
    expect(await svc.getUsernameById("999")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null on network failure without throwing", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await svc.getUsernameById("39")).toBeNull();
  });

  it("returns null on a 5xx response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503));

    expect(await svc.getUsernameById("39")).toBeNull();
  });

  it("returns null when the response is missing a username field", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: 39 } }));

    expect(await svc.getUsernameById("39")).toBeNull();
  });

  it("returns null for an empty userId without making an HTTP call", async () => {
    expect(await svc.getUsernameById("")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts the request when it exceeds the configured timeout", async () => {
    let receivedSignal: AbortSignal | undefined;
    const slow = new Promise<Response>((_resolve, reject) => {
      // The abort path rejects with a DOMException; our service catches it.
      setTimeout(() => reject(new Error("aborted")), 20);
    });
    fetchMock.mockImplementation((_url, init) => {
      receivedSignal = (init as RequestInit).signal as AbortSignal;
      return slow;
    });

    expect(await svc.getUsernameById("39")).toBeNull();
    expect(receivedSignal).toBeDefined();
  });

  describe("isOwnerDeactivated (30 day deletion grace)", () => {
    it("is true when user-service says the owner is pending deletion", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ data: { userIds: [281], ownerDeactivated: true } }),
      );
      expect(await svc.isOwnerDeactivated("281")).toBe(true);
      // Cached: a second call does not hit user-service.
      expect(await svc.isOwnerDeactivated("281")).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("is false for an active owner and for an older user-service without the field", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: { userIds: [280], ownerDeactivated: false } }),
      );
      expect(await svc.isOwnerDeactivated("280")).toBe(false);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: { userIds: [282] } }),
      );
      expect(await svc.isOwnerDeactivated("282")).toBe(false);
    });

    it("presents the internal service token, like the linked ids lookup", async () => {
      const withSecret = {
        get: (key: string) => {
          if (key === "userService.url") return "http://user-service.test";
          if (key === "userService.timeoutMs") return 500;
          if (key === "jwt.secret") return "telephony-test-secret";
          return undefined;
        },
      } as unknown as ConfigService;
      const signedSvc = new UsersClientService(withSecret, cache);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: { userIds: [281], ownerDeactivated: true } }),
      );
      expect(await signedSvc.isOwnerDeactivated("281")).toBe(true);
      const init = fetchMock.mock.calls[0][1] as {
        headers: Record<string, string>;
      };
      expect(init.headers.Authorization).toMatch(/^Bearer /);
    });

    it("fails soft: errors and 5xx keep the call ringing", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      expect(await svc.isOwnerDeactivated("281")).toBe(false);
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
      expect(await svc.isOwnerDeactivated("281")).toBe(false);
      expect(await svc.isOwnerDeactivated("")).toBe(false);
    });
  });
});
