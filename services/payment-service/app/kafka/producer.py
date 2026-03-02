import json
import logging

from aiokafka import AIOKafkaProducer
from aiokafka.helpers import create_ssl_context

from app.config import settings

logger = logging.getLogger(__name__)

_producer: AIOKafkaProducer | None = None


def _sasl_kwargs() -> dict:
    """Return SASL/SSL kwargs when KAFKA_USE_TLS is enabled (e.g. Upstash)."""
    if not settings.kafka_use_tls:
        return {}
    return {
        "security_protocol": "SASL_SSL",
        "sasl_mechanism": "SCRAM-SHA-256",
        "sasl_plain_username": settings.kafka_sasl_username,
        "sasl_plain_password": settings.kafka_sasl_password,
        "ssl_context": create_ssl_context(),
    }


async def get_kafka_producer() -> AIOKafkaProducer:
    """Return the singleton Kafka producer, creating it on first call."""
    global _producer
    if _producer is None:
        _producer = AIOKafkaProducer(
            bootstrap_servers=settings.kafka_brokers,
            value_serializer=lambda v: json.dumps(v).encode("utf-8"),
            key_serializer=lambda k: k.encode("utf-8") if k else None,
            **_sasl_kwargs(),
        )
        await _producer.start()
        logger.info("Kafka producer started (brokers=%s)", settings.kafka_brokers)
    return _producer


async def publish_event(topic: str, payload: dict, key: str | None = None) -> None:
    """Publish a JSON event to a Kafka topic.

    Failures are logged but do not raise, so that Kafka outages
    do not block HTTP request processing.
    """
    try:
        producer = await get_kafka_producer()
        await producer.send_and_wait(topic, value=payload, key=key)
        logger.info(
            "Published event to %s: %s",
            topic,
            payload.get("event_type", "unknown"),
        )
    except Exception as exc:
        logger.error("Failed to publish event to %s: %s", topic, str(exc))


async def stop_producer() -> None:
    """Gracefully shut down the Kafka producer."""
    global _producer
    if _producer is not None:
        await _producer.stop()
        _producer = None
        logger.info("Kafka producer stopped")
