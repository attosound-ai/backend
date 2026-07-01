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
import { UsersClientService } from "../users-client/users-client.service";
import { PushService } from "../push/push.service";
import { AnalyticsService } from "../analytics/analytics.service";

@Controller("telephony/webhooks/voice")
@UseGuards(TwilioSignatureGuard)
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly callsService: CallsService,
    private readonly config: ConfigService,
    private readonly kafka: KafkaProducer,
    private readonly usersClient: UsersClientService,
    private readonly pushService: PushService,
    private readonly analytics: AnalyticsService,
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
      this.analytics.capture(null, "backend_call_rejected_unassigned", {
        call_sid: callSid,
        from,
        to,
      });
      response.say("Sorry, this number is not currently assigned. Goodbye.");
      response.hangup();
      res.type("text/xml").send(response.toString());
      return;
    }

    // Fan-out: enumerate every linked identity (rep + managed creators)
    // for the bridge owner. The Voice SDK on iOS can only register ONE
    // identity at a time per device, so without fan-out a PSTN call to
    // the inactive account's bridge dies instantly. Twilio dials all
    // <Client> legs in parallel; only the legs whose identity is actually
    // registered ring through. The others no-answer silently.
    //
    // getLinkedAccountIds is fail-soft: on any failure it returns
    // [assignment.userId] so we degrade to the legacy single-client TwiML.
    const linkedIds = await this.usersClient.getLinkedAccountIds(
      assignment.userId,
    );
    const targets =
      linkedIds.length > 0 ? linkedIds : [Number(assignment.userId)];

    // Create a call record (attributed to the bridge owner, regardless
    // of which linked identity ultimately answers).
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
        fanoutTargets: targets,
      },
    });

    this.kafka.publish("call.started", {
      callSid,
      userId: assignment.userId,
      fromNumber: from,
      toNumber: to,
      startedAt: new Date().toISOString(),
    });

    // Single <Dial> with N <Client> children — first to answer wins, the
    // parent dial-status fires once. N independent <Dial> elements would
    // create N independent call SIDs with N independent callbacks.
    const webhookBaseUrl = this.config.get<string>("webhookBaseUrl");
    const dial = response.dial({
      // answerOnBridge defers the inbound PSTN leg's SIP 200 OK until a
      // <Client> leg actually answers, so Twilio replies 180/183 (ringing)
      // to Securus until pickup and then answers + bridges in one step.
      // Without it, Twilio answered the inbound leg IMMEDIATELY and then
      // rang the rep — which Securus reads as "answered, then a 3rd party
      // was bridged" = three-way call ("no three party calls allowed").
      // This makes the inbound flow match the two outbound dials below
      // (already answerOnBridge:true). The post-answer two-way audio+DTMF
      // bridge is UNCHANGED, so the rep's client-side "press 1" accept
      // (front useTwilioVoice.sendCallDigits, gated on state==='connected')
      // still traverses the bridge to Securus exactly as before.
      answerOnBridge: true,
      callerId: to,
      action: `${webhookBaseUrl}/telephony/webhooks/voice/dial-status`,
      timeout: 30,
    });

    // The app's incoming screen shows the @username of the BRIDGE this call is
    // FOR (the creator/owner the dialled number `to` resolves to), NOT the raw
    // external caller — because <Dial callerId=to> makes the app's invite `from`
    // the bridge number itself, which the app reverse-looks-up to the owner's
    // @username. Match that on the CallKit banner (now the single ring surface):
    // use the bridge owner's username. `assignment` is already resolved from
    // `to` above. Fail-soft: any miss falls back to CNAM → number → "Unknown".
    let displayName = callerName?.trim() || from || "Unknown";
    try {
      const ownerUsername = await this.usersClient.getUsernameById(
        String(assignment.userId),
      );
      if (ownerUsername) {
        displayName = `@${ownerUsername}`;
      }
    } catch (err) {
      this.logger.warn(
        "Bridge owner @username lookup failed (sid=%s to=%s): %s",
        callSid,
        to,
        err instanceof Error ? err.message : String(err),
      );
    }

    for (const targetId of targets) {
      const client = dial.client(`user-${targetId}`);
      // DisplayName is per-<Client> so CallKit's
      // setIncomingCallContactHandleTemplate template renders correctly
      // regardless of which identity Twilio happens to reach first.
      client.parameter({ name: "DisplayName", value: displayName });
      // TargetUserId is the bridge owner (the account the caller dialled),
      // not the SDK identity that picks up. The client uses it to
      // auto-switch to the right account before showing CallKit.
      client.parameter({
        name: "TargetUserId",
        value: String(assignment.userId),
      });
    }

    this.logger.log(
      "Routing call %s fan-out to %d clients (ids=%s) target=%s",
      callSid,
      targets.length,
      targets.join(","),
      assignment.userId,
    );

    this.analytics.capture(assignment.userId, "backend_call_incoming", {
      call_sid: callSid,
      from,
      to,
      owner_user_id: assignment.userId,
      fanout_targets: targets,
      fanout_count: targets.length,
      caller_name: callerName || null,
      display_name: displayName,
      username_resolved: displayName.startsWith("@"),
    });

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
    const callerUserId =
      from?.replace("client:", "").replace("user-", "") || "";

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
      const client = dial.client(to);

      // Enrich the invite with the caller's username so the recipient's
      // CallKit (iOS) / notification (Android) banner shows `@username`
      // instead of the raw `client:user-{id}` identity.
      // The receiving app substitutes ${DisplayName} via Twilio's
      // setIncomingCallContactHandleTemplate(...) API.
      //
      // The lookup is timeout-bounded and never throws; on any failure
      // we still send DisplayName, falling back to the raw `from` so the
      // template ALWAYS resolves to something readable. (Without a
      // value, the receiver would render the literal `${DisplayName}`.)
      const callerUsername =
        await this.usersClient.getUsernameById(callerUserId);
      client.parameter({
        name: "DisplayName",
        value: callerUsername ? `@${callerUsername}` : from || "Unknown",
      });
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

      // Missed-call fallback: when an inbound bridge call ends without
      // being answered, send a regular APNS/FCM push to every linked
      // account on the device so the user at least sees a missed-call
      // notification. Without this, a Voice SDK that fails to wake the
      // app (unregistered identity, watchdog kill, push-cred mismatch)
      // would leave the call vanishing silently.
      //
      // `answeredAt` is the authoritative signal of "did the user pick
      // up" thanks to the Bug #10 fix — if it's still null after the
      // dial action completes, the call was genuinely missed.
      const isMissed =
        call.direction === "inbound" &&
        call.answeredAt == null &&
        (mappedStatus === "no-answer" ||
          mappedStatus === "busy" ||
          mappedStatus === "failed");
      if (isMissed) {
        const callerDisplay =
          (call.metadata?.callerName as string | undefined)?.trim() ||
          call.fromNumber ||
          "Unknown";
        const fanoutTargets = Array.isArray(call.metadata?.fanoutTargets)
          ? (call.metadata.fanoutTargets as number[])
          : undefined;
        // Fire-and-forget — never block the webhook response on push delivery.
        void this.pushService.sendMissedCallPush(
          call.userId,
          callerDisplay,
          callSid,
          fanoutTargets,
        );
      }

      this.analytics.capture(call.userId, "backend_call_dial_status", {
        call_sid: callSid,
        dial_status: dialStatus,
        mapped_status: mappedStatus,
        duration_sec: duration ?? 0,
        direction: call.direction,
        answered: call.answeredAt != null,
        is_missed: isMissed,
      });
    }

    // Return empty TwiML (call is over)
    const response = new TwiML.VoiceResponse();
    res.type("text/xml").send(response.toString());
  }
}
