import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource, QueryRunner } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { ProvisionedNumber } from "../entities/provisioned-number.entity";
import { PhoneNumberAssignment } from "../entities/phone-number-assignment.entity";
import { TwilioNumberService } from "./twilio-number.service";
import { KafkaProducer } from "../kafka/kafka.producer";

/**
 * Business logic for provisioning and releasing phone numbers.
 * Orchestrates TwilioNumberService (SDK) + DB + Kafka events.
 */
@Injectable()
export class NumberProvisioningService {
  private readonly logger = new Logger(NumberProvisioningService.name);

  constructor(
    @InjectRepository(ProvisionedNumber)
    private readonly numberRepo: Repository<ProvisionedNumber>,
    @InjectRepository(PhoneNumberAssignment)
    private readonly assignmentRepo: Repository<PhoneNumberAssignment>,
    private readonly twilioNumbers: TwilioNumberService,
    private readonly kafka: KafkaProducer,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Assign a unique phone number to a user after payment completes.
   *
   * Uses a database transaction with pessimistic locking to prevent
   * race conditions when multiple payments complete simultaneously.
   */
  async assignNumberToUser(
    userId: string,
    subscriptionId: string,
    artistName?: string,
  ): Promise<string> {
    // Idempotency check (outside transaction — read-only, safe)
    const existing = await this.numberRepo.findOne({
      where: { userId, status: "assigned" },
    });
    if (existing) {
      this.logger.log(
        "User %s already has number %s",
        userId,
        existing.phoneNumber,
      );
      return existing.phoneNumber;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // SELECT ... FOR UPDATE: lock an available number to prevent race conditions
      let provisioned = await queryRunner.manager.findOne(ProvisionedNumber, {
        where: { status: "available" },
        order: { createdAt: "ASC" },
        lock: { mode: "pessimistic_write" },
      });

      if (provisioned) {
        this.logger.log(
          "Reusing pooled number %s for user %s",
          provisioned.phoneNumber,
          userId,
        );
      } else {
        // No numbers in pool — purchase a new one from Twilio
        // (Twilio call is outside the lock — the new number doesn't
        // exist in DB yet so there's no contention)
        provisioned = await this.purchaseNewNumber();
      }

      // Assign to user (within transaction)
      provisioned.userId = userId;
      provisioned.subscriptionId = subscriptionId;
      provisioned.status = "assigned";
      provisioned.assignedAt = new Date();
      await queryRunner.manager.save(provisioned);

      // Create/update phone assignment for call routing (same transaction)
      await this.upsertAssignment(
        queryRunner,
        provisioned.phoneNumber,
        userId,
        subscriptionId,
        artistName,
      );

      await queryRunner.commitTransaction();

      // Publish Kafka event AFTER commit. If this fails, the DB is
      // still correct — payment service has a fallback to query
      // bridge_number directly via /payments/bridge-number.
      try {
        await this.kafka.publish(
          "number.provisioned",
          {
            userId,
            subscriptionId,
            phoneNumber: provisioned.phoneNumber,
            twilioNumberSid: provisioned.twilioNumberSid,
          },
          userId,
        );
      } catch (kafkaErr) {
        this.logger.warn(
          "Kafka publish failed after DB commit for user %s, number %s. " +
            "Payment service will fall back to direct query. Error: %s",
          userId,
          provisioned.phoneNumber,
          kafkaErr,
        );
      }

      this.logger.log(
        "Number %s assigned to user %s (sub=%s)",
        provisioned.phoneNumber,
        userId,
        subscriptionId,
      );

      return provisioned.phoneNumber;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Release a user's phone number when subscription is cancelled.
   * Marks it as available in the pool for reuse (cheaper than releasing from Twilio).
   */
  async releaseNumber(userId: string): Promise<void> {
    const provisioned = await this.numberRepo.findOne({
      where: { userId, status: "assigned" },
    });

    if (!provisioned) {
      this.logger.warn("No assigned number found for user %s", userId);
      return;
    }

    // Mark as available for reuse (keep the Twilio number active)
    provisioned.status = "available";
    provisioned.userId = null;
    provisioned.subscriptionId = null;
    provisioned.releasedAt = new Date();
    await this.numberRepo.save(provisioned);

    // Deactivate the phone assignment (stop routing calls)
    await this.assignmentRepo.update(
      { phoneNumber: provisioned.phoneNumber },
      { status: "inactive" },
    );

    try {
      await this.kafka.publish(
        "number.released",
        {
          userId,
          phoneNumber: provisioned.phoneNumber,
        },
        userId,
      );
    } catch (kafkaErr) {
      this.logger.warn(
        "Kafka publish failed for number.released (user=%s). Error: %s",
        userId,
        kafkaErr,
      );
    }

    this.logger.log(
      "Number %s released from user %s (returned to pool)",
      provisioned.phoneNumber,
      userId,
    );
  }

  /**
   * Fully delete a number from Twilio (for cleanup or cost savings).
   * Use releaseNumber() for normal subscription cancellation.
   */
  async deleteNumber(twilioNumberSid: string): Promise<void> {
    await this.twilioNumbers.release(twilioNumberSid);
    await this.numberRepo.update(
      { twilioNumberSid },
      { status: "releasing", releasedAt: new Date() },
    );
    await this.numberRepo.delete({ twilioNumberSid });
    this.logger.log("Number deleted from Twilio: sid=%s", twilioNumberSid);
  }

  /** Publish a number.provisioning.failed event so downstream services can react. */
  async publishProvisioningFailed(userId: string, reason: string): Promise<void> {
    await this.kafka.publish(
      "number.provisioning.failed",
      { userId, reason },
      userId,
    );
  }

  /** Purchase a new phone number from Twilio and save to DB. */
  private async purchaseNewNumber(): Promise<ProvisionedNumber> {
    const devMode = this.config.get<boolean>("twilio.devMode", false);

    if (devMode) {
      this.logger.log("DEV MODE: Creating fake provisioned number");
      const provisioned = this.numberRepo.create({
        twilioNumberSid: `PN_dev_${randomUUID()}`,
        phoneNumber: "+15005550006",
        status: "available",
      });
      return this.numberRepo.save(provisioned);
    }

    const webhookBaseUrl = this.config.get<string>(
      "webhookBaseUrl",
      "http://localhost:3009",
    );
    const voiceUrl = `${webhookBaseUrl}/telephony/webhooks/voice/incoming`;
    const statusUrl = `${webhookBaseUrl}/telephony/webhooks/voice/status`;

    // Search for available numbers
    const available = await this.twilioNumbers.searchAvailable("US", {
      limit: 1,
    });

    if (available.length === 0) {
      throw new Error("No phone numbers available for provisioning");
    }

    // Purchase the first available number
    const result = await this.twilioNumbers.provision(
      available[0].phoneNumber,
      voiceUrl,
      statusUrl,
    );

    // Save to DB
    const provisioned = this.numberRepo.create({
      twilioNumberSid: result.twilioNumberSid,
      phoneNumber: result.phoneNumber,
      status: "available",
    });

    return this.numberRepo.save(provisioned);
  }

  /** Create or update the phone-to-user assignment for call routing. */
  private async upsertAssignment(
    queryRunner: QueryRunner,
    phoneNumber: string,
    userId: string,
    subscriptionId: string,
    artistName?: string,
  ): Promise<void> {
    let assignment = await queryRunner.manager.findOne(PhoneNumberAssignment, {
      where: { phoneNumber },
    });

    if (assignment) {
      assignment.userId = userId;
      assignment.subscriptionId = subscriptionId;
      if (artistName) assignment.artistName = artistName;
      assignment.status = "active";
    } else {
      assignment = queryRunner.manager.create(PhoneNumberAssignment, {
        phoneNumber,
        userId,
        subscriptionId,
        artistName: artistName || null,
        status: "active",
      });
    }

    await queryRunner.manager.save(assignment);
  }
}
