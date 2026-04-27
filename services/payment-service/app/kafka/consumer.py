import asyncio
import json
import logging
from typing import Awaitable, Callable
from uuid import UUID

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import ProcessedEvent

logger = logging.getLogger(__name__)

_consumer: AIOKafkaConsumer | None = None
_dlq_producer: AIOKafkaProducer | None = None
_consumer_task: asyncio.Task | None = None

TOPIC_USER_CREATED = "user.created"
TOPIC_USER_DELETED = "user.deleted"
TOPIC_NUMBER_PROVISIONED = "number.provisioned"
TOPIC_NUMBER_PROVISIONING_FAILED = "number.provisioning.failed"

# Bounded retry policy. After all delays elapse and the handler still
# raises, the message is shipped to a DLQ topic and the original is
# acked so it doesn't block its partition. An operator should watch
# DLQ depth — a DLQ no one watches is just /dev/null.
RETRY_DELAYS_S = (1, 5, 30)


# ── Idempotency ────────────────────────────────────────────────────────


async def _try_claim_event(
    session: AsyncSession,
    event_id: str | None,
    event_type: str,
) -> bool:
    """Insert the event into processed_events.

    Returns True if this is the first time we see it (caller should process),
    False if it was already processed (caller should skip).

    Producer-side outbox writes a UUID `event_id` with each message; older
    messages without one are processed unconditionally so the migration
    is backwards-compatible.
    """
    if not event_id:
        return True

    try:
        parsed = UUID(event_id)
    except (TypeError, ValueError):
        logger.warning("Invalid event_id %r; processing without dedup", event_id)
        return True

    stmt = (
        pg_insert(ProcessedEvent)
        .values(event_id=parsed, event_type=event_type)
        .on_conflict_do_nothing(index_elements=[ProcessedEvent.event_id])
        .returning(ProcessedEvent.event_id)
    )
    result = await session.execute(stmt)
    inserted = result.scalar_one_or_none()
    return inserted is not None


# ── Handlers ──────────────────────────────────────────────────────────


async def _handle_user_created(data: dict) -> None:
    """Handle a user.created event by provisioning a free subscription."""
    user_id = data.get("user_id") or data.get("data", {}).get("id")
    if not user_id:
        logger.warning("user.created event missing user_id field: %s", data)
        return

    from app.database import async_session
    from app.services.payment_service import PaymentService

    async with async_session() as session:
        if not await _try_claim_event(session, data.get("event_id"), TOPIC_USER_CREATED):
            logger.debug("user.created event %s already processed, skipping", data.get("event_id"))
            await session.commit()
            return
        svc = PaymentService(session)
        await svc.create_free_subscription(user_id)
        await session.commit()
        logger.info("Provisioned free subscription for new user %s", user_id)


async def _handle_number_provisioning_failed(data: dict) -> None:
    """Handle a number.provisioning.failed event by storing the failure on the subscription."""
    user_id = data.get("userId") or data.get("user_id")
    reason = data.get("reason", "Unknown error")

    if not user_id:
        logger.warning("number.provisioning.failed event missing userId: %s", data)
        return

    from app.database import async_session
    from app.services.payment_service import PaymentService

    async with async_session() as session:
        if not await _try_claim_event(session, data.get("event_id"), TOPIC_NUMBER_PROVISIONING_FAILED):
            logger.debug(
                "number.provisioning.failed event %s already processed, skipping",
                data.get("event_id"),
            )
            await session.commit()
            return
        svc = PaymentService(session)
        await svc.mark_provisioning_failed(user_id, reason)
        await session.commit()
        logger.warning(
            "Marked provisioning as failed for user %s: %s", user_id, reason
        )


