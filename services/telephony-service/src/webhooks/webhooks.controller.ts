import {
  Controller,
  Post,
  Body,
  Res,
  UseGuards,
  Logger,
  HttpCode,
} from "@nestjs/common";
import { Response } from "express";
import { twiml as TwiML } from "twilio";
import { ConfigService } from "@nestjs/config";
import { TwilioSignatureGuard } from "./guards/twilio-signature.guard";
import { CallsService } from "../calls/calls.service";
import { KafkaProducer } from "../kafka/kafka.producer";

@Controller("telephony/webhooks/voice")
@UseGuards(TwilioSignatureGuard)
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly callsService: CallsService,
    private readonly config: ConfigService,
    private readonly kafka: KafkaProducer,
  ) {}

  /**
   * Twilio calls this when an incoming PSTN call arrives on a bridge number.
   * We resolve the user and return TwiML to dial the Voice SDK client.
   */
  @Post("incoming")
  @HttpCode(200)
  async handleIncomingCall(
    @Body() body: Record<string, string>,
    @Res() res: Response,
  ): Promise<void> {
    const callSid = body.CallSid;
    const from = body.From;
    const to = body.To;
    const callerName = body.CallerName || "";

    this.logger.log("Incoming call: sid=%s from=%s to=%s", callSid, from, to);

    // Resolve which user owns this phone number
    const assignment = await this.callsService.resolveUserByPhoneNumber(to);

    const response = new TwiML.VoiceResponse();

    if (!assignment) {
      this.logger.warn("No assignment found for number: %s", to);
      response.say("Sorry, this number is not currently assigned. Goodbye.");
      response.hangup();
      res.type("text/xml").send(response.toString());
      return;
    }

    // Create a call record
    await this.callsService.createCall({
      twilioCallSid: callSid,
      fromNumber: from,
      toNumber: to,
      userId: assignment.userId,
      metadata: {
        callerName,
        fromCity: body.FromCity,
        fromState: body.FromState,
        fromCountry: body.FromCountry,
      },
    });

    this.kafka.publish("call.started", {
      callSid,
      userId: assignment.userId,
      fromNumber: from,
      toNumber: to,
      startedAt: new Date().toISOString(),
    });

    // Dial the Voice SDK client using the user's identity
    const webhookBaseUrl = this.config.get<string>("webhookBaseUrl");
    const dial = response.dial({
      callerId: to,
      action: `${webhookBaseUrl}/telephony/webhooks/voice/dial-status`,
      timeout: 30,
    });
    dial.client(`user-${assignment.userId}`);

    this.logger.log(
      "Routing call %s to client user-%s",
      callSid,
      assignment.userId,
    );

    res.type("text/xml").send(response.toString());
  }

  /**
   * TwiML App Voice URL — Twilio calls this when a Voice SDK client
   * initiates an outbound call via voice.connect().
   *
   * Supports two modes:
   *  - recipientType=client → app-to-app VoIP call
   *  - recipientType=number → outbound PSTN call
   *
   * This endpoint does NOT affect the bridge-number PSTN→App flow,
   * which is configured separately on each Twilio phone number
   * and handled by the /incoming endpoint above.
   */
  @Post("outgoing")
  @HttpCode(200)
  async handleOutgoingCall(
    @Body() body: Record<string, string>,
    @Res() res: Response,
  ): Promise<void> {
    const to = body.To;
    const from = body.From; // e.g. "client:user-42"
    const recipientType = body.recipientType || "client";
    const callSid = body.CallSid;

    // Extract caller userId from "client:user-{id}" identity
    const callerUserId = from?.replace("client:", "").replace("user-", "") || "";

    this.logger.log(
      "Outgoing call: sid=%s from=%s to=%s type=%s",
      callSid,
      from,
      to,
      recipientType,
    );

    const response = new TwiML.VoiceResponse();
    const webhookBaseUrl = this.config.get<string>("webhookBaseUrl");

    if (recipientType === "client") {
      // App-to-app VoIP call
      const dial = response.dial({
        answerOnBridge: true,
        callerId: from,
        action: `${webhookBaseUrl}/telephony/webhooks/voice/dial-status`,
        timeout: 30,
      });
      dial.client(to);
    } else {
      // Outbound PSTN call
      const bridgeNumber = this.config.get<string>("twilio.bridgeNumber");
      const dial = response.dial({
        answerOnBridge: true,
        callerId: bridgeNumber,
        action: `${webhookBaseUrl}/telephony/webhooks/voice/dial-status`,
        timeout: 30,
      });
      dial.number(to);
    }

    // Create call records for both caller and recipient so either side can record
    const recipientUserId = to?.replace("user-", "") || "";
    await this.callsService
      .createCall({
        twilioCallSid: callSid,
        fromNumber: from || "",
        toNumber: to || "",
        userId: callerUserId,
        direction: "outbound",
        metadata: { recipientUserId, recipientType },
      })
      .catch((err) =>
        this.logger.warn("Failed to create outgoing call record: %s", err),
      );

    if (recipientUserId && recipientType === "client") {
      await this.callsService
        .createCall({
          twilioCallSid: callSid,
          fromNumber: from || "",
          toNumber: to || "",
          userId: recipientUserId,
          direction: "inbound",
          metadata: { callerUserId, recipientType },
        })
        .catch((err) =>
          this.logger.warn("Failed to create recipient call record: %s", err),
        );
    }

    this.kafka.publish("call.started", {
      callSid,
      userId: callerUserId,
      fromNumber: from,
      toNumber: to,
      direction: "outbound",
      startedAt: new Date().toISOString(),
    });

    res.type("text/xml").send(response.toString());
  }

  /**
   * Call status callback — Twilio sends updates as the call progresses.
   */
  @Post("status")
  @HttpCode(200)
  async handleStatusCallback(
    @Body() body: Record<string, string>,
  ): Promise<{ ok: true }> {
    const callSid = body.CallSid;
    const status = body.CallStatus;
    const duration = body.CallDuration
      ? parseInt(body.CallDuration, 10)
      : undefined;

    this.logger.log("Status callback: sid=%s status=%s", callSid, status);

    await this.callsService.updateCallStatus(callSid, status, duration);
    return { ok: true };
  }

  /**
   * Dial action callback — sent when the <Dial> verb completes.
   */
  @Post("dial-status")
  @HttpCode(200)
  async handleDialStatus(
    @Body() body: Record<string, string>,
    @Res() res: Response,
  ): Promise<void> {
    const callSid = body.CallSid;
    const dialStatus = body.DialCallStatus;
    const duration = body.DialCallDuration
      ? parseInt(body.DialCallDuration, 10)
      : undefined;

    this.logger.log(
      "Dial status: sid=%s dialStatus=%s duration=%s",
      callSid,
      dialStatus,
      duration,
    );

    // Map Dial status to call status
    const statusMap: Record<string, string> = {
      completed: "completed",
      "no-answer": "no-answer",
      busy: "busy",
      failed: "failed",
      canceled: "no-answer",
    };

    const mappedStatus = statusMap[dialStatus] || "completed";
    const call = await this.callsService.updateCallStatus(
      callSid,
      mappedStatus,
      duration,
    );

    if (call) {
      this.kafka.publish("call.ended", {
        callSid,
        userId: call.userId,
        status: mappedStatus,
        duration: duration ?? 0,
        endedAt: new Date().toISOString(),
      });
    }

    // Return empty TwiML (call is over)
    const response = new TwiML.VoiceResponse();
    res.type("text/xml").send(response.toString());
  }
}
