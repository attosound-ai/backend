import { Injectable } from "@nestjs/common";
import { OutboxEvent } from "../entities/outbox-event.entity";
import { EntityManager } from "typeorm";

/**
 * Domain-facing helper for the transactional outbox.
 *
 * Call `enqueue(manager, ...)` inside a TypeORM transaction (using the
 * transaction's `EntityManager`) to atomically persist a domain event
 * alongside the business state change. The Kafka publish itself is
 * handled asynchronously by `OutboxPublisherService`.
 *
 * Do NOT inject this service to publish events outside a transaction —
 * for those, call `KafkaProducer.publish` directly.
 */
@Injectable()
export class OutboxService {
  /**
   * Persist an outbox row in the caller's transaction.
   *
   * @param manager   the QueryRunner's manager (NOT the global DataSource)
   * @param eventType Kafka topic the publisher will send to
   * @param aggregateType domain aggregate type (e.g. 'phone_number')
   * @param aggregateId   used as Kafka message key for partition affinity
   * @param payload   serialized as the message value alongside event_id + timestamp
   */
  async enqueue(
    manager: EntityManager,
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<OutboxEvent> {
    const row = manager.create(OutboxEvent, {
      aggregateType,
      aggregateId,
      eventType,
      payload,
    });
    return manager.save(row);
  }
}
