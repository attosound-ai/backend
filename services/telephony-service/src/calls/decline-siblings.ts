/**
 * One bridge call rings every linked account with one <Dial> (one <Client>
 * leg per account). A leg that ends "busy" was declined by a person; like
 * WhatsApp and FaceTime, a decline on one device declines everywhere, so the
 * sibling legs still ringing are canceled and the caller stops hearing
 * ringback. Before this, a sibling whose push never reached a phone (stale
 * binding, other device) rang out the 30 s dial timeout (Oct 3 2026 tests:
 * westcol busy at 23 s, david.espejo no-answer at 36 s).
 */
export interface ChildLeg {
  sid: string;
  status: string;
}

const STILL_RINGING = new Set(["queued", "initiated", "ringing"]);

/** Only an explicit decline cancels the siblings; no-answer or failed never do. */
export function isDecline(callStatus: string | undefined): boolean {
  return callStatus === "busy";
}

/** Sibling legs of the declined one that are still ringing. */
export function siblingsToCancel(children: ChildLeg[], declinedSid: string): string[] {
  return children
    .filter((c) => c.sid !== declinedSid && STILL_RINGING.has(c.status))
    .map((c) => c.sid);
}
