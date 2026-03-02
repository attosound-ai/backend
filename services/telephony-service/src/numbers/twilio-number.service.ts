import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Twilio from "twilio";

export interface AvailableNumber {
  phoneNumber: string;
  friendlyName: string;
  locality: string;
  region: string;
}

export interface ProvisionResult {
  twilioNumberSid: string;
  phoneNumber: string;
  friendlyName: string;
}

/**
 * Low-level wrapper around Twilio's Phone Number APIs.
 * Single Responsibility: interact with Twilio REST API only.
 */
@Injectable()
export class TwilioNumberService {
  private readonly logger = new Logger(TwilioNumberService.name);
  private readonly twilioClient: Twilio.Twilio;

  constructor(private readonly config: ConfigService) {
    const accountSid = this.config.get<string>("twilio.accountSid", "");
    const authToken = this.config.get<string>("twilio.authToken", "");
    const devMode = this.config.get<boolean>("twilio.devMode", false);

    if (!devMode && (!accountSid || !authToken)) {
      throw new Error(
        "Twilio credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) are required " +
          "when TWILIO_DEV_MODE is not enabled.",
      );
    }

    this.twilioClient = Twilio(accountSid, authToken);
  }

  /** Search for available local phone numbers in a given country/area. */
  async searchAvailable(
    country = "US",
    options: { areaCode?: string; limit?: number } = {},
  ): Promise<AvailableNumber[]> {
    const { areaCode, limit = 5 } = options;

    const params: Record<string, unknown> = {
      voiceEnabled: true,
      limit,
    };
    if (areaCode) params.areaCode = areaCode;

    const numbers = await this.withRetry(
      () =>
        this.twilioClient
          .availablePhoneNumbers(country)
          .local.list(params),
      "searchAvailable",
    );

    return numbers.map((n) => ({
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      locality: n.locality,
      region: n.region,
    }));
  }

  /**
   * Purchase a phone number and configure its voice webhook.
   * The voiceUrl will point to our incoming call handler.
   */
  async provision(
    phoneNumber: string,
    voiceUrl: string,
    statusCallbackUrl: string,
  ): Promise<ProvisionResult> {
    this.logger.log("Provisioning number: %s", phoneNumber);

    const incoming = await this.withRetry(
      () =>
        this.twilioClient.incomingPhoneNumbers.create({
          phoneNumber,
          voiceUrl,
          voiceMethod: "POST",
          statusCallback: statusCallbackUrl,
          statusCallbackMethod: "POST",
        }),
      "provision",
    );

    this.logger.log(
      "Number provisioned: sid=%s number=%s",
      incoming.sid,
      incoming.phoneNumber,
    );

    return {
      twilioNumberSid: incoming.sid,
      phoneNumber: incoming.phoneNumber,
      friendlyName: incoming.friendlyName,
    };
  }

  /** Release (delete) a provisioned phone number from the Twilio account. */
  async release(twilioNumberSid: string): Promise<void> {
    this.logger.log("Releasing number: sid=%s", twilioNumberSid);
    await this.twilioClient.incomingPhoneNumbers(twilioNumberSid).remove();
    this.logger.log("Number released: sid=%s", twilioNumberSid);
  }

  /** Update the voice webhook URL for an existing number. */
  async updateWebhook(
    twilioNumberSid: string,
    voiceUrl: string,
  ): Promise<void> {
    await this.twilioClient
      .incomingPhoneNumbers(twilioNumberSid)
      .update({ voiceUrl, voiceMethod: "POST" });
    this.logger.log("Webhook updated for sid=%s", twilioNumberSid);
  }

  /**
   * Retry wrapper for Twilio API calls with exponential backoff.
   * Only retries on transient errors (429 rate limit, 503 unavailable, network).
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    label: string,
    maxAttempts = 3,
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (err: unknown) {
        if (!this.isTransientError(err) || attempt === maxAttempts) {
          throw err;
        }
        const delayMs = Math.pow(2, attempt - 1) * 1000;
        this.logger.warn(
          "%s failed (attempt %d/%d), retrying in %dms: %s",
          label,
          attempt,
          maxAttempts,
          delayMs,
          err,
        );
        await this.sleep(delayMs);
      }
    }
    throw new Error(`${label} failed after ${maxAttempts} attempts`);
  }

  private isTransientError(err: unknown): boolean {
    if (err && typeof err === "object") {
      const status = (err as { status?: number }).status;
      if (status === 429 || status === 503) return true;
      const code = (err as { code?: string }).code;
      if (
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "ENOTFOUND" ||
        code === "EAI_AGAIN"
      ) {
        return true;
      }
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
