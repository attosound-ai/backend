"""Router for Stripe-related payment endpoints.

- POST /checkout  -- create a PaymentIntent for mobile checkout
- POST /webhook   -- receive and validate Stripe webhook events
- GET  /bridge-number -- return the user's assigned bridge phone number
"""

import logging
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.middleware.auth import get_current_user_id
from app.schemas.payment import BridgeNumberResponse, CheckoutRequest, CheckoutResponse, ConfirmPaymentRequest
from app.schemas.transaction import ApiResponse
from app.services.payment_service import PaymentService
from app.services import stripe_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/payments", tags=["payments"])


@router.post("/checkout", response_model=ApiResponse, status_code=200)
async def checkout(
    body: CheckoutRequest,
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Create a Stripe PaymentIntent for mobile checkout.

    The caller must include an ``X-User-ID`` header.  Returns a
    ``clientSecret`` and ``paymentIntentId`` that the mobile app uses
    with the Stripe SDK.
    """
    try:
        result = await stripe_service.create_checkout_session(
            user_id=user_id,
            plan_id=body.plan_id,
            email=body.email,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Stripe checkout failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=502, detail="Payment provider error") from exc

    return ApiResponse(
        success=True,
        data=CheckoutResponse(
            client_secret=result["clientSecret"],
            payment_intent_id=result["paymentIntentId"],
        ).model_dump(by_alias=True),
    )


@router.post("/webhook", include_in_schema=False)
async def stripe_webhook(
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> JSONResponse:
    """Receive a Stripe webhook event.

    This endpoint must receive the **raw** request body (not parsed JSON)
    because Stripe's signature verification requires the original bytes.
    The route is excluded from the auth middleware (no ``X-User-ID``
    required) -- see ``AuthMiddleware`` which skips non-``/api/`` paths
    and we handle the webhook path explicitly below.
    """
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    if not sig_header:
        raise HTTPException(status_code=400, detail="Missing stripe-signature header")

    try:
        event = await stripe_service.handle_webhook_event(payload, sig_header)
    except Exception as exc:
        logger.warning("Webhook signature verification failed: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid signature") from exc

    event_type = event["type"]
    event_data = event["data"]

    # ── Process known event types ────────────────────────────────
    if event_type == "payment_intent.succeeded":
        user_id = event_data.get("metadata", {}).get("user_id")
        plan_id = event_data.get("metadata", {}).get("plan_id")
        amount_cents = event_data.get("amount", 0)

        if user_id and plan_id:
            svc = PaymentService(session)
            await svc.create_subscription_from_webhook(
                user_id=user_id,
                plan_id=plan_id,
                stripe_payment_intent_id=event_data.get("id", ""),
                amount=Decimal(amount_cents) / Decimal(100),
            )
            logger.info(
                "Processed payment_intent.succeeded for user %s, plan %s",
                user_id,
                plan_id,
            )

    elif event_type == "customer.subscription.created":
        logger.info(
            "Stripe subscription created: %s (customer=%s)",
            event_data.get("id"),
            event_data.get("customer"),
        )

    elif event_type == "customer.subscription.updated":
        logger.info(
            "Stripe subscription updated: %s (status=%s)",
            event_data.get("id"),
            event_data.get("status"),
        )

    elif event_type == "payment_intent.payment_failed":
        user_id = event_data.get("metadata", {}).get("user_id")
        logger.warning(
            "Payment failed for user %s: %s",
            user_id,
            event_data.get("last_payment_error", {}).get("message", "unknown"),
        )

    else:
        logger.info("Unhandled Stripe event type: %s", event_type)

    return JSONResponse(content={"received": True}, status_code=200)


@router.post("/confirm", response_model=ApiResponse, status_code=200)
async def confirm_payment(
    body: ConfirmPaymentRequest,
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Confirm a Stripe payment and create the subscription.

    Called by the mobile app after ``presentPaymentSheet()`` succeeds.
    Verifies the PaymentIntent status via Stripe API, then creates the
    subscription record and returns the bridge number.  This bypasses
    the webhook dependency for environments where Stripe cannot reach
    the backend (e.g. local development).
    """
    import stripe

    try:
        pi = stripe.PaymentIntent.retrieve(body.payment_intent_id)
    except Exception as exc:
        logger.error("Failed to retrieve PaymentIntent: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid payment intent") from exc

    if pi.status != "succeeded":
        raise HTTPException(
            status_code=400,
            detail=f"Payment not completed (status: {pi.status})",
        )

    plan_id = (pi.metadata or {}).get("plan_id", "record")
    amount = Decimal(pi.amount) / Decimal(100)

    svc = PaymentService(session)

    # Check if subscription already exists (idempotent — webhook may have fired too)
    existing = await svc.get_active_subscription(user_id)
    if not existing:
        await svc.create_subscription_from_webhook(
            user_id=user_id,
            plan_id=plan_id,
            stripe_payment_intent_id=body.payment_intent_id,
            amount=amount,
        )

    bridge_number, status = await svc.get_bridge_number(user_id)

    return ApiResponse(
        success=True,
        data=BridgeNumberResponse(
            bridge_number=bridge_number, status=status
        ).model_dump(by_alias=True),
    )


@router.get("/bridge-number", response_model=ApiResponse, status_code=200)
async def get_bridge_number(
    user_id: str = Depends(get_current_user_id),
    session: AsyncSession = Depends(get_session),
) -> ApiResponse:
    """Return the user's assigned bridge phone number.

    Returns status='provisioning' while pending, 'assigned' when ready,
    or 'failed' if Twilio provisioning failed.
    """
    svc = PaymentService(session)
    bridge_number, status = await svc.get_bridge_number(user_id)
    return ApiResponse(
        success=True,
        data=BridgeNumberResponse(
            bridge_number=bridge_number, status=status
        ).model_dump(by_alias=True),
    )
