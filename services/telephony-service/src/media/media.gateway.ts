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
          break;
        }

        case "media": {
          const { payload, timestamp, track } = msg.media;
          const streamSid = msg.streamSid;
          this.mediaService.appendChunk(
            streamSid,
            payload,
            parseInt(timestamp, 10),
            track || "inbound",
          );
          break;
        }

        case "stop": {
          const streamSid = msg.streamSid;
          this.logger.log("Stream stopped: sid=%s", streamSid);

          // Finalize and save the audio segment
          const session = this.mediaService.getSession(streamSid);
          if (session) {
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
