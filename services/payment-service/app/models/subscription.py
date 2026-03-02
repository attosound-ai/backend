import enum
from datetime import datetime, timezone
from uuid import UUID as PyUUID, uuid4

from sqlalchemy import DateTime, Enum as SAEnum, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class SubscriptionPlan(str, enum.Enum):
    free = "free"
    basic = "basic"
    premium = "premium"
    artist_pro = "artist_pro"
    annual = "annual"
    monthly = "monthly"


class SubscriptionStatus(str, enum.Enum):
    active = "active"
    cancelled = "cancelled"
    expired = "expired"
    past_due = "past_due"


class Subscription(Base):
    __tablename__ = "subscriptions"

    id: Mapped[PyUUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid4
    )
    user_id: Mapped[str] = mapped_column(
        String(64), nullable=False, index=True
    )
    plan: Mapped[str] = mapped_column(
        SAEnum(SubscriptionPlan, name="subscription_plan", create_constraint=True),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        SAEnum(SubscriptionStatus, name="subscription_status", create_constraint=True),
        default=SubscriptionStatus.active,
        nullable=False,
    )
    starts_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    transaction_id: Mapped[PyUUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("transactions.id"), nullable=True
    )
    bridge_number: Mapped[str | None] = mapped_column(
        String(255), nullable=True, default=None
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
