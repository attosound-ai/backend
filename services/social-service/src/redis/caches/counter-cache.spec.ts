import { CounterCache } from "./counter-cache";
import { RedisClientProvider } from "../redis-client.provider";

describe("CounterCache", () => {
  let store: Map<string, string>;
  let ttls: Map<string, number>;
  let mockClient: any;
  let provider: RedisClientProvider;
  let cache: CounterCache;

  beforeEach(() => {
    store = new Map();
    ttls = new Map();

    mockClient = {
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (...args: any[]) => {
        const [key, value, ...rest] = args;
        store.set(key, String(value));
        // Parse "EX <seconds>" or "KEEPTTL"
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "EX" && typeof rest[i + 1] === "number") {
            ttls.set(key, rest[i + 1] as number);
          } else if (rest[i] === "KEEPTTL") {
            // preserve current TTL — no-op for the mock
          }
        }
        return "OK";
      }),
      incr: jest.fn(async (k: string) => {
        const next = (Number.parseInt(store.get(k) ?? "0", 10) || 0) + 1;
        store.set(k, String(next));
        return next;
      }),
      decr: jest.fn(async (k: string) => {
        const next = (Number.parseInt(store.get(k) ?? "0", 10) || 0) - 1;
        store.set(k, String(next));
        return next;
      }),
      del: jest.fn(async (k: string) => {
        const had = store.has(k);
        store.delete(k);
        ttls.delete(k);
        return had ? 1 : 0;
      }),
      pipeline: jest.fn(() => {
        const ops: Array<[string, ...unknown[]]> = [];
        const p: any = {
          get: (k: string) => {
            ops.push(["get", k]);
            return p;
          },
          set: (...args: unknown[]) => {
            ops.push(["set", ...args]);
            return p;
          },
          exec: jest.fn(async () => {
            return Promise.all(
              ops.map(async ([op, ...args]) => {
                if (op === "get") {
                  const v = store.get(args[0] as string) ?? null;
                  return [null, v];
                }
                if (op === "set") {
                  await mockClient.set(...args);
                  return [null, "OK"];
                }
                return [null, null];
              }),
            );
          }),
        };
        return p;
      }),
    };

    provider = { client: () => mockClient } as RedisClientProvider;

    cache = new CounterCache(provider, {
      keyPrefix: "test:count",
      ttlSeconds: 600,
      negativeTtlSeconds: 60,
    });
  });

  describe("getOrCompute", () => {
    it("returns the cached value when present", async () => {
      store.set("test:count:user-1", "5");
      const result = await cache.getOrCompute("user-1", async () => 999);
      expect(result).toBe(5);
    });

    it("runs the loader on miss and caches the result with full TTL", async () => {
      const loader = jest.fn(async () => 7);
      const result = await cache.getOrCompute("user-1", loader);
      expect(result).toBe(7);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(store.get("test:count:user-1")).toBe("7");
      expect(ttls.get("test:count:user-1")).toBe(600);
    });

    it("caches a zero result with the negative TTL (negative caching)", async () => {
      const loader = jest.fn(async () => 0);
      await cache.getOrCompute("user-1", loader);
      expect(store.get("test:count:user-1")).toBe("0");
      expect(ttls.get("test:count:user-1")).toBe(60);
    });

    it("does not call the loader when the cache has a zero", async () => {
      store.set("test:count:user-1", "0");
      const loader = jest.fn(async () => 999);
      const result = await cache.getOrCompute("user-1", loader);
      expect(result).toBe(0);
      expect(loader).not.toHaveBeenCalled();
    });

    it("recomputes when the cached value is corrupt", async () => {
      store.set("test:count:user-1", "not-a-number");
      const loader = jest.fn(async () => 42);
      const result = await cache.getOrCompute("user-1", loader);
      expect(result).toBe(42);
      expect(loader).toHaveBeenCalledTimes(1);
    });
  });

  describe("increment / decrement", () => {
    it("INCR preserves the existing TTL (no PERSIST)", async () => {
      // Seed via getOrCompute so the TTL is set.
      await cache.getOrCompute("user-1", async () => 5);
      expect(ttls.get("test:count:user-1")).toBe(600);

      await cache.increment("user-1");

      // The mock's `incr` doesn't touch the TTL map (matching real
      // Redis behavior where INCR preserves expiry). The previous god-
      // class issued an explicit PERSIST after every INCR, which
      // would have wiped this TTL.
      expect(ttls.get("test:count:user-1")).toBe(600);
      expect(store.get("test:count:user-1")).toBe("6");
    });

    it("decrement clamps at zero and logs", async () => {
      store.set("test:count:user-1", "0");
      const result = await cache.decrement("user-1");
      expect(result).toBe(0);
      // Underflow path triggers SET KEEPTTL
      expect(store.get("test:count:user-1")).toBe("0");
    });

    it("decrement returns the new value when above zero", async () => {
      store.set("test:count:user-1", "5");
      const result = await cache.decrement("user-1");
      expect(result).toBe(4);
    });
  });

  describe("set / invalidate", () => {
    it("set with positive count uses ttlSeconds", async () => {
      await cache.set("user-1", 10);
      expect(ttls.get("test:count:user-1")).toBe(600);
    });

    it("set with zero uses negativeTtlSeconds when configured", async () => {
      await cache.set("user-1", 0);
      expect(ttls.get("test:count:user-1")).toBe(60);
    });

    it("invalidate removes the key", async () => {
      await cache.set("user-1", 5);
      await cache.invalidate("user-1");
      expect(store.has("test:count:user-1")).toBe(false);
    });
  });

  describe("getMany / setMany", () => {
    it("returns null for cache misses and parsed values for hits", async () => {
      store.set("test:count:a", "5");
      store.set("test:count:c", "0");
      const result = await cache.getMany(["a", "b", "c"]);
      expect(result.get("a")).toBe(5);
      expect(result.get("b")).toBeNull();
      expect(result.get("c")).toBe(0);
    });

    it("setMany applies the right TTL per entry (zero → negativeTtl)", async () => {
      await cache.setMany([
        { id: "a", count: 5 },
        { id: "b", count: 0 },
      ]);
      expect(ttls.get("test:count:a")).toBe(600);
      expect(ttls.get("test:count:b")).toBe(60);
    });
  });
});
