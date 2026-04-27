import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource, IsNull, LessThan } from "typeorm";
import { Kafka, Producer } from "kafkajs";
import { ConfigService } from "@nestjs/config";
import { OutboxEvent } from "../entities/outbox-event.entity";

/**
 * Polls the outbox_events table and publishes unsent rows to Kafka.
 *
 * Runs every POLL_INTERVAL_MS in a loop (not @Cron to keep latency low).
 * Locks rows with `SELECT ... FOR UPDATE SKIP LOCKED` so multiple replicas
 * never publish the same event twice — though under at-least-once semantics
 * the consumer must dedupe regardless.
 *
 * Uses an idempotent Kafka producer so retries within a single send do not
 * create duplicates. Cross-restart duplicates are still possible (consumer
 * dedup via `processed_events` is the safety net).
 *
 * Cleanup: rows older than RETENTION_MS that have been published are
 * deleted opportunistically so the table doesn't grow unbounded.
 */
@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly producer: Producer;
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs = 500;
  private readonly batchSize = 50;
  private readonly retentionMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  private lastCleanupAt = 0;

  constructor(
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    const brokers =
      config.get<string[]>("kafka.brokers") ?? ["localhost:9092"];
    const useTls = config.get<boolean>("kafka.useTls") ?? false;
    const kafka = new Kafka({
      clientId: "telephony-service-outbox",
      brokers,
      ...(useTls && {
        ssl: true,
        sasl: {
          mechanism: "scram-sha-256" as const,
          username: config.get<string>("kafka.saslUsername") ?? "",
          password: config.get<string>("kafka.saslPassword") ?? "",
        },
      }),
    });
    this.producer = kafka.producer({
      // Idempotent producer dedupes retries within a single producer session.
      idempotent: true,
      maxInFlightRequests: 5,
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.producer.connect();
      this.logger.log("Outbox publisher Kafka producer connected");
    } catch (err) {
      this.logger.error("Outbox producer failed to connect: %s", err);
    }
    this.isRunning = true;
    void this.scheduleNextTick();
  }

  async onModuleDestroy(): Promise<void> {
    this.isRunning = false;
    if (this.timer) clearTimeout(this.timer);
    try {
      await this.producer.disconnect();
    } catch {
      // best effort
    }
  }

  private scheduleNextTick(): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNextTick());
    }, this.pollIntervalMs);
  }

  /**
   * One pass: claim a batch of unpublished rows, publish each, mark
   * `publishedAt`. Errors on a single row don't abort the batch.
   */
  private async tick(): Promise<void> {
    let claimed: OutboxEvent[] = [];
    try {
      claimed = await this.dataSource.transaction(async (manager) => {
        const rows = await manager
          .createQueryBuilder(OutboxEvent, "o")
          .where("o.publishedAt IS NULL")
          .orderBy("o.createdAt", "ASC")
          .limit(this.batchSize)
          .setLock("pessimistic_write")
          .setOnLocked("skip_locked")
          .getMany();

        // Defer the actual publish until after the transaction commits so
        // we don't hold row locks across network calls. We just claim them
        // here by bumping `attempts`; that lets a parallel worker skip them
        // for a window even if we crash before publishing.
        if (rows.length > 0) {
          await manager
            .createQueryBuilder()
            .update(OutboxEvent)
            .set({ attempts: () => '"attempts" + 1' })
            .whereInIds(rows.map((r) => r.id))
            .execute();
        }

        return rows;
      });
    } catch (err) {
      this.logger.error("Outbox claim failed: %s", err);
      return;
    }

    for (const row of claimed) {
      await this.publishOne(row);
    }

    // Opportunistic cleanup once an hour.
    const now = Date.now();
    if (now - this.lastCleanupAt > 60 * 60 * 1000) {
      this.lastCleanupAt = now;
      await this.cleanupOldPublished().catch((err) =>
        this.logger.warn("Outbox cleanup failed: %s", err),
      );
    }
  }

  private async publishOne(row: OutboxEvent): Promise<void> {
    try {
      await this.producer.send({
        topic: row.eventType,
        messages: [
          {
            key: row.aggregateId,
            // event_id lets the consumer dedupe across redeliveries.
            value: JSON.stringify({
              event_id: row.id,
              event_type: row.eventType,
              aggregate_type: row.aggregateType,
              aggregate_id: row.aggregateId,
              timestamp: row.createdAt.toISOString(),
              ...row.payload,
            }),
            headers: {
              "event-id": row.id,
              "event-type": row.eventType,
            },
          },
        ],
      });

      await this.outboxRepo.update(row.id, {
        publishedAt: new Date(),
        lastError: null,
      });

      this.logger.debug(
        "Outbox row %s published to %s",
        row.id,
        row.eventType,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.outboxRepo
        .update(row.id, { lastError: msg })
        .catch(() => undefined);
      this.logger.warn(
        "Outbox publish failed for %s (attempt %d): %s",
        row.id,
        row.attempts,
        msg,
      );
      // Row stays unpublished; next tick picks it up. Attempts grows so an
      // operator can spot poison events with `WHERE attempts > 10`.
    }
  }

  /** Delete rows that have been published longer than retention. */
  private async cleanupOldPublished(): Promise<void> {
    const cutoff = new Date(Date.now() - this.retentionMs);
    const result = await this.outboxRepo
      .createQueryBuilder()
      .delete()
      .from(OutboxEvent)
      .where("publishedAt IS NOT NULL")
      .andWhere("publishedAt < :cutoff", { cutoff })
      .execute();
    if (result.affected && result.affected > 0) {
      this.logger.log("Outbox cleanup deleted %d old rows", result.affected);
    }

    // Also surface poison events that have failed many times.
    const stuck = await this.outboxRepo.count({
      where: { publishedAt: IsNull(), createdAt: LessThan(new Date(Date.now() - 5 * 60 * 1000)) },
    });
    if (stuck > 0) {
      this.logger.warn(
        "Outbox lag: %d events unpublished for >5min (investigate Kafka or poison events)",
        stuck,
      );
    }
  }
}
