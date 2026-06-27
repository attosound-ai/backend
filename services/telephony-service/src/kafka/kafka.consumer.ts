import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  forwardRef,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
import { Kafka, Consumer, EachMessagePayload } from "kafkajs";
import { CallsService } from "../calls/calls.service";
import { NumberProvisioningService } from "../numbers/number-provisioning.service";
import { AudioStorageService } from "../media/audio-storage.service";
import { Call } from "../entities/call.entity";
import { PhoneNumberAssignment } from "../entities/phone-number-assignment.entity";
import { Project } from "../entities/project.entity";
import { TimelineClip } from "../entities/timeline-clip.entity";
import { AudioSegment } from "../entities/audio-segment.entity";
import { AnalyticsService } from "../analytics/analytics.service";

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
    @InjectRepository(Call)
    private readonly callRepo: Repository<Call>,
    @InjectRepository(PhoneNumberAssignment)
    private readonly assignmentRepo: Repository<PhoneNumberAssignment>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(TimelineClip)
    private readonly timelineClipRepo: Repository<TimelineClip>,
    @InjectRepository(AudioSegment)
    private readonly audioSegmentRepo: Repository<AudioSegment>,
    private readonly analytics: AnalyticsService,
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
      this.analytics.capture(userId, "backend_number_provisioned", {
        phone_number: phoneNumber,
        subscription_id: subscriptionId || null,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(
        "Failed to provision number for user %s: %s",
        userId,
        reason,
      );
      this.analytics.capture(userId, "backend_number_provision_failed", {
        reason,
        subscription_id: subscriptionId || null,
      });
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
   * On user.deleted: purge ALL telephony rows for the user from this
   * service's Postgres, release Twilio numbers, and delete S3 audio.
   *
   * Earlier versions of this handler relied on user-service to delete
   * the DB rows in a cross-database transaction — that path was broken
   * (different Postgres instance per service) and orphaned rows like
   * phone_number_assignments survived account deletions.
   */
  private async handleUserDeleted(
    event: Record<string, unknown>,
  ): Promise<void> {
    const data = (event.data as Record<string, unknown>) ?? event;
    const userIds = (data.userIds as string[]) ?? [];
    if (userIds.length === 0) return;

    for (const userId of userIds) {
      // 1. Release Twilio number (in-memory lookup, doesn't depend on DB).
      try {
        await this.numberProvisioning.releaseNumber(userId);
        this.logger.log(`Released Twilio number for deleted user ${userId}`);
      } catch (err) {
        this.logger.warn(`No Twilio number to release for user ${userId}: ${err}`);
      }

      // 2. Delete S3/MinIO audio files for this user.
      try {
        await this.audioStorage.deleteUserFiles(userId);
        this.logger.log(`Deleted S3 audio files for user ${userId}`);
      } catch (err) {
        this.logger.warn(`S3 cleanup failed for user ${userId}: ${err}`);
      }

      // 3. Purge Postgres rows owned by telephony-service.
      // Order matters because of foreign keys:
      //   timeline_clips → projects + audio_segments
      //   audio_segments → projects + calls
      // So we delete child rows first, then parents.
      try {
        const projects = await this.projectRepo.find({
          where: { userId },
          select: ["id"],
        });
        const projectIds = projects.map((p) => p.id);

        if (projectIds.length > 0) {
          await this.timelineClipRepo.delete({ projectId: In(projectIds) });
          await this.audioSegmentRepo.delete({ projectId: In(projectIds) });
        }

        // audio_segments may also reference calls owned by this user
        const userCalls = await this.callRepo.find({
          where: { userId },
          select: ["id"],
        });
        if (userCalls.length > 0) {
          await this.audioSegmentRepo.delete({
            callId: In(userCalls.map((c) => c.id)),
          });
        }

        const callsResult = await this.callRepo.delete({ userId });
        const projectsResult =
          projectIds.length > 0
            ? await this.projectRepo.delete({ userId })
            : { affected: 0 };
        const assignmentsResult = await this.assignmentRepo.delete({ userId });

        this.logger.log(
          `Purged telephony DB for user ${userId}: ` +
            `${callsResult.affected ?? 0} calls, ` +
            `${projectsResult.affected ?? 0} projects, ` +
            `${assignmentsResult.affected ?? 0} phone_number_assignments`,
        );
        this.analytics.capture(userId, "backend_user_deleted_cleanup", {
          calls_purged: callsResult.affected ?? 0,
          projects_purged: projectsResult.affected ?? 0,
          assignments_purged: assignmentsResult.affected ?? 0,
        });
      } catch (err) {
        this.logger.error(
          `Failed to purge telephony DB for user ${userId}: ${(err as Error).message}`,
        );
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
      this.analytics.capture(userId, "backend_number_released", {
        reason: "subscription_cancelled",
      });
    } catch (err) {
      this.logger.error(
        "Failed to release number for user %s: %s",
        userId,
        err,
      );
    }
  }
}
