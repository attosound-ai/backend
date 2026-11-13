/**
 * Server side hang up, the backstop when the app could not end a call itself.
 *
 * Oct 5 2026, Voss (build 184): he tapped hang up, the screen cleared, and the
 * Twilio leg kept running until the far side hung up. The app's disconnect()
 * either rejected or never produced Twilio's Disconnected event. When that
 * happens the app now asks the server to end the call, and the server ends it
 * through Twilio's REST API and reads it back to prove it ended.
 *
 * Only a leg whose SDK identity is the signed in user may be ended: an
 * incoming leg goes TO client:user-{id}, an outgoing one comes FROM it. The
 * leg's parent is ended too (the bridge or PSTN side), so the caller's line
 * is freed even if Twilio would keep it waiting after the client leg ends.
 */
export interface LegInfo {
  sid: string;
  status: string;
  to: string | null;
  from: string | null;
  parentCallSid: string | null;
}

const ENDED = new Set(["completed", "canceled", "busy", "no-answer", "failed"]);

export function isEnded(status: string | null | undefined): boolean {
  return status != null && ENDED.has(status);
}

/** The leg belongs to this user's Voice SDK identity. */
export function ownsLeg(leg: Pick<LegInfo, "to" | "from">, userId: string): boolean {
  if (!userId) return false;
  const identity = `client:user-${userId}`;
  return leg.to === identity || leg.from === identity;
}

/** What to end, in order: the leg itself, then its parent. Ended ones are skipped. */
export function legsToEnd(leg: LegInfo, parent: LegInfo | null): string[] {
  const out: string[] = [];
  if (!isEnded(leg.status)) out.push(leg.sid);
  if (parent && parent.sid !== leg.sid && !isEnded(parent.status)) out.push(parent.sid);
  return out;
}

/** The Twilio status that ends a call: a ringing one is canceled, a live one completed. */
export function endingStatus(status: string): "canceled" | "completed" {
  return status === "queued" || status === "ringing" || status === "initiated"
    ? "canceled"
    : "completed";
}
