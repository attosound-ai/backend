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
});
