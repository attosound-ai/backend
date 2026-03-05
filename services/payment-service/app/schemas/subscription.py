from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CreateSubscriptionRequest(BaseModel):
    """Request body for creating or upgrading a subscription."""

    model_config = ConfigDict(populate_by_name=True)

    plan: Literal["connect_free", "record", "record_pro", "connect_pro"] = Field(
        description="Subscription plan to activate"
    )


class UpgradeSubscriptionRequest(BaseModel):
    """Request body for upgrading to a higher plan."""

    model_config = ConfigDict(populate_by_name=True)

    target_plan: Literal["record", "record_pro", "connect_pro"] = Field(
        alias="targetPlan", description="Target plan to upgrade to"
    )
    email: str = Field(description="Customer email address")


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
    entitlements: list[str] = []
    created_at: str
    updated_at: str


class CancelSubscriptionResponse(BaseModel):
    """Response when cancelling a subscription."""

    id: str
    status: str
    message: str
