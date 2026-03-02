from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.middleware.auth import get_current_user_id
from app.schemas.transaction import ApiResponse, CreateTransactionRequest, PaginatedResponse
from app.services.payment_service import PaymentService

router = APIRouter(prefix="/payments/transactions", tags=["transactions"])


@router.post("", response_model=ApiResponse, status_code=201)
async def create_transaction(
    body: CreateTransactionRequest,
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Create a new payment transaction."""
    svc = PaymentService(session)
    txn = await svc.create_transaction(
        user_id=user_id,
        amount=body.amount,
        currency=body.currency,
        txn_type=body.type,
        recipient_id=body.recipient_id,
        description=body.description,
    )
    return ApiResponse(success=True, data=txn.model_dump())


@router.get("", response_model=PaginatedResponse)
async def list_transactions(
    cursor: str | None = Query(None, description="Cursor for pagination"),
    limit: int = Query(20, ge=1, le=100, description="Page size"),
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> PaginatedResponse:
    """List the authenticated user's transactions with cursor-based pagination."""
    svc = PaymentService(session)
    items, total, next_cursor, has_more = await svc.list_transactions(
        user_id, cursor, limit
    )
    return PaginatedResponse(
        data=[t.model_dump() for t in items],
        next_cursor=next_cursor,
        has_more=has_more,
        total=total,
    )


@router.get("/{transaction_id}", response_model=ApiResponse)
async def get_transaction(
    transaction_id: str,
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Get a single transaction by ID."""
    svc = PaymentService(session)
    txn = await svc.get_transaction(transaction_id)
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")
    # Ensure the transaction belongs to the requesting user
    if txn.user_id != user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    return ApiResponse(success=True, data=txn.model_dump())
