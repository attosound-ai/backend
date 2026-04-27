import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Transactional outbox row for reliable event publishing.
 *
 * Pattern: writes to this table happen INSIDE the same DB transaction as
 * the business state change. A separate worker polls unpublished rows and
 * publishes them to Kafka, marking `publishedAt` on success. This makes
 * event delivery at-least-once even if the broker is unreachable at the
 * moment of the business write — without distributed transactions.
 *
 * Consumers must dedupe by `id` (use the row id as the Kafka message key
 * and check it against a `processed_events` table on the consumer side).
 *
 * See:
 *   - https://learn.microsoft.com/en-us/azure/architecture/patterns/transactional-outbox
 *   - https://www.confluent.io/learn/outbox-pattern/
 */
@Entity("outbox_events")
// Partial index would be ideal (WHERE published_at IS NULL) but TypeORM
// decorators do not support partial indexes; this composite index keeps the
// poller query selective enough at our scale.
@Index("IDX_outbox_published_created", ["publishedAt", "createdAt"])
export class OutboxEvent {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Aggregate type the event belongs to (e.g. 'phone_number'). */
  @Column({ type: "varchar", length: 64 })
  aggregateType: string;

  /** Aggregate id — used as the Kafka message key for partition affinity. */
  @Column({ type: "varchar", length: 128 })
  aggregateId: string;

  /** Kafka topic to publish to (e.g. 'number.provisioned'). */
  @Column({ type: "varchar", length: 128 })
  eventType: string;

  @Column({ type: "jsonb" })
  payload: Record<string, unknown>;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  /** Set by the publisher worker after the message is successfully written
   *  to Kafka. NULL means "not yet published". */
  @Column({ type: "timestamptz", nullable: true })
  publishedAt: Date | null;

  /** Number of publish attempts. Used to drive exponential backoff and
   *  surface poison events to operators. */
  @Column({ type: "int", default: 0 })
  attempts: number;

  /** Last error message from a failed publish attempt. */
  @Column({ type: "text", nullable: true })
  lastError: string | null;
}
