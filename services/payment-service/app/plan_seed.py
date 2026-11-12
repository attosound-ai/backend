"""Boot time plan catalog setup: enum to string migration and first seed.

Both functions are idempotent and safe to run on every start.
"""

import logging

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from app.entitlements import (
    SEED_PLAN_BILLING,
    SEED_PLAN_DISPLAY_NAMES,
    SEED_PLAN_ENTITLEMENTS,
    SEED_PLAN_FEATURES,
    SEED_PLAN_MAX_RECORDING_SECONDS,
    SEED_PLAN_PRICES_CENTS,
)
from app.models.plan import Plan, PlanEntitlement
from app.plan_catalog import SETTINGS_STRIPE_PRICE_IDS

logger = logging.getLogger(__name__)


async def migrate_plan_column(conn: AsyncConnection) -> None:
    """Turn subscriptions.plan from the subscription_plan enum into VARCHAR(64).

    Only acts when the column is still the enum type. The enum type itself
    is left in place. A leftover check constraint named after the enum is
    dropped as well. pending_plan is widened to match the new key length.
    """
    row = await conn.execute(
        text(
            "SELECT udt_name FROM information_schema.columns "
            "WHERE table_name = 'subscriptions' AND column_name = 'plan'"
        )
    )
    udt_name = row.scalar()
    if udt_name == "subscription_plan":
        logger.info("Migrating subscriptions.plan from enum to varchar")
        await conn.execute(
            text("ALTER TABLE subscriptions ALTER COLUMN plan TYPE VARCHAR(64) USING plan::text")
        )

    constraint = await conn.execute(
        text(
            "SELECT conname FROM pg_constraint "
            "WHERE conrelid = 'subscriptions'::regclass "
            "AND contype = 'c' AND conname LIKE '%subscription_plan%'"
        )
    )
    for (name,) in constraint.all():
        logger.info("Dropping leftover plan check constraint %s", name)
        await conn.execute(text(f'ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS "{name}"'))

    await conn.execute(
        text("ALTER TABLE subscriptions ALTER COLUMN pending_plan TYPE VARCHAR(64)")
    )


async def migrate_plan_limits(conn: AsyncConnection) -> bool:
    """Add plans.max_recording_seconds when it is missing. Returns True if added.

    Additive only: the column is nullable and nothing is dropped or rewritten.
    The seed caps are written once, in the same boot that adds the column, so a
    value later edited (or cleared) from the admin dashboard is never put back.
    """
    row = await conn.execute(
        text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'plans' AND column_name = 'max_recording_seconds'"
        )
    )
    if row.scalar() is not None:
        return False
    logger.info("Adding plans.max_recording_seconds")
    await conn.execute(
        text("ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_recording_seconds INTEGER")
    )
    for key, seconds in SEED_PLAN_MAX_RECORDING_SECONDS.items():
        await conn.execute(
            text(
                "UPDATE plans SET max_recording_seconds = :seconds "
                "WHERE key = :key AND max_recording_seconds IS NULL"
            ),
            {"seconds": seconds, "key": key},
        )
    return True


def seed_rows() -> list[Plan]:
    """Plan ORM rows built from the hardcoded seed tables."""
    rows: list[Plan] = []
    for key, (billing_period, duration_days, popular, sort_order) in SEED_PLAN_BILLING.items():
        rows.append(
            Plan(
                key=key,
                name=SEED_PLAN_DISPLAY_NAMES[key],
                description=None,
                price_cents=SEED_PLAN_PRICES_CENTS[key],
                currency="USD",
                billing_period=billing_period,
                duration_days=duration_days,
                stripe_price_id=SETTINGS_STRIPE_PRICE_IDS.get(key) or None,
                popular=popular,
                active=True,
                sort_order=sort_order,
                features=list(SEED_PLAN_FEATURES[key]),
                max_recording_seconds=SEED_PLAN_MAX_RECORDING_SECONDS.get(key),
                entitlements=[
                    PlanEntitlement(entitlement=e.value)
                    for e in sorted(SEED_PLAN_ENTITLEMENTS[key], key=lambda e: e.value)
                ],
            )
        )
    return rows


async def seed_plans_if_empty(session: AsyncSession) -> bool:
    """Insert the seed plans when the plans table has no rows. Returns True if seeded."""
    count = await session.scalar(select(func.count()).select_from(Plan))
    if count:
        return False
    session.add_all(seed_rows())
    await session.commit()
    logger.info("Seeded %d plans into the catalog", len(SEED_PLAN_BILLING))
    return True
