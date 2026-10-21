import { isDecline, siblingsToCancel } from "./decline-siblings";

describe("decline cancels the ringing siblings", () => {
  it("only busy counts as a decline", () => {
    expect(isDecline("busy")).toBe(true);
    for (const s of ["no-answer", "failed", "canceled", "completed", "in-progress", undefined]) {
      expect(isDecline(s)).toBe(false);
    }
  });

  it("cancels the other legs still ringing (Oct 3: 280 rang to 36 s)", () => {
    const children = [
      { sid: "CAcreator", status: "busy" },
      { sid: "CArep", status: "ringing" },
    ];
    expect(siblingsToCancel(children, "CAcreator")).toEqual(["CArep"]);
  });

  it("covers queued and initiated legs too", () => {
    const children = [
      { sid: "CA1", status: "busy" },
      { sid: "CA2", status: "queued" },
      { sid: "CA3", status: "initiated" },
    ];
    expect(siblingsToCancel(children, "CA1")).toEqual(["CA2", "CA3"]);
  });

  it("never touches an answered or finished leg", () => {
    const children = [
      { sid: "CA1", status: "busy" },
      { sid: "CA2", status: "in-progress" },
      { sid: "CA3", status: "completed" },
      { sid: "CA4", status: "no-answer" },
    ];
    expect(siblingsToCancel(children, "CA1")).toEqual([]);
  });

  it("never cancels the declined leg itself", () => {
    expect(siblingsToCancel([{ sid: "CA1", status: "ringing" }], "CA1")).toEqual([]);
  });
});
