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
