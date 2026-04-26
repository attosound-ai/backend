from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CreateSubscriptionRequest(BaseModel):
    """Request body for creating or upgrading a subscription."""

    model_config = ConfigDict(populate_by_name=True)

    plan: Literal["connect_free", "record", "record_pro", "connect_pro"] = Field(
        description="Subscription plan to activate"
    )
    for_user_id: str | None = Field(
        default=None,
        alias="forUserId",
        description="Optional: create subscription for this user (representative paying for creator)",
    )


class UpgradeSubscriptionRequest(BaseModel):
    """Request body for upgrading to a higher plan."""

    model_config = ConfigDict(populate_by_name=True)

    target_plan: Literal["record", "record_pro", "connect_pro"] = Field(
        alias="targetPlan", description="Target plan to upgrade to"
    )
    email: str = Field(description="Customer email address")
    for_user_id: str | None = Field(
        default=None,
        alias="forUserId",
        description="Optional: upgrade subscription for this user (representative paying for creator)",
    )


class PendingPlanChange(BaseModel):
    """Scheduled plan change that has not yet been applied."""

    target_plan: str = Field(alias="targetPlan")
    applies_at: str = Field(alias="appliesAt")

    model_config = ConfigDict(populate_by_name=True, by_alias=True)


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
    pending_change: PendingPlanChange | None = None
    created_at: str
    updated_at: str


class ChangePlanRequest(BaseModel):
    """Request body for upgrading or downgrading."""

    model_config = ConfigDict(populate_by_name=True)

    target_plan: Literal["connect_free", "record", "record_pro", "connect_pro"] = Field(
        alias="targetPlan"
    )
    email: str = Field(description="Customer email address")


class CancelSubscriptionResponse(BaseModel):
    """Response when cancelling a subscription."""

    id: str
    status: str
    message: str
