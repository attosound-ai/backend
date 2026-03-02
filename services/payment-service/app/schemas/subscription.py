from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CreateSubscriptionRequest(BaseModel):
    """Request body for creating or upgrading a subscription."""

    model_config = ConfigDict(populate_by_name=True)

    plan: Literal["free", "basic", "premium", "artist_pro"] = Field(
        description="Subscription plan to activate"
    )


class SubscriptionResponse(BaseModel):
    """Subscription data returned in API responses."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    plan: str
    status: str
    starts_at: str
    expires_at: str
    transaction_id: str | None = None
    created_at: str
    updated_at: str


class CancelSubscriptionResponse(BaseModel):
    """Response when cancelling a subscription."""

    id: str
    status: str
    message: str
