"""Idempotency table for Kafka consumer dedup.

Inserted inside the same DB transaction as the business write. If the
INSERT conflicts on `event_id`, the consumer skips processing — the event
has already been handled. This is the safety net that makes at-least-once
delivery semantics safe to act on.

See: https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-receiver
"""
from datetime import datetime, timezone
from uuid import UUID as PyUUID

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ProcessedEvent(Base):
    __tablename__ = "processed_events"

    # The producer's outbox row id, propagated through the Kafka message
    # body as `event_id`. Globally unique per published event.
    event_id: Mapped[PyUUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True
    )

    # Source topic — useful for debugging and partial-replay scenarios.
    event_type: Mapped[str] = mapped_column(String(128), nullable=False)

    processed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
