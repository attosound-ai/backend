import { Injectable, Logger } from "@nestjs/common";

/**
 * Fire-and-forget PostHog capture for backend call-path traceability.
 *
 * The whole server side was previously dark — errors went to stdout only, so a
 * call could not be reconstructed end-to-end. This emits an event at each step
 * of the call path (incoming → fan-out → dial-status → push) keyed by the
 * Twilio `call_sid` and attributed to the user id as `distinct_id`, so backend
 * events land on the SAME PostHog person as the client events and a single call
 * can be stitched across client + server + Twilio by CallSid.
 *
 * Uses the global `fetch` (Node 18+) so it adds NO dependency and no Docker
 * change. Never throws — telemetry must never affect call handling.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly apiKey =
    process.env.POSTHOG_API_KEY ||
    "phc_c7uYNqA3Y2DCrRHDhjUM0a4LWZDUViqdj1PCTUoNCrz";
  private readonly host = (
    process.env.POSTHOG_HOST || "https://us.i.posthog.com"
  ).replace(/\/+$/, "");

  capture(
    distinctId: string | number | null | undefined,
    event: string,
    properties: Record<string, unknown> = {},
  ): void {
    void this.send(
      distinctId === null || distinctId === undefined
        ? "telephony-service"
        : String(distinctId),
      event,
      properties,
    );
  }

  private async send(
    distinctId: string,
    event: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    if (!this.apiKey) return;
    try {
      const res = await fetch(`${this.host}/capture/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.apiKey,
          event,
          distinct_id: distinctId,
          properties: { ...properties, service: "telephony-service" },
          timestamp: new Date().toISOString(),
        }),
      });
      if (!res.ok) {
        this.logger.warn(`PostHog capture ${event} -> HTTP ${res.status}`);
      }
    } catch (err) {
      this.logger.warn(
        `PostHog capture ${event} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
