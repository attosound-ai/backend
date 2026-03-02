from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.middleware.auth import get_current_user_id
from app.schemas.subscription import CreateSubscriptionRequest
from app.schemas.transaction import ApiResponse
from app.services.payment_service import PaymentService

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