async def _handle_number_provisioned(data: dict) -> None:
    """Handle a number.provisioned event by updating the subscription's bridge number.

    Idempotent via processed_events: if Kafka redelivers (consumer crash,
    rebalance, producer retry), the second attempt no-ops cleanly.
    """
    user_id = data.get("userId") or data.get("user_id")
    phone_number = data.get("phoneNumber") or data.get("phone_number")

    if not user_id or not phone_number:
        logger.warning("number.provisioned event missing fields: %s", data)
        return

    from app.database import async_session
    from app.services.payment_service import PaymentService

    async with async_session() as session:
        if not await _try_claim_event(session, data.get("event_id"), TOPIC_NUMBER_PROVISIONED):
            logger.debug(
                "number.provisioned event %s already processed, skipping",
                data.get("event_id"),
            )
            await session.commit()
            return
        svc = PaymentService(session)
        await svc.update_bridge_number(user_id, phone_number)
        await session.commit()
        logger.info("Updated bridge number for user %s: %s", user_id, phone_number)


async def _handle_user_deleted(data: dict) -> None:
    """Hard-delete payment-service rows for the user, then cancel Stripe.

    Steps for each user_id:
      1. DELETE FROM subscriptions / transactions  (Postgres source of truth).
      2. Cancel any still-active Stripe Subscription objects, so Stripe
         stops billing the deleted customer.
    """
    raw = data.get("data", data)
    user_ids = raw.get("userIds", [])
    if not user_ids:
        logger.warning("user.deleted event missing userIds: %s", data)
        return

    from app.database import async_session
    from app.repositories.transaction_repo import TransactionRepository

    # 1. Purge local DB rows
    for user_id in user_ids:
        try:
            async with async_session() as session:
                repo = TransactionRepository(session)
                subs, txns = await repo.purge_user_data(str(user_id))
                logger.info(
                    "Purged payment DB for user %s: %d subscriptions, %d transactions",
                    user_id, subs, txns,
                )
        except Exception as exc:
            logger.error("Failed to purge payment DB for user %s: %s", user_id, exc)

    # 2. Cancel Stripe subscriptions (best-effort, never blocks DB cleanup)
    import stripe
    from app.config import settings as cfg

    stripe.api_key = cfg.stripe_secret_key

    for user_id in user_ids:
        try:
            subs = stripe.Subscription.list(limit=10)
            for sub in subs.auto_paging_iter():
                if sub.metadata.get("user_id") == str(user_id) and sub.status in ("active", "trialing", "past_due"):
                    stripe.Subscription.cancel(sub.id)
                    logger.info("Cancelled Stripe subscription %s for deleted user %s", sub.id, user_id)
        except Exception as exc:
            logger.error("Failed to cancel Stripe for user %s: %s", user_id, exc)

    logger.info("Payment cleanup done for users: %s", user_ids)

    # Schedule a delayed audit. If anything leaks past the consumers,
    # PostHog gets `account_delete_orphans_detected` for our dashboard.
    # Fire-and-forget so consumer offset commit isn't blocked on it.
    from app.audit.deletion_audit import audit_user_deletion

    asyncio.create_task(audit_user_deletion([str(u) for u in user_ids]))


# ── Retry + DLQ wrapper ────────────────────────────────────────────────


async def _process_with_retry(
    handler: Callable[[dict], Awaitable[None]],
    topic: str,
    data: dict,
) -> None:
    """Run a handler with bounded exponential backoff. On final failure,
    publish to ``<topic>.dlq`` so the partition isn't blocked and an
    operator can replay the message after fixing the underlying issue.
    """
    last_err: Exception | None = None
    for attempt, delay in enumerate((0,) + RETRY_DELAYS_S):
        if delay:
            await asyncio.sleep(delay)
        try:
            await handler(data)
            return
        except Exception as exc:  # noqa: BLE001 — we want the broadest catch here
            last_err = exc
            logger.warning(
                "Handler failed for topic=%s attempt=%d: %s",
                topic, attempt, exc,
            )

    # All retries exhausted — DLQ the message and ack so we move on.
    await _send_to_dlq(topic, data, last_err)


