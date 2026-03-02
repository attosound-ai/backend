"""Pydantic schemas for Stripe checkout, webhook, and bridge-number endpoints."""

from pydantic import BaseModel, ConfigDict, Field


class CheckoutRequest(BaseModel):
    """Request body for creating a Stripe checkout / PaymentIntent."""

    model_config = ConfigDict(populate_by_name=True)

    plan_id: str = Field(alias="planId", description="Plan identifier (e.g. 'annual', 'monthly')")
    email: str = Field(description="Customer email address")


class CheckoutResponse(BaseModel):
    """Response returned after creating a Stripe PaymentIntent."""

    model_config = ConfigDict(populate_by_name=True)

    client_secret: str = Field(alias="clientSecret", description="Stripe PaymentIntent client secret")
    payment_intent_id: str = Field(alias="paymentIntentId", description="Stripe PaymentIntent ID")


class ConfirmPaymentRequest(BaseModel):
    """Request body for confirming a completed Stripe payment."""

    model_config = ConfigDict(populate_by_name=True)

    payment_intent_id: str = Field(alias="paymentIntentId", description="Stripe PaymentIntent ID")


class BridgeNumberResponse(BaseModel):
    """Response containing the user's assigned bridge phone number."""

    model_config = ConfigDict(populate_by_name=True)

    bridge_number: str | None = Field(
        alias="bridgeNumber",
        description="Assigned bridge phone number, or null if still being provisioned",
    )
    status: str = Field(
        default="assigned",
        description="'assigned' when number is ready, 'provisioning' when pending",
    )
