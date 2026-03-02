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

const { AccessToken } = TwilioJwt;
const { VoiceGrant } = AccessToken;

@Controller("telephony/tokens")
export class TokensController {
  private readonly logger = new Logger(TokensController.name);

  constructor(private readonly config: ConfigService) {}

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
    const pushCredentialFcm = this.config.get<string>(
      "twilio.pushCredentialSidFcm",
      "",
    );
    const pushCredentialApns = this.config.get<string>(
      "twilio.pushCredentialSidApns",
      "",
    );

    const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
      identity,
      ttl: 3600, // 1 hour
    });

    // Select push credential based on client platform
    const pushCredentialSid =
      platform === "ios" ? pushCredentialApns : pushCredentialFcm;

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: twimlAppSid,
      incomingAllow: true,
      ...(pushCredentialSid && { pushCredentialSid }),
    });

    token.addGrant(voiceGrant);

    this.logger.log(
      `Voice token generated: identity=${identity} platform=${platform || "unknown"} pushCredSid=${pushCredentialSid}`,
    );

    return {
      token: token.toJwt(),
      identity,
    };
  }

  /** Extract user ID from the Authorization Bearer JWT. */
  private extractUserIdFromJwt(authHeader: string): string | null {
    if (!authHeader?.startsWith("Bearer ")) return null;

    try {
      const jwtToken = authHeader.slice(7);
      const payload = JSON.parse(
        Buffer.from(jwtToken.split(".")[1], "base64").toString(),
      );
      return payload.sub || payload.user_id || null;
    } catch {
      return null;
    }
  }
}