async def _send_to_dlq(topic: str, data: dict, last_err: Exception | None) -> None:
    """Publish the unprocessable message to <topic>.dlq with the last error."""
    global _dlq_producer
    if _dlq_producer is None:
        logger.error(
            "DLQ producer not initialized; dropping message from %s: %s",
            topic, last_err,
        )
        return

    dlq_topic = f"{topic}.dlq"
    payload = {
        "original_topic": topic,
        "original_payload": data,
        "error": str(last_err) if last_err else "unknown",
    }
    try:
        await _dlq_producer.send_and_wait(
            dlq_topic, value=json.dumps(payload).encode("utf-8")
        )
        logger.error(
            "Message sent to DLQ %s after exhausting retries: %s",
            dlq_topic, last_err,
        )
    except Exception as exc:
        logger.error(
            "Failed to send to DLQ %s (giving up): %s | original error: %s",
            dlq_topic, exc, last_err,
        )


# ── Consumer loop ──────────────────────────────────────────────────────


async def _consume_loop() -> None:
    """Main consumer loop that reads messages and dispatches handlers."""
    global _consumer, _dlq_producer

    sasl_kwargs: dict = {}
    if settings.kafka_use_tls:
        from aiokafka.helpers import create_ssl_context
        sasl_kwargs = {
            "security_protocol": "SASL_SSL",
            "sasl_mechanism": "SCRAM-SHA-256",
            "sasl_plain_username": settings.kafka_sasl_username,
            "sasl_plain_password": settings.kafka_sasl_password,
            "ssl_context": create_ssl_context(),
        }

    _consumer = AIOKafkaConsumer(
        TOPIC_USER_CREATED,
        TOPIC_USER_DELETED,
        TOPIC_NUMBER_PROVISIONED,
        TOPIC_NUMBER_PROVISIONING_FAILED,
        bootstrap_servers=settings.kafka_brokers,
        group_id="payment-service",
        auto_offset_reset="earliest",
        value_deserializer=lambda v: json.loads(v.decode("utf-8")),
        enable_auto_commit=True,
        **sasl_kwargs,
    )

    _dlq_producer = AIOKafkaProducer(
        bootstrap_servers=settings.kafka_brokers,
        client_id="payment-service-dlq",
        **sasl_kwargs,
    )

    await _consumer.start()
    await _dlq_producer.start()
    logger.info(
        "Kafka consumer started (brokers=%s, topics=[%s, %s, %s, %s])",
        settings.kafka_brokers,
        TOPIC_USER_CREATED,
        TOPIC_USER_DELETED,
        TOPIC_NUMBER_PROVISIONED,
        TOPIC_NUMBER_PROVISIONING_FAILED,
    )

    try:
        async for message in _consumer:
            topic = message.topic
            data = message.value

            logger.debug("Received message on %s: %s", topic, data)

            handler: Callable[[dict], Awaitable[None]] | None = None
            if topic == TOPIC_USER_CREATED:
                handler = _handle_user_created
            elif topic == TOPIC_USER_DELETED:
                handler = _handle_user_deleted
            elif topic == TOPIC_NUMBER_PROVISIONED:
                handler = _handle_number_provisioned
            elif topic == TOPIC_NUMBER_PROVISIONING_FAILED:
                handler = _handle_number_provisioning_failed
            else:
                logger.warning("Unhandled topic: %s", topic)
                continue

            await _process_with_retry(handler, topic, data)
    except asyncio.CancelledError:
        logger.info("Kafka consumer loop cancelled")
        raise
    except Exception as exc:
        logger.error("Kafka consumer error: %s", exc)
    finally:
        if _consumer is not None:
            await _consumer.stop()
            _consumer = None
        if _dlq_producer is not None:
            await _dlq_producer.stop()
            _dlq_producer = None
        logger.info("Kafka consumer stopped")


def start_consumer() -> None:
    """Start the Kafka consumer as a background asyncio task.

    Must be called from within a running event loop.
    """
    global _consumer_task
    if _consumer_task is None or _consumer_task.done():
        _consumer_task = asyncio.ensure_future(_consume_loop())
        logger.info("Kafka consumer task scheduled")


async def stop_consumer() -> None:
    """Gracefully stop the Kafka consumer background task."""
    global _consumer_task
    if _consumer_task is not None and not _consumer_task.done():
        _consumer_task.cancel()
        try:
            await _consumer_task
        except asyncio.CancelledError:
            logger.info("Kafka consumer task cancelled")
        _consumer_task = None
        logger.info("Kafka consumer task stopped")
