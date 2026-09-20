from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app import plan_catalog
from app.config import settings
from app.database import get_session
from app.middleware.auth import get_current_user_id, get_current_user_role, require_creator
from app.plan_catalog import PlanRow
from app.schemas.subscription import (
    ChangePlanRequest,
    CreateSubscriptionRequest,
    SelectPlanRequest,
    SubscriptionResponse,
    UpgradeSubscriptionRequest,
)
from app.schemas.transaction import ApiResponse
from app.services import stripe_service
from app.services.payment_service import PaymentService
from app.services.plan_change_service import PlanChangeError, PlanChangeService

router = APIRouter(prefix="/payments/subscriptions", tags=["subscriptions"])


def plan_to_public(row: PlanRow) -> dict:
    """Shape a catalog row the way the mobile app reads it."""
    return {
        "id": row.key,
        "key": row.key,
        "name": row.name,
        "description": row.description,
        "price": row.price_dollars,
        "priceCents": row.price_cents,
        "currency": row.currency,
        "billingPeriod": row.billing_period,
        "durationDays": row.duration_days,
        "features": list(row.features),
        "entitlements": sorted(row.entitlements),
        "popular": row.popular,
    }


async def _require_active_plan(session: AsyncSession, key: str) -> PlanRow:
    row = await plan_catalog.get_plan(session, key)
    if row is None or not row.active:
        raise HTTPException(status_code=400, detail=f"Unknown plan: {key}")
    return row


@router.post("", response_model=ApiResponse, status_code=201)
async def create_subscription(
    body: CreateSubscriptionRequest,
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Create or upgrade a subscription. Representatives can pay for their creator."""
    target_user = body.for_user_id or user_id
    await _require_active_plan(session, body.plan)
    svc = PaymentService(session)
    sub = await svc.create_subscription(
        user_id=target_user,
        plan=body.plan,
    )
    return ApiResponse(success=True, data=sub.model_dump(by_alias=True))


@router.get("/me", response_model=ApiResponse)
async def get_my_subscription(
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Get the authenticated user's current active subscription.

    Users without a subscription row get a synthesized free subscription so
    the app never has to guess entitlements locally.
    """
    svc = PaymentService(session)
    sub = await svc.get_active_subscription(user_id)
    if not sub:
        free_key = await plan_catalog.free_plan_key(session)
        sub = SubscriptionResponse(
            id="",
            user_id=user_id,
            plan=free_key,
            status="active",
            starts_at="",
            expires_at="",
            entitlements=sorted(await plan_catalog.entitlements_for(session, free_key)),
            created_at="",
            updated_at="",
        )
    return ApiResponse(success=True, data=sub.model_dump(by_alias=True))


@router.delete("/me", response_model=ApiResponse)
async def cancel_my_subscription(
    user_id: str = Depends(require_creator),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Cancel the authenticated user's active subscription."""
    svc = PaymentService(session)
    result = await svc.cancel_subscription(user_id)
    if not result:
        raise HTTPException(status_code=404, detail="No active subscription to cancel")
    return ApiResponse(success=True, data=result.model_dump(by_alias=True))


@router.get("/plans", response_model=ApiResponse)
async def list_plans(session: AsyncSession = Depends(get_session)) -> ApiResponse:
    """Return the active subscription plans with pricing and entitlements."""
    rows = await plan_catalog.list_plans(session, active_only=True)
    return ApiResponse(success=True, data=[plan_to_public(r) for r in rows])


@router.get("/paywall", response_model=ApiResponse)
async def get_paywall(session: AsyncSession = Depends(get_session)) -> ApiResponse:
    """Whether any feature is behind a paid plan, and which ones."""
    paid = await plan_catalog.paid_features(session)
    return ApiResponse(
        success=True,
        data={
            # The app shows its plan picker when this is on (testing period).
            "freeSwitching": settings.free_plan_switching,
            "required": len(paid) > 0,
            "freePlan": await plan_catalog.free_plan_key(session),
            "paidFeatures": paid,
        },
    )


@router.get("/me/entitlements", response_model=ApiResponse)
async def get_my_entitlements(
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Return the authenticated user's plan and entitlements."""
    svc = PaymentService(session)
    sub = await svc.get_active_subscription(user_id)
    plan = sub.plan if sub else await plan_catalog.free_plan_key(session)
    entitlements = sorted(await plan_catalog.entitlements_for(session, plan))
    return ApiResponse(success=True, data={"plan": plan, "entitlements": entitlements})


@router.post("/me/select-plan", response_model=ApiResponse)
async def select_plan(
    body: SelectPlanRequest,
    user_id: str = Depends(get_current_user_id),
    role: str = Depends(get_current_user_role),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Pick any active plan with no payment, while the testing switch is on.

    Any account may switch its own plan. A representative may switch the plan
    of the creator it manages through `forUserId`.
    """
    if not settings.free_plan_switching:
        raise HTTPException(status_code=403, detail="Plan selection without payment is turned off")
    if body.for_user_id and body.for_user_id != user_id and role != "representative":
        raise HTTPException(status_code=403, detail="Only a representative can switch a linked creator")

    target_user = body.for_user_id or user_id
    await _require_active_plan(session, body.plan)
    svc = PaymentService(session)
    sub = await svc.select_plan_without_payment(target_user, body.plan)
    # The new plan may grant a bridge number the old one did not. Numbers are
    # for creators only: a creator's own switch, or a representative acting
    # for the creator it manages. A listener never gets one provisioned.
    if role == "creator" or (role == "representative" and target_user != user_id):
        await svc.claim_bridge_number(target_user)
    sub_now = await svc.get_active_subscription(target_user)
    return ApiResponse(success=True, data=(sub_now or sub).model_dump(by_alias=True, mode="json"))


@router.post("/me/upgrade", response_model=ApiResponse)
async def upgrade_subscription(
    body: UpgradeSubscriptionRequest,
    user_id: str = Depends(require_creator),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Legacy upgrade endpoint — charges full plan price.

    Kept for first-time subscribers (free → paid). For existing paid users
    changing plans use POST /me/change-plan which prorates correctly.
    """
    target_user = body.for_user_id or user_id
    await _require_active_plan(session, body.target_plan)
    svc = PaymentService(session)
    sub = await svc.get_active_subscription(target_user)
    current_plan = sub.plan if sub else await plan_catalog.free_plan_key(session)

    if not await plan_catalog.can_upgrade(session, current_plan, body.target_plan):
        raise HTTPException(status_code=400, detail="Invalid upgrade path")

    try:
        result = await stripe_service.create_checkout_session(
            session,
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
    user_id: str = Depends(require_creator),
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
    user_id: str = Depends(require_creator),
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
    user_id: str = Depends(require_creator),
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
    user_id: str = Depends(require_creator),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Cancel a previously scheduled downgrade — the user keeps their current plan."""
    svc = PlanChangeService(session)
    sub = await svc.cancel_pending_change(user_id)
    if not sub:
        raise HTTPException(status_code=404, detail="No active subscription")
    return ApiResponse(success=True, data={"plan": sub.plan, "pendingChange": None})
