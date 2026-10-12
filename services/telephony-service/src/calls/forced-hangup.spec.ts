import { endingStatus, isEnded, legsToEnd, ownsLeg, type LegInfo } from "./forced-hangup";

const leg = (over: Partial<LegInfo>): LegInfo => ({
  sid: "CAchild",
  status: "in-progress",
  to: "client:user-265",
  from: "+18323842056",
  parentCallSid: "CAparent",
  ...over,
});

describe("forced hang up", () => {
  it("an incoming leg to the user's identity is theirs", () => {
    expect(ownsLeg(leg({}), "265")).toBe(true);
  });

  it("an outgoing leg from the user's identity is theirs", () => {
    expect(ownsLeg(leg({ to: "+18601234567", from: "client:user-265" }), "265")).toBe(true);
  });

  it("someone else's leg is never theirs, nor a prefix match", () => {
    expect(ownsLeg(leg({}), "26")).toBe(false);
    expect(ownsLeg(leg({}), "2655")).toBe(false);
    expect(ownsLeg(leg({ to: "client:user-281" }), "265")).toBe(false);
    expect(ownsLeg(leg({ to: null, from: null }), "265")).toBe(false);
    expect(ownsLeg(leg({}), "")).toBe(false);
  });

  it("ends the leg and then its parent", () => {
    const parent = leg({ sid: "CAparent", to: "+18607831309", parentCallSid: null });
    expect(legsToEnd(leg({}), parent)).toEqual(["CAchild", "CAparent"]);
  });

  it("skips what already ended, and a missing parent", () => {
    const parent = leg({ sid: "CAparent", status: "completed", parentCallSid: null });
    expect(legsToEnd(leg({}), parent)).toEqual(["CAchild"]);
    expect(legsToEnd(leg({ status: "completed" }), null)).toEqual([]);
    expect(legsToEnd(leg({ status: "canceled" }), leg({ sid: "CAparent" }))).toEqual(["CAparent"]);
  });

  it("never lists the same SID twice", () => {
    expect(legsToEnd(leg({ sid: "CA1" }), leg({ sid: "CA1" }))).toEqual(["CA1"]);
  });

  it("a ringing leg is canceled, a live one completed", () => {
    expect(endingStatus("ringing")).toBe("canceled");
    expect(endingStatus("queued")).toBe("canceled");
    expect(endingStatus("in-progress")).toBe("completed");
  });

  it("only final statuses count as ended", () => {
    for (const s of ["completed", "canceled", "busy", "no-answer", "failed"]) expect(isEnded(s)).toBe(true);
    for (const s of ["in-progress", "ringing", "queued", "initiated", null, undefined]) expect(isEnded(s)).toBe(false);
  });
});
