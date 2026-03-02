import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import Twilio from "twilio";
import { PhoneNumberAssignment } from "../entities/phone-number-assignment.entity";
import { Call } from "../entities/call.entity";
import { AudioSegment } from "../entities/audio-segment.entity";

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);
  private readonly twilioClient: Twilio.Twilio;

  constructor(
    @InjectRepository(PhoneNumberAssignment)
    private readonly assignmentRepo: Repository<PhoneNumberAssignment>,
    @InjectRepository(Call)
    private readonly callRepo: Repository<Call>,
    @InjectRepository(AudioSegment)
    private readonly segmentRepo: Repository<AudioSegment>,
    private readonly config: ConfigService,
  ) {
    const accountSid = this.config.get<string>("twilio.accountSid");
    const authToken = this.config.get<string>("twilio.authToken");
    this.twilioClient = Twilio(accountSid, authToken);
  }

  /** Find the user assigned to a Twilio phone number. */
  async resolveUserByPhoneNumber(
    phoneNumber: string,
  ): Promise<PhoneNumberAssignment | null> {
    return this.assignmentRepo.findOne({
      where: { phoneNumber, status: "active" },
    });
  }

  /** Create a call record when an incoming call is received. */
  async createCall(data: {
    twilioCallSid: string;
    fromNumber: string;
    toNumber: string;
    userId: string;
    metadata?: Record<string, unknown>;
  }): Promise<Call> {
    const call = this.callRepo.create({
      ...data,
      direction: "inbound",
      status: "ringing",
      startedAt: new Date(),
    });
    const saved = await this.callRepo.save(call);
    this.logger.log(
      "Call created: sid=%s from=%s to=%s user=%s",
      data.twilioCallSid,
      data.fromNumber,
      data.toNumber,
      data.userId,
    );
    return saved;
  }

  /** Update call status from Twilio status callback. */
  async updateCallStatus(
    callSid: string,
    status: string,
    duration?: number,
  ): Promise<Call | null> {
    const call = await this.callRepo.findOne({
      where: { twilioCallSid: callSid },
    });
    if (!call) return null;

    call.status = status;

    if (status === "in-progress" && !call.answeredAt) {
      call.answeredAt = new Date();
    }

    if (
      status === "completed" ||
      status === "no-answer" ||
      status === "busy" ||
      status === "failed"
    ) {
      call.endedAt = new Date();
      if (duration != null) {
        call.durationSeconds = duration;
      }
    }

    const saved = await this.callRepo.save(call);
    this.logger.log("Call %s status → %s", callSid, status);
    return saved;
  }

  /** Start a Twilio Media Stream on an active call. */
  async startStream(
    callSid: string,
    userId: string,
  ): Promise<{ streamSid: string }> {
    // Try exact callSid match first, then fall back to most recent active call.
    // The SDK client leg has a different callSid than the parent PSTN leg stored in DB.
    let call = await this.callRepo.findOne({
      where: { twilioCallSid: callSid, userId },
    });
    if (!call) {
      call = await this.callRepo.findOne({
        where: [
          { userId, status: "in-progress" },
          { userId, status: "ringing" },
        ],
        order: { startedAt: "DESC" },
      });
    }
    if (!call) throw new NotFoundException("Call not found");

    // Auto-upgrade: if the call is still "ringing" in DB (status callback delayed
    // or missing), upgrade to "in-progress" since the user clearly accepted.
    if (call.status === "ringing") {
      call.status = "in-progress";
      call.answeredAt = new Date();
      await this.callRepo.save(call);
    }

    const parentCallSid = call.twilioCallSid;
    const webhookBaseUrl =
      this.config.get<string>("webhookBaseUrl") ?? "http://localhost:3009";
    const streamUrl = `${webhookBaseUrl.replace("http", "ws")}/telephony/media-stream`;

    // Use the parent call SID for the Twilio REST API
    const stream = await this.twilioClient
      .calls(parentCallSid)
      .streams.create({
        url: streamUrl,
        name: `capture-${parentCallSid}-${Date.now()}`,
        track: "both_tracks",
        "parameter1.name": "callId",
        "parameter1.value": call.id,
        "parameter2.name": "userId",
        "parameter2.value": userId,
      });

    this.logger.log(
      "Stream started: sid=%s call=%s",
      stream.sid,
      parentCallSid,
    );
    return { streamSid: stream.sid };
  }

  /** Stop a Twilio Media Stream on an active call by stream SID. */
  async stopStream(
    callSid: string,
    userId: string,
    streamSid: string,
  ): Promise<void> {
    // Same fallback logic as startStream for child vs parent callSid
    let call = await this.callRepo.findOne({
      where: { twilioCallSid: callSid, userId },
    });
    if (!call) {
      call = await this.callRepo.findOne({
        where: [
          { userId, status: "in-progress" },
          { userId, status: "ringing" },
        ],
        order: { startedAt: "DESC" },
      });
    }
    if (!call) throw new NotFoundException("Call not found");

    const parentCallSid = call.twilioCallSid;
    await this.twilioClient
      .calls(parentCallSid)
      .streams(streamSid)
      .update({ status: "stopped" });
    this.logger.log(
      "Stream stopped: sid=%s call=%s",
      streamSid,
      parentCallSid,
    );
  }

  /** Get calls for a user. */
  async getCallsForUser(userId: string): Promise<Call[]> {
    return this.callRepo.find({
      where: { userId },
      order: { startedAt: "DESC" },
      take: 50,
    });
  }

  /** Get a single call by SID. */
  async getCallBySid(callSid: string, userId: string): Promise<Call | null> {
    return this.callRepo.findOne({
      where: { twilioCallSid: callSid, userId },
      relations: ["segments"],
    });
  }

  /** Get segments for a call. */
  async getSegments(callSid: string, userId: string): Promise<AudioSegment[]> {
    // Try exact callSid match first, then fall back to most recent call.
    // The SDK client leg has a different callSid than the parent PSTN leg stored in DB.
    let call = await this.callRepo.findOne({
      where: { twilioCallSid: callSid, userId },
    });
    if (!call) {
      call = await this.callRepo.findOne({
        where: { userId },
        order: { startedAt: "DESC" },
      });
    }
    if (!call) return [];
    return this.segmentRepo.find({
      where: { callId: call.id },
      order: { segmentIndex: "ASC" },
    });
  }

  /** Save audio segment metadata. */
  async saveSegment(data: {
    callId: string;
    twilioStreamSid: string | null;
    segmentIndex: number;
    track: string;
    startMs: number;
    endMs: number;
    durationMs: number;
    fileSizeBytes: number;
    storageBucket: string;
    storageKey: string;
  }): Promise<AudioSegment> {
    const segment = this.segmentRepo.create(data);
    return this.segmentRepo.save(segment);
  }

  /** Get next segment index for a call. */
  async getNextSegmentIndex(callId: string): Promise<number> {
    const count = await this.segmentRepo.count({ where: { callId } });
    return count + 1;
  }

  /** Create or update a phone number assignment. */
  async upsertPhoneAssignment(data: {
    phoneNumber: string;
    userId: string;
    artistName?: string;
    subscriptionId?: string;
  }): Promise<PhoneNumberAssignment> {
    let assignment = await this.assignmentRepo.findOne({
      where: { phoneNumber: data.phoneNumber },
    });

    if (assignment) {
      assignment.userId = data.userId;
      if (data.artistName) assignment.artistName = data.artistName;
      if (data.subscriptionId) assignment.subscriptionId = data.subscriptionId;
      assignment.status = "active";
    } else {
      assignment = this.assignmentRepo.create({
        phoneNumber: data.phoneNumber,
        userId: data.userId,
        artistName: data.artistName || null,
        subscriptionId: data.subscriptionId || null,
        status: "active",
      });
    }

    const saved = await this.assignmentRepo.save(assignment);
    this.logger.log(
      "Phone assignment upserted: %s → user %s",
      data.phoneNumber,
      data.userId,
    );
    return saved;
  }
}
