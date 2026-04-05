import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  forwardRef,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Kafka, Consumer, EachMessagePayload } from "kafkajs";
import { CallsService } from "../calls/calls.service";
import { NumberProvisioningService } from "../numbers/number-provisioning.service";
import { AudioStorageService } from "../media/audio-storage.service";

@Injectable()
export class KafkaConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumer.name);
  private readonly consumer: Consumer;

  constructor(
    private readonly config: ConfigService,
    @Inject(forwardRef(() => CallsService))
    private readonly callsService: CallsService,
    private readonly numberProvisioning: NumberProvisioningService,
    private readonly audioStorage: AudioStorageService,
  ) {
    const brokers =
      this.config.get<string[]>("kafka.brokers") ?? ["localhost:9092"];
    const useTls = this.config.get<boolean>("kafka.useTls") ?? false;
    const kafka = new Kafka({
      clientId: "telephony-service",
      brokers,
      ...(useTls && {
        ssl: true,
        sasl: {
          mechanism: "scram-sha-256" as const,
          username: this.config.get<string>("kafka.saslUsername") ?? "",
          password: this.config.get<string>("kafka.saslPassword") ?? "",
        },
      }),
    });
    this.consumer = kafka.consumer({ groupId: "telephony-service" });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({
        topics: ["payment.completed", "subscription.cancelled", "user.deleted"],
        fromBeginning: false,
      });
      await this.consumer.run({
        eachMessage: (payload) => this.handleMessage(payload),
      });
      this.logger.log(
        "Kafka consumer started (topics=payment.completed, subscription.cancelled, user.deleted)",
      );
    } catch (err) {
      this.logger.error("Kafka consumer failed to start: %s", err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.disconnect();
    this.logger.log("Kafka consumer disconnected");
  }

  private async handleMessage({
    topic,
    message,
  }: EachMessagePayload): Promise<void> {
    try {
      const value = message.value?.toString();
      if (!value) return;

      const event = JSON.parse(value);
      const eventType = event.event_type || event.eventType || topic;
      this.logger.log("Received event: %s (topic=%s)", eventType, topic);

      switch (topic) {
        case "payment.completed":
          await this.handlePaymentCompleted(event);
          break;
        case "subscription.cancelled":
          await this.handleSubscriptionCancelled(event);
          break;
        case "user.deleted":
          await this.handleUserDeleted(event);
          break;
        default:
          this.logger.debug("Unhandled topic: %s", topic);
      }
    } catch (err) {
      this.logger.error("Error processing Kafka message: %s", err);
    }
  }

  /**
   * When payment completes, provision a unique Twilio number for the user.
   * Replaces the old logic that used a fixed bridge number.
   */
  private async handlePaymentCompleted(
    event: Record<string, string>,
  ): Promise<void> {
    const userId = event.user_id;
    const subscriptionId = event.transaction_id || event.subscription_id;
    const creatorName = event.creator_name;

    if (!userId) {
      this.logger.warn("payment.completed event missing user_id");
      return;
    }

    try {
      const phoneNumber = await this.numberProvisioning.assignNumberToUser(
        userId,
        subscriptionId || "",
        creatorName,
      );
      this.logger.log(
        "Number %s provisioned for user %s after payment",
        phoneNumber,
        userId,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(
        "Failed to provision number for user %s: %s",
        userId,
        reason,
      );
      try {
        await this.numberProvisioning.publishProvisioningFailed(userId, reason);
      } catch (kafkaErr) {
        this.logger.warn(
          "Failed to publish number.provisioning.failed for user %s: %s",
          userId,
          kafkaErr,
        );
      }
    }
  }

  /**
   * Fix #4 + #6: On account deletion, release Twilio numbers + delete S3 audio.
   * NOTE: DB rows (calls, projects, audio_segments, phone_number_assignments)
   * are already deleted by user-service before this event fires.
   */
  private async handleUserDeleted(
    event: Record<string, unknown>,
  ): Promise<void> {
    const data = (event.data as Record<string, unknown>) ?? event;
    const userIds = (data.userIds as string[]) ?? [];
    if (userIds.length === 0) return;

    for (const userId of userIds) {
      // Fix #6: Release Twilio number (uses in-memory lookup, not DB)
      try {
        await this.numberProvisioning.releaseNumber(userId);
        this.logger.log(`Released Twilio number for deleted user ${userId}`);
      } catch (err) {
        this.logger.warn(`No Twilio number to release for user ${userId}: ${err}`);
      }

      // Fix #4: Delete audio segments from S3/MinIO
      try {
        await this.audioStorage.deleteUserFiles(userId);
        this.logger.log(`Deleted S3 audio files for user ${userId}`);
      } catch (err) {
        this.logger.warn(`S3 cleanup failed for user ${userId}: ${err}`);
      }
    }

    this.logger.log(`Telephony cleanup done for users: ${userIds.join(", ")}`);
  }

  /** When subscription is cancelled, release the user's number back to pool. */
  private async handleSubscriptionCancelled(
    event: Record<string, string>,
  ): Promise<void> {
    const userId = event.user_id;
    if (!userId) {
      this.logger.warn("subscription.cancelled event missing user_id");
      return;
    }

    try {
      await this.numberProvisioning.releaseNumber(userId);
      this.logger.log("Number released for user %s after cancellation", userId);
    } catch (err) {
      this.logger.error(
        "Failed to release number for user %s: %s",
        userId,
        err,
      );
    }
  }
}
