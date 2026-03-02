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

@Injectable()
export class KafkaConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumer.name);
  private readonly consumer: Consumer;

  constructor(
    private readonly config: ConfigService,
    @Inject(forwardRef(() => CallsService))
    private readonly callsService: CallsService,
    private readonly numberProvisioning: NumberProvisioningService,
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
        topics: ["payment.completed", "subscription.cancelled"],
        fromBeginning: false,
      });
      await this.consumer.run({
        eachMessage: (payload) => this.handleMessage(payload),
      });
      this.logger.log(
        "Kafka consumer started (topics=payment.completed, subscription.cancelled)",
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
    const artistName = event.artist_name;

    if (!userId) {
      this.logger.warn("payment.completed event missing user_id");
      return;
    }

    try {
      const phoneNumber = await this.numberProvisioning.assignNumberToUser(
        userId,
        subscriptionId || "",
        artistName,
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
