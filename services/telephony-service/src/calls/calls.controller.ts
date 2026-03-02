import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Headers,
  Logger,
  UnauthorizedException,
  NotFoundException,
} from "@nestjs/common";
import { CallsService } from "./calls.service";
import { AudioStorageService } from "../media/audio-storage.service";

@Controller("telephony/calls")
export class CallsController {
  private readonly logger = new Logger(CallsController.name);

  constructor(
    private readonly callsService: CallsService,
    private readonly storageService: AudioStorageService,
  ) {}

  /** List calls for the authenticated user. */
  @Get()
  async listCalls(
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    const calls = await this.callsService.getCallsForUser(uid);
    return { success: true, data: calls };
  }

  /** Get a single call by SID. */
  @Get(":callSid")
  async getCall(
    @Param("callSid") callSid: string,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    const call = await this.callsService.getCallBySid(callSid, uid);
    if (!call) throw new NotFoundException("Call not found");
    return { success: true, data: call };
  }

  /** Start audio capture (Media Stream) on an active call. */
  @Post(":callSid/stream/start")
  async startStream(
    @Param("callSid") callSid: string,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    const result = await this.callsService.startStream(callSid, uid);
    this.logger.log("Stream started for call %s by user %s", callSid, uid);
    return { success: true, data: result };
  }

  /** Stop audio capture on an active call. */
  @Post(":callSid/stream/stop")
  async stopStream(
    @Param("callSid") callSid: string,
    @Body("streamSid") streamSid: string,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    await this.callsService.stopStream(callSid, uid, streamSid);
    this.logger.log("Stream stopped for call %s by user %s", callSid, uid);
    return { success: true };
  }

  /** List audio segments for a call. */
  @Get(":callSid/segments")
  async listSegments(
    @Param("callSid") callSid: string,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    const segments = await this.callsService.getSegments(callSid, uid);

    // Add pre-signed download URLs
    const withUrls = await Promise.all(
      segments.map(async (seg) => ({
        ...seg,
        downloadUrl: await this.storageService.getPresignedUrl(
          seg.storageBucket,
          seg.storageKey,
        ),
      })),
    );

    return { success: true, data: withUrls };
  }

  private resolveUserId(headerUserId: string, authHeader: string): string {
    if (headerUserId) return headerUserId;

    if (authHeader?.startsWith("Bearer ")) {
      try {
        const payload = JSON.parse(
          Buffer.from(authHeader.slice(7).split(".")[1], "base64").toString(),
        );
        const uid = payload.sub || payload.user_id;
        if (uid) return String(uid);
      } catch {
        // fall through
      }
    }

    throw new UnauthorizedException("User ID not found");
  }
}
