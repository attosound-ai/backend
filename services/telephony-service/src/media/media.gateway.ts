import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server } from "ws";
import { MediaService } from "./media.service";
import { CallsService } from "../calls/calls.service";
import { KafkaProducer } from "../kafka/kafka.producer";
import { AnalyticsService } from "../analytics/analytics.service";

/**
 * WebSocket gateway that receives Twilio Media Streams.
 *
 * When Twilio starts a Media Stream on a call, it opens a WebSocket to this
 * endpoint and sends raw mulaw/8kHz audio as base64-encoded chunks.
 *
 * Messages from Twilio follow this sequence:
 *   connected → start → media (repeating) → stop
 */
@WebSocketGateway({ path: "/telephony/media-stream" })
export class MediaGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(MediaGateway.name);

  constructor(
    private readonly mediaService: MediaService,
    private readonly callsService: CallsService,
    private readonly kafka: KafkaProducer,
    private readonly analytics: AnalyticsService,
  ) {}

  afterInit(server: Server): void {
    this.logger.log("Media Stream WebSocket gateway initialized");
  }

  handleConnection(client: WebSocket): void {
    this.logger.log("Twilio Media Stream connected");

    // Listen for raw messages (Twilio sends JSON strings, not Socket.IO events)
    client.addEventListener("message", (event) => {
      this.handleMessage(event.data as string);
    });
  }

  async handleDisconnect(client: WebSocket): Promise<void> {
    this.logger.log("Twilio Media Stream disconnected");
  }

  private async handleMessage(raw: string): Promise<void> {
    try {
      const msg = JSON.parse(raw);

      switch (msg.event) {
        case "connected":
          this.logger.log("Stream protocol: %s", msg.protocol);
          break;

        case "start": {
          const { streamSid, callSid, tracks, customParameters } = msg.start;

          // Extract callId and userId from custom parameters
          const callId =
            customParameters?.callId ||
            this.parseParam(customParameters, "callId") ||
            "";
          const userId =
            customParameters?.userId ||
            this.parseParam(customParameters, "userId") ||
            "";
          const track = (tracks as string[])?.join(",") || "both";

          this.mediaService.startSession(
            streamSid,
            callSid,
            callId,
            userId,
            track,
          );

          this.logger.log(
            "Stream started: sid=%s call=%s tracks=%s",
            streamSid,
            callSid,
            track,
          );

          // Telemetry: what tracks did Twilio actually fork? `track` is the
          // joined `tracks` array from the Twilio start frame. If the client
          // requested both_tracks but this reports only "inbound", Twilio is
          // NOT forking the remote (outbound) leg — the exact signature of the
          // "I'm recorded, the other party isn't" bug.
          this.analytics.capture(userId || null, "backend_recording_started", {
            call_sid: callSid,
            stream_sid: streamSid,
            call_id: callId,
            tracks_forked: track,
            both_tracks: track.includes("inbound") && track.includes("outbound"),
          });
          break;
        }

        case "media": {
          const { payload, timestamp, track } = msg.media;
          const streamSid = msg.streamSid;
          // Pass the RAW track label (may be undefined). appendChunk buckets
          // unknown/missing labels as inbound but counts them separately, so a
          // mislabeled remote track is visible instead of silently merged.
          this.mediaService.appendChunk(
            streamSid,
            payload,
            parseInt(timestamp, 10),
            track,
          );
          break;
        }

        case "stop": {
          const streamSid = msg.streamSid;
          this.logger.log("Stream stopped: sid=%s", streamSid);

          // Finalize and save the audio segment
          const session = this.mediaService.getSession(streamSid);
          if (session) {
            // Snapshot per-track buffers BEFORE finalize (which clears the
            // session). This is the smoking gun for the one-sided-recording
            // bug: inbound = local mic (rep's voice), outbound = what Twilio
            // played to the leg (the REMOTE party's voice). If outbound_* is
            // 0, the remote was never captured.
            const inboundChunks = session.inboundChunks.length;
            const outboundChunks = session.outboundChunks.length;
            const inboundBytes = session.inboundChunks.reduce(
              (s, b) => s + b.length,
              0,
            );
            const outboundBytes = session.outboundChunks.reduce(
              (s, b) => s + b.length,
              0,
            );
            // Frame-label counters (set during media frames, stable at stop).
            const framesLabeledInbound = session.framesLabeledInbound;
            const framesLabeledOutbound = session.framesLabeledOutbound;
            const framesMissingLabel = session.framesMissingLabel;
            const framesLabeledOther = session.framesLabeledOther;
            const firstOutboundFrameOffsetMs =
              session.firstOutboundTs === null
                ? null
                : session.firstOutboundTs - session.startTimestamp;

            const segmentIndex = await this.callsService.getNextSegmentIndex(
              session.callId,
            );

            const result = await this.mediaService.finalizeSession(
              streamSid,
              segmentIndex,
            );

            if (result) {
              const segment = await this.callsService.saveSegment({
                callId: session.callId,
                twilioStreamSid: streamSid,
                segmentIndex,
                track: session.track,
                startMs: result.startMs,
                endMs: result.endMs,
                durationMs: result.durationMs,
                fileSizeBytes: result.fileSizeBytes,
                storageBucket: result.storageBucket,
                storageKey: result.storageKey,
              });

              this.kafka.publish("segment.captured", {
                segmentId: segment.id,
                callId: session.callId,
                userId: session.userId,
                storagePath: result.storageKey,
                durationMs: result.durationMs,
              });
            }

            this.analytics.capture(
              session.userId || null,
              "backend_recording_segment",
              {
                call_sid: session.callSid,
                stream_sid: streamSid,
                segment_index: segmentIndex,
                tracks_config: session.track,
                inbound_chunks: inboundChunks,
                outbound_chunks: outboundChunks,
                inbound_bytes: inboundBytes,
                outbound_bytes: outboundBytes,
                // Diagnosis flags — one_sided is the exact bug signature.
                inbound_empty: inboundChunks === 0,
                outbound_empty: outboundChunks === 0,
                one_sided: (inboundChunks === 0) !== (outboundChunks === 0),
                duration_ms: result?.durationMs ?? 0,
                file_size_bytes: result?.fileSizeBytes ?? 0,
                saved: !!result,
              },
            );

            // Frame-label distribution — separates a genuine one-track fork
            // (first_outbound_frame_offset_ms == null → Twilio never forked the
            // remote) from a mislabeled remote (frames_missing_label/other > 0
            // while outbound_chunks == 0 → frames arrived but missed the
            // 'outbound' branch).
            this.analytics.capture(
              session.userId || null,
              "backend_recording_track_summary",
              {
                call_sid: session.callSid,
                stream_sid: streamSid,
                frames_total:
                  framesLabeledInbound +
                  framesLabeledOutbound +
                  framesMissingLabel +
                  framesLabeledOther,
                frames_labeled_inbound: framesLabeledInbound,
                frames_labeled_outbound: framesLabeledOutbound,
                frames_missing_label: framesMissingLabel,
                frames_labeled_other: framesLabeledOther,
                first_outbound_frame_offset_ms: firstOutboundFrameOffsetMs,
              },
            );
          } else {
            // No session for this streamSid — the start frame was never
            // processed, or finalize already ran. Either way the segment is
            // lost; make that visible instead of silently dropping it.
            this.analytics.capture(null, "backend_recording_segment_orphaned", {
              stream_sid: streamSid,
            });
          }
          break;
        }

        default:
          this.logger.debug("Unhandled stream event: %s", msg.event);
      }
    } catch (err) {
      this.logger.error("Error processing media stream message: %s", err);
    }
  }

  /** Parse a parameter from custom params (can be key=value format). */
  private parseParam(
    params: Record<string, string> | undefined,
    key: string,
  ): string {
    if (!params) return "";
    // Twilio passes params as parameter1, parameter2, etc.
    for (const val of Object.values(params)) {
      if (typeof val === "string" && val.startsWith(`${key}=`)) {
        return val.slice(key.length + 1);
      }
    }
    return "";
  }
}
