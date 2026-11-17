import * as jwt from "jsonwebtoken";
import { UnauthorizedException } from "@nestjs/common";
import {
  EXPIRED_GRACE_S,
  resolveVerifiedUserId,
  verifiedUserIdFromBearer,
} from "./verified-user-id";

const SECRET = "test-secret";
const NOW = 1_800_000_000;
const sign = (payload: object, secret = SECRET) =>
  "Bearer " + jwt.sign({ iat: NOW - 60, ...payload }, secret, { noTimestamp: true });
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("verified user id", () => {
  it("accepts a token signed with our secret", () => {
    expect(verifiedUserIdFromBearer(sign({ sub: "281", exp: NOW + 600 }), SECRET, NOW)).toBe("281");
    expect(verifiedUserIdFromBearer(sign({ user_id: "265", exp: NOW + 600 }), SECRET, NOW)).toBe("265");
    expect(verifiedUserIdFromBearer(sign({ sub: 152, exp: NOW + 600 }), SECRET, NOW)).toBe("152");
  });

  it("Oct 12 2026: a made up signature is refused (it listed calls in production)", () => {
    const forged = `Bearer ${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "281", exp: NOW + 600 })}.firma_falsa`;
    expect(verifiedUserIdFromBearer(forged, SECRET, NOW)).toBeNull();
  });

  it("refuses alg none and a token signed with another secret", () => {
    const none = `Bearer ${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "281" })}.`;
    expect(verifiedUserIdFromBearer(none, SECRET, NOW)).toBeNull();
    expect(verifiedUserIdFromBearer(sign({ sub: "281", exp: NOW + 600 }, "other"), SECRET, NOW)).toBeNull();
  });

  it("an expired token of ours still works within the grace, not after", () => {
    expect(verifiedUserIdFromBearer(sign({ sub: "191", exp: NOW - 3600 }), SECRET, NOW)).toBe("191");
    expect(
      verifiedUserIdFromBearer(sign({ sub: "191", exp: NOW - EXPIRED_GRACE_S - 1 }), SECRET, NOW),
    ).toBeNull();
  });

  it("no secret, no Bearer, garbage or no subject is never a user", () => {
    expect(verifiedUserIdFromBearer(sign({ sub: "281" }), "", NOW)).toBeNull();
    expect(verifiedUserIdFromBearer(undefined, SECRET, NOW)).toBeNull();
    expect(verifiedUserIdFromBearer("Basic abc", SECRET, NOW)).toBeNull();
    expect(verifiedUserIdFromBearer("Bearer x.y.z", SECRET, NOW)).toBeNull();
    expect(verifiedUserIdFromBearer(sign({ role: "user" }), SECRET, NOW)).toBeNull();
  });

  it("the header set by the middleware wins; otherwise unauthorized", () => {
    expect(resolveVerifiedUserId("281", undefined)).toBe("281");
    expect(() => resolveVerifiedUserId(undefined, "Bearer a.b.c")).toThrow(UnauthorizedException);
  });
});
