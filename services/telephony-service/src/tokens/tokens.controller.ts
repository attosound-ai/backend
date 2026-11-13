import {
  Controller,
  Get,
  Headers,
  Logger,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { jwt as TwilioJwt } from "twilio";
import { AnalyticsService } from "../analytics/analytics.service";
import { verifiedUserIdFromBearer } from "../common/verified-user-id";
import { choosePushCredential, normalizePlatform } from "./push-credential";

const { AccessToken } = TwilioJwt;
const { VoiceGrant } = AccessToken;

@Controller("telephony/tokens")
export class TokensController {
  private readonly logger = new Logger(TokensController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly analytics: AnalyticsService,
  ) {}

  /**
   * Generate a Twilio Access Token with a VoiceGrant for the authenticated user.
   * The user ID is extracted from the JWT (set by Kong or auth middleware).
   */
  @Get("voice")
  getVoiceToken(
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
    @Query("platform") platform?: string,
  ): { token: string; identity: string } {
    // Extract user ID from JWT or header
    const resolvedUserId = userId || this.extractUserIdFromJwt(authHeader);
    if (!resolvedUserId) {
      throw new UnauthorizedException("User ID not found");
    }

    const identity = `user-${resolvedUserId}`;

    const accountSid = this.config.get<string>("twilio.accountSid", "");
    const apiKeySid = this.config.get<string>("twilio.apiKeySid", "");
    const apiKeySecret = this.config.get<string>("twilio.apiKeySecret", "");
    const twimlAppSid = this.config.get<string>("twilio.twimlAppSid", "");
    const pushChoice = choosePushCredential(platform, {
      apns: this.config.get<string>("twilio.pushCredentialSidApns", ""),
      android: this.config.get<string>("twilio.pushCredentialSidAndroid", ""),
      fcmLegacy: this.config.get<string>("twilio.pushCredentialSidFcm", ""),
    });
    const pushCredentialSid = pushChoice.sid;

    const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
      identity,
      ttl: 3600, // 1 hour
    });

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: twimlAppSid,
      incomingAllow: true,
      ...(pushCredentialSid && { pushCredentialSid }),
    });

    token.addGrant(voiceGrant);

    const platformName = normalizePlatform(platform);
    if (pushChoice.missingReason) {
      // The token still goes out (outgoing calls work); incoming pushes cannot
      // reach this device until the credential exists.
      this.logger.warn(
        `Voice token WITHOUT push credential: identity=${identity} platform=${platformName} reason=${pushChoice.missingReason}`,
      );
    } else {
      this.logger.log(
        `Voice token generated: identity=${identity} platform=${platformName} pushCredSource=${pushChoice.source}`,
      );
    }

    this.analytics.capture(resolvedUserId, "backend_voice_token_issued", {
      identity,
      platform: platformName,
      has_push_cred: !!pushCredentialSid,
      push_cred_source: pushChoice.source,
      push_cred_missing_reason: pushChoice.missingReason,
    });

    return {
      token: token.toJwt(),
      identity,
    };
  }

  /** The user ID from a Bearer JWT signed with our secret (see verified-user-id.ts). */
  private extractUserIdFromJwt(authHeader: string): string | null {
    return verifiedUserIdFromBearer(authHeader);
  }
}
