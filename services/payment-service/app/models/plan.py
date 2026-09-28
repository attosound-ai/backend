"""Plan catalog tables: plans and their entitlements.

Plans used to be hardcoded in app/entitlements.py. They now live in the
database so an admin can edit pricing, features and entitlements without
a deploy. app/entitlements.py keeps the seed used on first boot.
"""

from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

BILLING_PERIODS = ("year", "month", "forever")


class Plan(Base):
    __tablename__ = "plans"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    billing_period: Mapped[str] = mapped_column(String(16), nullable=False, default="year")
    duration_days: Mapped[int] = mapped_column(Integer, nullable=False, default=365)
    stripe_price_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    popular: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Marketing bullet points shown on the paywall, a JSON list of strings.
    features: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=lambda: datetime.now(UTC),
        nullable=False,
    )

    # selectin loading keeps the rows usable from async code without an
    # explicit joinedload on every query.
    entitlements: Mapped[list["PlanEntitlement"]] = relationship(
        back_populates="plan",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="PlanEntitlement.entitlement",
    )

    @property
    def entitlement_keys(self) -> list[str]:
        return sorted(e.entitlement for e in self.entitlements)


class PlanEntitlement(Base):
    __tablename__ = "plan_entitlements"

    plan_key: Mapped[str] = mapped_column(
        String(64), ForeignKey("plans.key", ondelete="CASCADE"), primary_key=True
    )
    entitlement: Mapped[str] = mapped_column(String(64), primary_key=True)

    plan: Mapped[Plan] = relationship(back_populates="entitlements")
