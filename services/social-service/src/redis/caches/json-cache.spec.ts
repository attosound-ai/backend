import { JsonCache } from "./json-cache";
import { RedisClientProvider } from "../redis-client.provider";

interface User {
  id: string;
  username: string;
}

describe("JsonCache", () => {
  let store: Map<string, string>;
  let ttls: Map<string, number>;
  let mockClient: any;
  let provider: RedisClientProvider;
  let cache: JsonCache<User>;

  beforeEach(() => {
    store = new Map();
    ttls = new Map();

    mockClient = {
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (...args: any[]) => {
        const [key, value, ...rest] = args;
        store.set(key, String(value));
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "EX" && typeof rest[i + 1] === "number") {
            ttls.set(key, rest[i + 1] as number);
          }
        }
        return "OK";
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
          exec: jest.fn(async () =>
            Promise.all(
              ops.map(async ([op, ...args]) => {
                if (op === "get") {
                  return [null, store.get(args[0] as string) ?? null];
                }
                if (op === "set") {
                  await mockClient.set(...args);
                  return [null, "OK"];
                }
                return [null, null];
              }),
            ),
          ),
        };
        return p;
      }),
    };

    provider = { client: () => mockClient } as RedisClientProvider;

    cache = new JsonCache<User>(provider, {
      keyPrefix: "test:user",
      ttlSeconds: 600,
      negativeTtlSeconds: 60,
    });
  });

  it("returns the parsed value on cache hit", async () => {
    store.set(
      "test:user:42",
      JSON.stringify({ id: "42", username: "ninanina" }),
    );
    const result = await cache.getOrCompute("42", async () => null);
    expect(result).toEqual({ id: "42", username: "ninanina" });
  });

  it("runs the loader on miss and caches the positive result", async () => {
    const loader = jest.fn(async () => ({
      id: "42",
      username: "ninanina",
    }));
    const result = await cache.getOrCompute("42", loader);
    expect(result).toEqual({ id: "42", username: "ninanina" });
    expect(ttls.get("test:user:42")).toBe(600);
  });

  it("caches a negative result (sentinel) with negativeTtlSeconds", async () => {
    const loader = jest.fn(async () => null);
    await cache.getOrCompute("99", loader);
    // The sentinel string is implementation detail — we verify behavior
    // via the second call not invoking the loader.
    const loader2 = jest.fn(async () => ({
      id: "99",
      username: "bob",
    }));
    const result = await cache.getOrCompute("99", loader2);
    expect(result).toBeNull();
    expect(loader2).not.toHaveBeenCalled();
    expect(ttls.get("test:user:99")).toBe(60);
  });

  it("recomputes when stored JSON is corrupt", async () => {
    store.set("test:user:42", "not-valid-json{{{");
    const loader = jest.fn(async () => ({
      id: "42",
      username: "alice",
    }));
    const result = await cache.getOrCompute("42", loader);
    expect(result).toEqual({ id: "42", username: "alice" });
    expect(loader).toHaveBeenCalled();
  });

  it("getMany returns parsed values + nulls for misses and negatives", async () => {
    store.set(
      "test:user:a",
      JSON.stringify({ id: "a", username: "alice" }),
    );
    // Trigger negative cache
    await cache.getOrCompute("c", async () => null);

    const result = await cache.getMany(["a", "b", "c"]);
    expect(result.get("a")).toEqual({ id: "a", username: "alice" });
    expect(result.get("b")).toBeNull();
    expect(result.get("c")).toBeNull();
  });

  it("invalidate removes the cached entry", async () => {
    store.set(
      "test:user:42",
      JSON.stringify({ id: "42", username: "alice" }),
    );
    await cache.invalidate("42");
    expect(store.has("test:user:42")).toBe(false);
  });
});
