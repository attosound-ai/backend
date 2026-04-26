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
from app.schemas.subscription import (
    ChangePlanRequest,
    CreateSubscriptionRequest,
    UpgradeSubscriptionRequest,
)
from app.schemas.transaction import ApiResponse
from app.services.payment_service import PLAN_PRICES, PaymentService
from app.services.plan_change_service import PlanChangeError, PlanChangeService
from app.services import stripe_service

router = APIRouter(prefix="/payments/subscriptions", tags=["subscriptions"])


@router.post("", response_model=ApiResponse, status_code=201)
async def create_subscription(
    body: CreateSubscriptionRequest,
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Create or upgrade a subscription. Representatives can pay for their creator."""
    target_user = body.for_user_id or user_id
    svc = PaymentService(session)
    sub = await svc.create_subscription(
        user_id=target_user,
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
    """Legacy upgrade endpoint — charges full plan price.

    Kept for first-time subscribers (free → paid). For existing paid users
    changing plans use POST /me/change-plan which prorates correctly.
    """
    target_user = body.for_user_id or user_id
    svc = PaymentService(session)
    sub = await svc.get_active_subscription(target_user)
    current_plan = sub.plan if sub else "connect_free"

    if not can_upgrade(current_plan, body.target_plan):
        raise HTTPException(status_code=400, detail="Invalid upgrade path")

    try:
        result = await stripe_service.create_checkout_session(
            user_id=target_user,
            plan_id=body.target_plan,
            email=body.email,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return ApiResponse(success=True, data=result)


@router.get("/me/change-plan/preview", response_model=ApiResponse)
async def preview_plan_change(
    target_plan: str,
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Preview a plan change without charging or persisting anything.

    Returns the direction (upgrade/downgrade/same), prorated amount in cents,
    and when the change applies. Stable enough to display in a confirmation UI.
    """
    svc = PlanChangeService(session)
    try:
        prv = await svc.preview(user_id, target_plan)
    except PlanChangeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ApiResponse(
        success=True,
        data={
            "direction": prv.direction,
            "currentPlan": prv.current_plan,
            "targetPlan": prv.target_plan,
            "amountDueCents": prv.amount_due_cents,
            "appliesAt": prv.applies_at.isoformat(),
            "daysRemaining": prv.days_remaining,
        },
    )


@router.post("/me/change-plan", response_model=ApiResponse)
async def change_plan(
    body: ChangePlanRequest,
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Apply a plan change.

    Upgrade   → returns a Stripe PaymentIntent for the prorated diff.
    Downgrade → schedules the change for the end of the current period.
    """
    svc = PlanChangeService(session)
    try:
        result = await svc.start_change(user_id, body.target_plan, body.email)
    except PlanChangeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ApiResponse(success=True, data=result)


@router.post("/me/change-plan/confirm", response_model=ApiResponse)
async def confirm_plan_change(
    body: ChangePlanRequest,
    payment_intent_id: str,
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Mobile client calls this after the Stripe PaymentSheet succeeds.

    Materializes the upgrade in our DB immediately (the webhook is the
    canonical reconciliation path; this is a UX accelerator).
    """
    svc = PlanChangeService(session)
    sub = await svc.confirm_upgrade_paid(user_id, body.target_plan, payment_intent_id)
    if not sub:
        raise HTTPException(status_code=404, detail="No active subscription")
    return ApiResponse(success=True, data={"plan": sub.plan})


@router.delete("/me/pending-change", response_model=ApiResponse)
async def cancel_pending_change(
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Cancel a previously scheduled downgrade — the user keeps their current plan."""
    svc = PlanChangeService(session)
    sub = await svc.cancel_pending_change(user_id)
    if not sub:
        raise HTTPException(status_code=404, detail="No active subscription")
    return ApiResponse(success=True, data={"plan": sub.plan, "pendingChange": None})
