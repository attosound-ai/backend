import enum
from datetime import datetime, timezone
from uuid import UUID as PyUUID, uuid4

from sqlalchemy import DateTime, Enum as SAEnum, Numeric, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class TransactionType(str, enum.Enum):
    donation = "donation"
    subscription = "subscription"
    tip = "tip"


class TransactionStatus(str, enum.Enum):
    pending = "pending"
    completed = "completed"
    failed = "failed"
    refunded = "refunded"


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[PyUUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid4
    )
    user_id: Mapped[str] = mapped_column(
        String(64), nullable=False, index=True
    )
    amount: Mapped[float] = mapped_column(
        Numeric(10, 2), nullable=False
    )
    currency: Mapped[str] = mapped_column(
        String(3), default="USD", nullable=False
    )
    type: Mapped[str] = mapped_column(
        SAEnum(TransactionType, name="transaction_type", create_constraint=True),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        SAEnum(TransactionStatus, name="transaction_status", create_constraint=True),
        default=TransactionStatus.pending,
        nullable=False,
    )
    recipient_id: Mapped[PyUUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    reference_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    description: Mapped[str | None] = mapped_column(
        String(500), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
