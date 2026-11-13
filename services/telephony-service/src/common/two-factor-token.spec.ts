import * as jwt from "jsonwebtoken";
import { verifiedUserIdFromBearer } from "./verified-user-id";
import { JwtUserIdMiddleware } from "./jwt-user-id.middleware";

// Nov 12 2026: the 2FA temporary token (password only, before the second
// factor) is signed with the shared secret and was read as a session here,
// expired or not for up to 30 days: it minted Voice tokens and listed calls.
const SECRET = "test-secret-2fa";

const legacy = () =>
  jwt.sign({ sub: "281" }, SECRET, { issuer: "atto-sound-2fa", expiresIn: 300 });
const current = () =>
  jwt.sign({ sub: "2fa:281", scope: "2fa_pending" }, SECRET, {
    issuer: "atto-sound-2fa",
    expiresIn: 300,
  });
const session = () =>
  jwt.sign({ sub: "281", scope: "user" }, SECRET, {
    issuer: "atto-sound-user-service",
    expiresIn: 900,
  });

describe("telephony and the 2FA temporary token", () => {
  it("verifiedUserIdFromBearer refuses both 2FA token shapes", () => {
    expect(verifiedUserIdFromBearer(`Bearer ${legacy()}`, SECRET)).toBeNull();
    expect(verifiedUserIdFromBearer(`Bearer ${current()}`, SECRET)).toBeNull();
    expect(verifiedUserIdFromBearer(`Bearer ${session()}`, SECRET)).toBe("281");
  });

  it("the middleware never derives X-User-ID from a 2FA token", () => {
    const prev = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;
    const mw = new JwtUserIdMiddleware();
    (mw as any).logger = { warn: jest.fn() };
    process.env.JWT_SECRET = prev;
    for (const [tok, want] of [
      [legacy(), undefined],
      [current(), undefined],
      [session(), "281"],
    ] as const) {
      const req: any = { path: "/telephony/calls", headers: { authorization: `Bearer ${tok}`, "x-user-id": "999" } };
      mw.use(req, {} as any, () => undefined);
      expect(req.headers["x-user-id"]).toBe(want);
    }
  });
});
