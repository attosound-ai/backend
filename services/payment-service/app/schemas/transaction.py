from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class CreateTransactionRequest(BaseModel):
    """Request body for creating a new transaction."""

    model_config = ConfigDict(populate_by_name=True)

    amount: Decimal = Field(gt=0, description="Transaction amount (must be positive)")
    currency: str = Field(default="USD", max_length=3)
    type: Literal["donation", "subscription", "tip"] = Field(
        description="Transaction type"
    )
    recipient_id: str | None = Field(
        default=None, alias="recipientId", description="Recipient user ID"
    )
    description: str | None = Field(
        default=None, max_length=500, description="Transaction description"
    )


class TransactionResponse(BaseModel):
    """Transaction data returned in API responses."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    amount: str
    currency: str
    type: str
    status: str
    recipient_id: str | None = None
    reference_id: str | None = None
    description: str | None = None
    created_at: str
    updated_at: str


class PaginatedResponse(BaseModel):
    """Paginated list response wrapper."""

    model_config = ConfigDict(populate_by_name=True)

    data: list[Any]
    next_cursor: str | None = Field(default=None, alias="nextCursor")
    has_more: bool = Field(default=False, alias="hasMore")
    total: int = 0


class ApiResponse(BaseModel):
    """Standard API response wrapper."""

    success: bool = True
    data: Any | None = None
    error: str | None = None
