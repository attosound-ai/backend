from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.entitlements import (
    PLAN_DISPLAY_NAMES,
    PLAN_FEATURES,
    can_upgrade,
    get_entitlements,
)
from app.middleware.auth import get_current_user_id
from app.schemas.subscription import CreateSubscriptionRequest, UpgradeSubscriptionRequest
from app.schemas.transaction import ApiResponse
from app.services.payment_service import PLAN_PRICES, PaymentService
from app.services import stripe_service

router = APIRouter(prefix="/payments/subscriptions", tags=["subscriptions"])


@router.post("", response_model=ApiResponse, status_code=201)
async def create_subscription(
    body: CreateSubscriptionRequest,
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Create or upgrade the authenticated user's subscription."""
    svc = PaymentService(session)
    sub = await svc.create_subscription(
        user_id=user_id,
        plan=body.plan,
    )
    return ApiResponse(success=True, data=sub.model_dump())


@router.get("/me", response_model=ApiResponse)
async def get_my_subscription(
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Get the authenticated user's current active subscription."""
    svc = PaymentService(session)
    sub = await svc.get_active_subscription(user_id)
    if not sub:
        raise HTTPException(status_code=404, detail="No active subscription found")
    return ApiResponse(success=True, data=sub.model_dump())


@router.delete("/me", response_model=ApiResponse)
async def cancel_my_subscription(
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Cancel the authenticated user's active subscription."""
    svc = PaymentService(session)
    result = await svc.cancel_subscription(user_id)
    if not result:
        raise HTTPException(status_code=404, detail="No active subscription to cancel")
    return ApiResponse(success=True, data=result.model_dump())


@router.get("/plans", response_model=ApiResponse)
async def list_plans() -> ApiResponse:
    """Return all available subscription plans with pricing and entitlements."""
    plan_ids = ["connect_free", "record", "record_pro", "connect_pro"]
    plans = [
        {
            "id": pid,
            "name": PLAN_DISPLAY_NAMES.get(pid, pid),
            "price": str(PLAN_PRICES.get(pid, Decimal("0.00"))),
            "billingPeriod": "year" if pid != "connect_free" else "forever",
            "features": PLAN_FEATURES.get(pid, []),
            "entitlements": sorted(e.value for e in get_entitlements(pid)),
            "popular": pid == "record_pro",
        }
        for pid in plan_ids
    ]
    return ApiResponse(success=True, data=plans)


@router.get("/me/entitlements", response_model=ApiResponse)
async def get_my_entitlements(
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Return the authenticated user's plan and entitlements."""
    svc = PaymentService(session)
    sub = await svc.get_active_subscription(user_id)
    plan = sub.plan if sub else "connect_free"
    entitlements = sorted(e.value for e in get_entitlements(plan))
    return ApiResponse(success=True, data={"plan": plan, "entitlements": entitlements})


@router.post("/me/upgrade", response_model=ApiResponse)
async def upgrade_subscription(
    body: UpgradeSubscriptionRequest,
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Upgrade to a higher subscription plan via Stripe checkout."""
    svc = PaymentService(session)
    sub = await svc.get_active_subscription(user_id)
    current_plan = sub.plan if sub else "connect_free"

    if not can_upgrade(current_plan, body.target_plan):
        raise HTTPException(status_code=400, detail="Invalid upgrade path")

    try:
        result = await stripe_service.create_checkout_session(
            user_id=user_id,
            plan_id=body.target_plan,
            email=body.email,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return ApiResponse(success=True, data=result)
