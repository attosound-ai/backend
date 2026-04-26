"""Pure proration math — no DB, no Stripe, no I/O. Easy to unit test."""

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

ChangeDirection = Literal["upgrade", "downgrade", "same"]

# Source of truth for plan ranking and pricing.
# Higher rank = higher tier. connect_free = 0.
PLAN_RANK: dict[str, int] = {
    "connect_free": 0,
    "record": 1,
    "record_pro": 2,
    "connect_pro": 3,
}

PLAN_PRICE_USD: dict[str, Decimal] = {
    "connect_free": Decimal("0.00"),
    "record": Decimal("99.00"),
    "record_pro": Decimal("139.00"),
    "connect_pro": Decimal("1999.00"),
}

ANNUAL_DAYS = Decimal("365")


@dataclass(frozen=True)
class PlanChangePreview:
    """Outcome of evaluating a plan change. Returned to the API as JSON."""

    direction: ChangeDirection
    current_plan: str
    target_plan: str
    amount_due_cents: int
    applies_at: datetime
    days_remaining: int


def classify(current_plan: str, target_plan: str) -> ChangeDirection:
    """Compare plan tiers."""
    if current_plan == target_plan:
        return "same"
    cur_rank = PLAN_RANK.get(current_plan, 0)
    tgt_rank = PLAN_RANK.get(target_plan, 0)
    return "upgrade" if tgt_rank > cur_rank else "downgrade"


def days_remaining(expires_at: datetime, now: datetime | None = None) -> int:
    """Whole days until expiry. Clamped to [0, 365]."""
    now = now or datetime.now(timezone.utc)
    delta = (expires_at - now).total_seconds() / 86400
    return max(0, min(int(ANNUAL_DAYS), int(delta)))


def calculate_upgrade_charge_cents(
    current_plan: str, target_plan: str, days_left: int
) -> int:
    """Prorated diff in cents for an upgrade.

    Formula matches Stripe's proration: charge for the remaining days
    on the new plan minus credit for unused days on the old plan.
    """
    cur = PLAN_PRICE_USD.get(current_plan, Decimal("0"))
    tgt = PLAN_PRICE_USD.get(target_plan, Decimal("0"))
    diff_per_year = tgt - cur
    if diff_per_year <= 0:
        return 0
    prorated = (diff_per_year * Decimal(days_left) / ANNUAL_DAYS) * 100
    return int(prorated.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def preview(
    current_plan: str,
    target_plan: str,
    expires_at: datetime,
    now: datetime | None = None,
) -> PlanChangePreview:
    """Build a complete change preview without side effects."""
    now = now or datetime.now(timezone.utc)
    direction = classify(current_plan, target_plan)
    days_left = days_remaining(expires_at, now)

    if direction == "upgrade":
        amount = calculate_upgrade_charge_cents(current_plan, target_plan, days_left)
        applies_at = now
    elif direction == "downgrade":
        amount = 0
        applies_at = expires_at
    else:
        amount = 0
        applies_at = now

    return PlanChangePreview(
        direction=direction,
        current_plan=current_plan,
        target_plan=target_plan,
        amount_due_cents=amount,
        applies_at=applies_at,
        days_remaining=days_left,
    )
