import asyncio
import json
import logging

from aiokafka import AIOKafkaConsumer

from app.config import settings

logger = logging.getLogger(__name__)

_consumer: AIOKafkaConsumer | None = None
_consumer_task: asyncio.Task | None = None

TOPIC_USER_CREATED = "user.created"
TOPIC_USER_DELETED = "user.deleted"
TOPIC_NUMBER_PROVISIONED = "number.provisioned"
TOPIC_NUMBER_PROVISIONING_FAILED = "number.provisioning.failed"


async def _handle_user_created(data: dict) -> None:
    """Handle a user.created event by provisioning a free subscription."""
    # Support both flat {"user_id": "4"} and nested {"data": {"id": "4"}} formats
    user_id = data.get("user_id") or data.get("data", {}).get("id")
    if not user_id:
        logger.warning("user.created event missing user_id field: %s", data)
        return

    # Import here to avoid circular imports at module level
    from app.database import async_session
    from app.services.payment_service import PaymentService

    try:
        async with async_session() as session:
            svc = PaymentService(session)
            await svc.create_free_subscription(user_id)
            logger.info("Provisioned free subscription for new user %s", user_id)
    except Exception as exc:
        logger.error(
            "Failed to provision free subscription for user %s: %s", user_id, exc
        )


async def _handle_number_provisioning_failed(data: dict) -> None:
    """Handle a number.provisioning.failed event by storing the failure on the subscription."""
    user_id = data.get("userId") or data.get("user_id")
    reason = data.get("reason", "Unknown error")

    if not user_id:
        logger.warning("number.provisioning.failed event missing userId: %s", data)
        return

    from app.database import async_session
    from app.services.payment_service import PaymentService

    try:
        async with async_session() as session:
            svc = PaymentService(session)
            await svc.mark_provisioning_failed(user_id, reason)
            logger.warning(
                "Marked provisioning as failed for user %s: %s", user_id, reason
            )
    except Exception as exc:
        logger.error(
            "Failed to mark provisioning failure for user %s: %s", user_id, exc
        )


async def _handle_number_provisioned(data: dict) -> None:
    """Handle a number.provisioned event by updating the subscription's bridge number."""
    user_id = data.get("userId") or data.get("user_id")
    phone_number = data.get("phoneNumber") or data.get("phone_number")

    if not user_id or not phone_number:
        logger.warning("number.provisioned event missing fields: %s", data)
        return

    from app.database import async_session
    from app.services.payment_service import PaymentService

    try:
        async with async_session() as session:
            svc = PaymentService(session)
            await svc.update_bridge_number(user_id, phone_number)
            logger.info(
                "Updated bridge number for user %s: %s", user_id, phone_number
            )
    except Exception as exc:
        logger.error(
            "Failed to update bridge number for user %s: %s", user_id, exc
        )


async def _handle_user_deleted(data: dict) -> None:
    """Hard-delete payment-service rows for the user, then cancel Stripe.

    Steps for each user_id:
      1. DELETE FROM subscriptions / transactions  (Postgres source of truth).
      2. Cancel any still-active Stripe Subscription objects, so Stripe
         stops billing the deleted customer.

    Earlier versions of this handler only cancelled Stripe subscriptions
    and assumed the DB rows were purged elsewhere. They weren't — they
    were left orphaned and the deletion-residue audit found them.
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


async def _consume_loop() -> None:
    """Main consumer loop that reads messages and dispatches handlers."""
    global _consumer

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

    await _consumer.start()
    logger.info(
        "Kafka consumer started (brokers=%s, topics=[%s, %s, %s])",
        settings.kafka_brokers,
        TOPIC_USER_CREATED,
        TOPIC_NUMBER_PROVISIONED,
        TOPIC_NUMBER_PROVISIONING_FAILED,
    )

    try:
        async for message in _consumer:
            topic = message.topic
            data = message.value

            logger.debug("Received message on %s: %s", topic, data)

            if topic == TOPIC_USER_CREATED:
                await _handle_user_created(data)
            elif topic == TOPIC_USER_DELETED:
                await _handle_user_deleted(data)
            elif topic == TOPIC_NUMBER_PROVISIONED:
                await _handle_number_provisioned(data)
            elif topic == TOPIC_NUMBER_PROVISIONING_FAILED:
                await _handle_number_provisioning_failed(data)
            else:
                logger.warning("Unhandled topic: %s", topic)
    except asyncio.CancelledError:
        logger.info("Kafka consumer loop cancelled")
        raise
    except Exception as exc:
        logger.error("Kafka consumer error: %s", exc)
    finally:
        if _consumer is not None:
            await _consumer.stop()
            _consumer = None
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
