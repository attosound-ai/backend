import * as jwt from "jsonwebtoken";
import { ExpiredSessionCheck } from "./expired-session-check";
import { JwtUserIdMiddleware } from "./jwt-user-id.middleware";

// Nov 12 2026: a password reset closes every session of the account. The
// VoIP grace (expired tokens accepted for 30 days) must not keep a closed
// session alive on the calls path.

function fakeFetch(answer: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throws?: boolean;
}) {
  const calls: string[] = [];
  const fn = async (url: string, init: { body: string }) => {
    calls.push(`${url} ${init.body}`);
    if (answer.throws) throw new Error("ECONNREFUSED");
    return {
      ok: answer.ok ?? true,
      status: answer.status ?? 200,
      json: async () => answer.body,
    };
  };
  return { fn, calls };
}

describe("ExpiredSessionCheck", () => {
  it("open, closed and unknown; caches the first two", async () => {
    const open = fakeFetch({ body: { success: true, data: { valid: true } } });
    const c1 = new ExpiredSessionCheck("http://user-service", open.fn as never);
    expect(await c1.check("t1")).toBe("open");
    expect(await c1.check("t1")).toBe("open");
    expect(open.calls).toHaveLength(1);
    expect(open.calls[0]).toContain("http://user-service/auth/session-check");
    expect(open.calls[0]).toContain('"token":"t1"');

    const closed = fakeFetch({
      body: {
        success: true,
        data: { valid: false, reason: "session_revoked" },
      },
    });
    expect(
      await new ExpiredSessionCheck("http://u", closed.fn as never).check("t2"),
    ).toBe("closed");

    // An outage keeps today's behaviour and is not cached.
    const down = fakeFetch({ throws: true });
    const c3 = new ExpiredSessionCheck("http://u", down.fn as never);
    expect(await c3.check("t3")).toBe("unknown");
    expect(await c3.check("t3")).toBe("unknown");
    expect(down.calls).toHaveLength(2);
    const old = fakeFetch({
      ok: false,
      status: 404,
      body: { error: "Cannot POST" },
    });
    expect(
      await new ExpiredSessionCheck("http://u", old.fn as never).check("t4"),
    ).toBe("unknown");
  });
});

describe("JwtUserIdMiddleware and closed sessions", () => {
  const SECRET = "test-secret-telephony";
  const prev = process.env.JWT_SECRET;
  const prevSessions = JwtUserIdMiddleware.sessions;
  afterAll(() => {
    process.env.JWT_SECRET = prev;
    JwtUserIdMiddleware.sessions = prevSessions;
  });

  function run(token: string, verdict: "open" | "closed" | "unknown") {
    process.env.JWT_SECRET = SECRET;
    const asked: string[] = [];
    JwtUserIdMiddleware.sessions = {
      check: async (t: string) => {
        asked.push(t);
        return verdict;
      },
    } as never;
    const mw = new JwtUserIdMiddleware();
    (mw as unknown as { logger: { warn: () => void } }).logger = {
      warn: () => undefined,
    };
    const req = {
      path: "/telephony/token/voice",
      headers: { authorization: `Bearer ${token}` },
    } as never;
    let status = 0;
    const res = {
      status: (s: number) => ({ json: () => (status = s) }),
    } as never;
    let nexted = false;
    return mw
      .use(req, res, () => (nexted = true))
      .then(() => ({ status, nexted, asked, req }));
  }

  const nowS = Math.floor(Date.now() / 1000);
  const expired = () =>
    jwt.sign({ sub: "281", iat: nowS - 3600, exp: nowS - 1800 }, SECRET);
  const fresh = () =>
    jwt.sign({ sub: "281", iat: nowS - 60, exp: nowS + 600 }, SECRET);

  it("an expired token of a closed session gets 401 before any controller", async () => {
    const r = await run(expired(), "closed");
    expect(r.status).toBe(401);
    expect(r.nexted).toBe(false);
  });

  it("an expired token of an open session keeps the VoIP grace", async () => {
    const r = await run(expired(), "open");
    expect(r.nexted).toBe(true);
    expect(r.status).toBe(0);
  });

  it("user-service down: today's behaviour (the grace applies)", async () => {
    const r = await run(expired(), "unknown");
    expect(r.nexted).toBe(true);
  });

  it("a fresh token is never checked (it ends on its own within 15 minutes)", async () => {
    const r = await run(fresh(), "closed");
    expect(r.nexted).toBe(true);
    expect(r.asked).toHaveLength(0);
    expect(
      (r.req as { headers: Record<string, string> }).headers["x-user-id"],
    ).toBe("281");
  });

  it("a token past the 30 day grace or signed by someone else is not checked", async () => {
    const tooOld = jwt.sign(
      { sub: "281", iat: nowS - 40 * 86400, exp: nowS - 31 * 86400 },
      SECRET,
    );
    const foreign = jwt.sign(
      { sub: "281", iat: nowS - 3600, exp: nowS - 1800 },
      "other",
    );
    for (const t of [tooOld, foreign]) {
      const r = await run(t, "closed");
      expect(r.asked).toHaveLength(0);
      expect(r.nexted).toBe(true);
    }
  });
});
