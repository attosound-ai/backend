"""Admin API: plan catalog management and business metrics.

Mounted at /api/v1/admin because Kong forwards the full path. Every
request must carry ``X-Admin-Token`` matching ADMIN_API_SECRET, the same
shared secret the content service uses. The Next.js admin app keeps the
secret server side and forwards it; browsers never see it.
"""

from __future__ import annotations

import hmac
import logging
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app import plan_catalog
from app.config import settings
from app.database import get_session
from app.entitlements import ENTITLEMENT_CATALOG, ENTITLEMENT_KEYS
from app.models.plan import Plan, PlanEntitlement
from app.models.subscription import Subscription
from app.schemas.transaction import ApiResponse

logger = logging.getLogger(__name__)

PLAN_KEY_PATTERN = r"^[a-z][a-z0-9_]{1,63}$"
PLACEHOLDER_NUMBER_PREFIX = "+1500555"
REAL_NUMBER_MONTHLY_COST_CENTS = 115
DEFAULT_DURATION_DAYS = {"year": 365, "month": 30, "forever": 36500}


# ── Auth dependency ────────────────────────────────────────────────

async def require_admin(request: Request) -> None:
    """Reject the request unless X-Admin-Token matches the configured secret.

    With no secret configured the endpoint is unavailable (503) rather than
    open: the gate fails closed.
    """
    expected = settings.admin_api_secret
    if not expected:
        logger.warning("ADMIN_API_SECRET is not set; rejecting admin request to %s", request.url.path)
        raise HTTPException(status_code=503, detail="Admin API is not configured")
    provided = request.headers.get("X-Admin-Token", "")
    if not provided or not hmac.compare_digest(provided.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Invalid admin token")


router = APIRouter(
    prefix="/api/v1/admin",
    tags=["admin"],
    dependencies=[Depends(require_admin)],
)


# ── Request schemas ────────────────────────────────────────────────

BillingPeriod = Literal["year", "month", "forever"]


def _validate_entitlements(values: list[str]) -> list[str]:
    unknown = sorted(set(values) - ENTITLEMENT_KEYS)
    if unknown:
        raise ValueError(f"Unknown entitlements: {', '.join(unknown)}")
    return sorted(set(values))


class PlanCreate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    key: str = Field(pattern=PLAN_KEY_PATTERN, min_length=2, max_length=64)
    name: str = Field(min_length=1, max_length=100)
    description: str | None = None
    price_cents: int = Field(ge=0)
    currency: str = Field(default="USD", pattern=r"^[A-Za-z]{3}$")
    billing_period: BillingPeriod
    duration_days: int | None = Field(default=None, ge=1)
    stripe_price_id: str | None = Field(default=None, max_length=128)
    popular: bool = False
    active: bool = True
    sort_order: int = 0
    features: list[str] = Field(default_factory=list)
    entitlements: list[str] = Field(default_factory=list)

    @field_validator("entitlements")
    @classmethod
    def _check_entitlements(cls, value: list[str]) -> list[str]:
        return _validate_entitlements(value)

    @field_validator("currency")
    @classmethod
    def _upper_currency(cls, value: str) -> str:
        return value.upper()

    @field_validator("features")
    @classmethod
    def _clean_features(cls, value: list[str]) -> list[str]:
        return [f.strip() for f in value if f and f.strip()]


class PlanUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
    price_cents: int | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, pattern=r"^[A-Za-z]{3}$")
    billing_period: BillingPeriod | None = None
    duration_days: int | None = Field(default=None, ge=1)
    stripe_price_id: str | None = Field(default=None, max_length=128)
    popular: bool | None = None
    active: bool | None = None
    sort_order: int | None = None
    features: list[str] | None = None
    entitlements: list[str] | None = None

    @field_validator("entitlements")
    @classmethod
    def _check_entitlements(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else _validate_entitlements(value)

    @field_validator("currency")
    @classmethod
    def _upper_currency(cls, value: str | None) -> str | None:
        return None if value is None else value.upper()

    @field_validator("features")
    @classmethod
    def _clean_features(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return [f.strip() for f in value if f and f.strip()]


class EntitlementsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entitlements: list[str]

    @field_validator("entitlements")
    @classmethod
    def _check_entitlements(cls, value: list[str]) -> list[str]:
        return _validate_entitlements(value)


# ── Helpers ────────────────────────────────────────────────────────

def _iso(value: datetime | None) -> str:
    return value.isoformat() if value else ""


def plan_admin(plan: Plan, subscribers: int) -> dict[str, Any]:
    return {
        "key": plan.key,
        "name": plan.name,
        "description": plan.description,
        "priceCents": int(plan.price_cents or 0),
        "currency": plan.currency,
        "billingPeriod": plan.billing_period,
        "durationDays": int(plan.duration_days or 0),
        "stripePriceId": plan.stripe_price_id,
        "popular": bool(plan.popular),
        "active": bool(plan.active),
        "sortOrder": int(plan.sort_order or 0),
        "features": list(plan.features or []),
        "entitlements": plan.entitlement_keys,
        "subscribers": subscribers,
        "createdAt": _iso(plan.created_at),
        "updatedAt": _iso(plan.updated_at),
    }


async def _active_subscribers_by_plan(session: AsyncSession) -> dict[str, int]:
    result = await session.execute(
        select(Subscription.plan, func.count())
        .where(Subscription.status == "active")
        .group_by(Subscription.plan)
    )
    return {str(plan): int(count) for plan, count in result.all()}


async def _active_subscribers(session: AsyncSession, plan_key: str) -> int:
    result = await session.execute(
        select(func.count())
        .select_from(Subscription)
        .where(Subscription.status == "active", Subscription.plan == plan_key)
    )
    return int(result.scalar() or 0)


async def _get_plan_or_404(session: AsyncSession, key: str) -> Plan:
    plan = await session.get(Plan, key)
    if plan is None:
        raise HTTPException(status_code=404, detail=f"Plan not found: {key}")
    return plan


async def _paywall_block(session: AsyncSession) -> dict[str, Any]:
    paid = await plan_catalog.paid_features(session)
    return {
        "required": len(paid) > 0,
        "paidFeatures": paid,
        "freePlan": await plan_catalog.free_plan_key(session),
    }


# ── Plan endpoints ─────────────────────────────────────────────────

@router.get("/plans", response_model=ApiResponse)
async def admin_list_plans(session: AsyncSession = Depends(get_session)) -> ApiResponse:
    """Every plan, active or not, with subscriber counts and the entitlement catalog."""
    result = await session.execute(select(Plan).order_by(Plan.sort_order, Plan.key))
    plans = result.scalars().unique().all()
    counts = await _active_subscribers_by_plan(session)
    return ApiResponse(
        success=True,
        data={
            "plans": [plan_admin(p, counts.get(p.key, 0)) for p in plans],
            "entitlements": ENTITLEMENT_CATALOG,
            "paywall": await _paywall_block(session),
        },
    )


@router.post("/plans", response_model=ApiResponse, status_code=201)
async def admin_create_plan(
    body: PlanCreate,
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    if await session.get(Plan, body.key) is not None:
        raise HTTPException(status_code=409, detail=f"Plan already exists: {body.key}")

    plan = Plan(
        key=body.key,
        name=body.name,
        description=body.description,
        price_cents=body.price_cents,
        currency=body.currency,
        billing_period=body.billing_period,
        duration_days=body.duration_days or DEFAULT_DURATION_DAYS[body.billing_period],
        stripe_price_id=body.stripe_price_id or None,
        popular=body.popular,
        active=body.active,
        sort_order=body.sort_order,
        features=body.features,
        entitlements=[PlanEntitlement(entitlement=e) for e in body.entitlements],
    )
    session.add(plan)
    await session.commit()
    await session.refresh(plan)
    plan_catalog.invalidate()
    logger.info("Admin created plan %s", plan.key)
    return ApiResponse(success=True, data=plan_admin(plan, 0))


@router.put("/plans/{key}", response_model=ApiResponse)
async def admin_update_plan(
    key: str,
    body: PlanUpdate,
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    plan = await _get_plan_or_404(session, key)
    changes = body.model_dump(exclude_unset=True)
    entitlements = changes.pop("entitlements", None)

    for field_name, value in changes.items():
        if field_name == "stripe_price_id":
            value = value or None
        setattr(plan, field_name, value)
    if entitlements is not None:
        plan.entitlements = [PlanEntitlement(entitlement=e) for e in entitlements]
    plan.updated_at = datetime.now(UTC)

    await session.commit()
    await session.refresh(plan)
    plan_catalog.invalidate()
    logger.info("Admin updated plan %s (%s)", key, ", ".join(sorted(changes)) or "entitlements")
    return ApiResponse(success=True, data=plan_admin(plan, await _active_subscribers(session, key)))


@router.put("/plans/{key}/entitlements", response_model=ApiResponse)
async def admin_replace_entitlements(
    key: str,
    body: EntitlementsBody,
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    plan = await _get_plan_or_404(session, key)
    plan.entitlements = [PlanEntitlement(entitlement=e) for e in body.entitlements]
    plan.updated_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(plan)
    plan_catalog.invalidate()
    logger.info("Admin replaced entitlements of plan %s", key)
    return ApiResponse(success=True, data=plan_admin(plan, await _active_subscribers(session, key)))


@router.delete("/plans/{key}")
async def admin_delete_plan(
    key: str,
    session: AsyncSession = Depends(get_session),
) -> Any:
    plan = await _get_plan_or_404(session, key)

    subscribers = await _active_subscribers(session, key)
    if subscribers > 0:
        return JSONResponse(
            status_code=409,
            content={"success": False, "error": "plan has active subscribers", "subscribers": subscribers},
        )

    if plan.price_cents == 0 and plan.active:
        others = await session.execute(
            select(func.count())
            .select_from(Plan)
            .where(Plan.price_cents == 0, Plan.active.is_(True), Plan.key != key)
        )
        if int(others.scalar() or 0) == 0:
            return JSONResponse(
                status_code=409,
                content={"success": False, "error": "plan is the only free plan", "subscribers": 0},
            )

    await session.delete(plan)
    await session.commit()
    plan_catalog.invalidate()
    logger.info("Admin deleted plan %s", key)
    return ApiResponse(success=True, data={"deleted": key})


# ── Metrics ────────────────────────────────────────────────────────

async def _rows(session: AsyncSession, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    """Run one raw query. A failure (for example a table another service
    has not created yet) is logged and yields no rows instead of failing
    the whole metrics response."""
    try:
        result = await session.execute(text(sql), params)
        return [dict(row) for row in result.mappings().all()]
    except Exception as exc:
        await session.rollback()
        logger.warning("Metrics query failed: %s", exc)
        return []


def _day_series(start: date, days: int) -> list[str]:
    return [(start + timedelta(days=i)).isoformat() for i in range(days)]


def _by_day(rows: list[dict[str, Any]], start: date, days: int, key: str, value_key: str, as_cents: bool) -> list[dict[str, Any]]:
    found: dict[str, Any] = {}
    for row in rows:
        day = row.get("day")
        if day is None:
            continue
        found[str(day)] = row.get(value_key) or 0
    out = []
    for day in _day_series(start, days):
        raw = found.get(day, 0)
        value = int((Decimal(str(raw)) * 100).quantize(Decimal("1"))) if as_cents else int(raw)
        out.append({"date": day, key: value})
    return out


@router.get("/metrics", response_model=ApiResponse)
async def admin_metrics(session: AsyncSession = Depends(get_session)) -> ApiResponse:
    """Business numbers computed with raw SQL over the shared database.

    Day buckets are UTC dates regardless of the database session time zone.
    """
    now = datetime.now(UTC)
    d7 = now - timedelta(days=7)
    d30 = now - timedelta(days=30)
    start_day = (now - timedelta(days=29)).date()
    # asyncpg needs real datetimes for the timestamptz casts below.
    params = {"d7": d7, "d30": d30}

    # Users
    user_rows = await _rows(
        session,
        """
        SELECT count(*) AS total,
               count(*) FILTER (WHERE role::text = 'creator') AS creators,
               count(*) FILTER (WHERE role::text = 'representative') AS representatives,
               count(*) FILTER (WHERE role::text = 'listener') AS listeners,
               count(*) FILTER (WHERE created_at >= CAST(:d7 AS timestamptz)) AS new7,
               count(*) FILTER (WHERE created_at >= CAST(:d30 AS timestamptz)) AS new30
        FROM users
        WHERE deleted_at IS NULL
        """,
        params,
    )
    u = user_rows[0] if user_rows else {}
    signup_rows = await _rows(
        session,
        """
        SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS count
        FROM users
        WHERE deleted_at IS NULL AND created_at >= CAST(:d30 AS timestamptz)
        GROUP BY day
        """,
        params,
    )

    # Subscriptions and recurring revenue
    catalog = {row.key: row for row in await plan_catalog.snapshot(session)}
    sub_rows = await _rows(
        session,
        "SELECT plan::text AS plan, count(*) AS count FROM subscriptions WHERE status::text = 'active' GROUP BY plan",
        {},
    )
    active_by_plan = []
    yearly_cents = 0
    monthly_cents = 0
    def _plan_order(row: dict[str, Any]) -> tuple[int, str]:
        plan = catalog.get(row["plan"])
        return (plan.sort_order if plan else 999, row["plan"])

    for row in sorted(sub_rows, key=_plan_order):
        plan_key = row["plan"]
        count = int(row["count"])
        plan = catalog.get(plan_key)
        active_by_plan.append({"plan": plan_key, "name": plan.name if plan else plan_key, "count": count})
        if plan and plan.billing_period == "year":
            yearly_cents += plan.price_cents * count
        elif plan and plan.billing_period == "month":
            monthly_cents += plan.price_cents * count
    mrr_cents = int(round(yearly_cents / 12)) + monthly_cents
    arr_cents = yearly_cents + monthly_cents * 12

    # Revenue
    revenue_rows = await _rows(
        session,
        """
        SELECT (created_at AT TIME ZONE 'UTC')::date AS day, coalesce(sum(amount), 0) AS total
        FROM transactions
        WHERE status::text = 'completed' AND created_at >= CAST(:d30 AS timestamptz)
        GROUP BY day
        """,
        params,
    )
    revenue_by_day = _by_day(revenue_rows, start_day, 30, "cents", "total", as_cents=True)

    # Calls
    call_rows = await _rows(
        session,
        """
        SELECT count(*) FILTER (WHERE "startedAt" >= CAST(:d7 AS timestamptz)) AS last7,
               count(*) AS last30,
               avg("durationSeconds") FILTER (WHERE "durationSeconds" > 0) AS avg_duration
        FROM calls
        WHERE "startedAt" >= CAST(:d30 AS timestamptz)
        """,
        params,
    )
    c = call_rows[0] if call_rows else {}
    call_day_rows = await _rows(
        session,
        """
        SELECT ("startedAt" AT TIME ZONE 'UTC')::date AS day, count(*) AS count
        FROM calls
        WHERE "startedAt" >= CAST(:d30 AS timestamptz)
        GROUP BY day
        """,
        params,
    )

    # Numbers
    number_rows = await _rows(
        session,
        """
        SELECT count(*) FILTER (WHERE "phoneNumber" LIKE :placeholder) AS placeholder_count,
               count(*) FILTER (WHERE "phoneNumber" NOT LIKE :placeholder) AS real_count
        FROM provisioned_numbers
        WHERE status::text <> 'released'
        """,
        {"placeholder": f"{PLACEHOLDER_NUMBER_PREFIX}%"},
    )
    n = number_rows[0] if number_rows else {}
    real_numbers = int(n.get("real_count") or 0)

    return ApiResponse(
        success=True,
        data={
            "users": {
                "total": int(u.get("total") or 0),
                "creators": int(u.get("creators") or 0),
                "representatives": int(u.get("representatives") or 0),
                "listeners": int(u.get("listeners") or 0),
                "newLast7d": int(u.get("new7") or 0),
                "newLast30d": int(u.get("new30") or 0),
            },
            "signupsByDay": _by_day(signup_rows, start_day, 30, "count", "count", as_cents=False),
            "subscriptions": {
                "activeByPlan": active_by_plan,
                "mrrCents": mrr_cents,
                "arrCents": arr_cents,
            },
            "revenue": {
                "last30dCents": sum(r["cents"] for r in revenue_by_day),
                "byDay": revenue_by_day,
            },
            "calls": {
                "last7d": int(c.get("last7") or 0),
                "last30d": int(c.get("last30") or 0),
                "byDay": _by_day(call_day_rows, start_day, 30, "count", "count", as_cents=False),
                "avgDurationSec": round(float(c.get("avg_duration") or 0), 1),
            },
            "numbers": {
                "real": real_numbers,
                "placeholder": int(n.get("placeholder_count") or 0),
                "estMonthlyCostCents": real_numbers * REAL_NUMBER_MONTHLY_COST_CENTS,
            },
            "paywall": {
                "required": await plan_catalog.paywall_required(session),
                "paidFeatures": await plan_catalog.paid_features(session),
            },
            "generatedAt": now.isoformat(),
        },
    )

