"""Runtime plan catalog backed by the plans table.

Every call site that needs plan data (prices, durations, entitlements,
Stripe price ids) goes through this module instead of hardcoded dicts.
Rows are read once and cached in process for a short TTL. Admin mutations
call invalidate() so the next read sees fresh data.

The paywall helpers at the bottom are pure functions over PlanRow lists so
they can be unit tested without a database.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.entitlements import SEED_FREE_PLAN_KEY
from app.models.plan import Plan

logger = logging.getLogger(__name__)

CACHE_TTL_SECONDS = 30.0

# Fallback Stripe price ids from the environment, used when a plan row has
# no stripe_price_id of its own.
SETTINGS_STRIPE_PRICE_IDS: dict[str, str] = {
    "record": settings.stripe_record_price_id,
    "record_pro": settings.stripe_record_pro_price_id,
    "connect_pro": settings.stripe_connect_pro_price_id,
}


@dataclass(frozen=True)
class PlanRow:
    """Immutable snapshot of a plan row, safe to cache and share."""

    key: str
    name: str
    description: str | None
    price_cents: int
    currency: str
    billing_period: str
    duration_days: int
    stripe_price_id: str | None
    popular: bool
    active: bool
    sort_order: int
    features: tuple[str, ...] = ()
    entitlements: frozenset[str] = field(default_factory=frozenset)

    @property
    def price_dollars(self) -> str:
        return f"{Decimal(self.price_cents) / 100:.2f}"


def row_from_model(plan: Plan) -> PlanRow:
    return PlanRow(
        key=plan.key,
        name=plan.name,
        description=plan.description,
        price_cents=int(plan.price_cents or 0),
        currency=plan.currency or "USD",
        billing_period=plan.billing_period,
        duration_days=int(plan.duration_days or 0),
        stripe_price_id=plan.stripe_price_id,
        popular=bool(plan.popular),
        active=bool(plan.active),
        sort_order=int(plan.sort_order or 0),
        features=tuple(plan.features or []),
        entitlements=frozenset(e.entitlement for e in plan.entitlements),
    )


# ── Cache ──────────────────────────────────────────────────────────

_cache: tuple[PlanRow, ...] | None = None
_cache_loaded_at: float = 0.0


def invalidate() -> None:
    """Drop the cached snapshot. Called after every admin mutation."""
    global _cache, _cache_loaded_at
    _cache = None
    _cache_loaded_at = 0.0


async def snapshot(session: AsyncSession) -> tuple[PlanRow, ...]:
    """All plan rows, active or not, sorted by sort_order then key."""
    global _cache, _cache_loaded_at
    now = time.monotonic()
    if _cache is not None and now - _cache_loaded_at < CACHE_TTL_SECONDS:
        return _cache
    result = await session.execute(select(Plan).order_by(Plan.sort_order, Plan.key))
    rows = tuple(row_from_model(p) for p in result.scalars().unique().all())
    _cache = rows
    _cache_loaded_at = now
    return rows


# ── Pure helpers (no database) ─────────────────────────────────────

def pick_free_plan(rows: list[PlanRow] | tuple[PlanRow, ...]) -> PlanRow | None:
    """Active plan with a zero price and the lowest sort_order."""
    free = [r for r in rows if r.active and r.price_cents == 0]
    if not free:
        return None
    return min(free, key=lambda r: (r.sort_order, r.key))


def compute_paid_features(rows: list[PlanRow] | tuple[PlanRow, ...]) -> list[str]:
    """Entitlements only paid plans grant.

    Union of entitlements across active plans with a price, minus whatever
    the free plan already includes. Inactive plans are ignored.
    """
    free = pick_free_plan(rows)
    free_entitlements = free.entitlements if free else frozenset()
    paid: set[str] = set()
    for row in rows:
        if row.active and row.price_cents > 0:
            paid |= row.entitlements
    return sorted(paid - free_entitlements)


def compute_paywall_required(rows: list[PlanRow] | tuple[PlanRow, ...]) -> bool:
    return len(compute_paid_features(rows)) > 0


# ── Async API ──────────────────────────────────────────────────────

async def list_plans(session: AsyncSession, active_only: bool = True) -> list[PlanRow]:
    rows = await snapshot(session)
    return [r for r in rows if r.active or not active_only]


async def get_plan(session: AsyncSession, key: str) -> PlanRow | None:
    for row in await snapshot(session):
        if row.key == key:
            return row
    return None


async def free_plan_key(session: AsyncSession) -> str:
    free = pick_free_plan(await snapshot(session))
    return free.key if free else SEED_FREE_PLAN_KEY


async def entitlements_for(session: AsyncSession, plan_key: str) -> frozenset[str]:
    """Entitlements of a plan. Unknown or inactive plans get the free plan's set."""
    rows = await snapshot(session)
    for row in rows:
        if row.key == plan_key and row.active:
            return row.entitlements
    free = pick_free_plan(rows)
    return free.entitlements if free else frozenset()


async def price_cents(session: AsyncSession, plan: str) -> int:
    row = await get_plan(session, plan)
    return row.price_cents if row else 0


async def price_decimal(session: AsyncSession, plan: str) -> Decimal:
    return Decimal(await price_cents(session, plan)) / 100


async def prices_usd(session: AsyncSession) -> dict[str, Decimal]:
    """Yearly price per plan key in dollars, used by the proration math."""
    return {r.key: Decimal(r.price_cents) / 100 for r in await snapshot(session)}


async def duration_days(session: AsyncSession, plan: str) -> int:
    row = await get_plan(session, plan)
    if row and row.duration_days > 0:
        return row.duration_days
    return 30


async def can_upgrade(session: AsyncSession, current: str, target: str) -> bool:
    """True when the target is an active plan priced strictly above the current one."""
    target_row = await get_plan(session, target)
    if not target_row or not target_row.active:
        return False
    return target_row.price_cents > await price_cents(session, current)


async def paid_features(session: AsyncSession) -> list[str]:
    return compute_paid_features(await snapshot(session))


async def paywall_required(session: AsyncSession) -> bool:
    return compute_paywall_required(await snapshot(session))


async def stripe_price_id(session: AsyncSession, plan: str) -> str:
    """Stripe price id for a plan, falling back to the env settings map."""
    row = await get_plan(session, plan)
    if row and row.stripe_price_id:
        return row.stripe_price_id
    return SETTINGS_STRIPE_PRICE_IDS.get(plan, "")
