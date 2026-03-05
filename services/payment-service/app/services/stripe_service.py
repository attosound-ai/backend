"""Stripe-specific integration layer.

This module encapsulates all direct interaction with the Stripe SDK so that
the rest of the payment service stays decoupled from the payment provider.
"""

import logging

import stripe

from app.config import settings

logger = logging.getLogger(__name__)

# ── Stripe SDK configuration ────────────────────────────────────────
stripe.api_key = settings.stripe_secret_key
logger.info(
    "Stripe configured: %s...%s (%d chars)",
    settings.stripe_secret_key[:7],
    settings.stripe_secret_key[-4:],
    len(settings.stripe_secret_key),
)

# Plan lookup: plan_id -> Stripe Price ID
PLAN_PRICE_MAP: dict[str, str] = {
    "record": settings.stripe_record_price_id,          # $99/year
    "record_pro": settings.stripe_record_pro_price_id,  # $139/year
    "connect_pro": settings.stripe_connect_pro_price_id, # $1,999/year
}

# Amount in cents used for one-time PaymentIntent when no recurring price
PLAN_AMOUNT_MAP: dict[str, int] = {
    "record": 9900,       # $99.00
    "record_pro": 13900,  # $139.00
    "connect_pro": 199900, # $1,999.00
}


async def get_or_create_customer(user_id: str, email: str) -> str:
    """Return an existing Stripe Customer for *user_id*, or create one.

    We store the internal ``user_id`` in ``metadata.user_id`` so we can
    look the customer up later without maintaining our own mapping table.
    """
    # Search for an existing customer by metadata
    existing = stripe.Customer.search(
        query=f'metadata["user_id"]:"{user_id}"',
    )
    if existing.data:
        customer = existing.data[0]
        logger.info("Found existing Stripe customer %s for user %s", customer.id, user_id)
        return customer.id

    # Create a new customer
    customer = stripe.Customer.create(
        email=email,
        metadata={"user_id": user_id},
    )
    logger.info("Created Stripe customer %s for user %s", customer.id, user_id)
    return customer.id


async def create_checkout_session(
    user_id: str,
    plan_id: str,
    email: str,
) -> dict:
    """Create a Stripe PaymentIntent suitable for mobile clients.

    Returns a dict with ``clientSecret`` and ``paymentIntentId`` that the
    mobile app uses with the Stripe SDK to complete payment on-device.
    """
    customer_id = await get_or_create_customer(user_id, email)

    amount = PLAN_AMOUNT_MAP.get(plan_id)
    if amount is None:
        raise ValueError(f"Unknown plan_id: {plan_id}")

    payment_intent = stripe.PaymentIntent.create(
        amount=amount,
        currency="usd",
        customer=customer_id,
        metadata={
            "user_id": user_id,
            "plan_id": plan_id,
        },
        automatic_payment_methods={"enabled": True},
    )

    logger.info(
        "Created PaymentIntent %s for user %s, plan %s ($%s)",
        payment_intent.id,
        user_id,
        plan_id,
        amount / 100,
    )

    return {
        "clientSecret": payment_intent.client_secret,
        "paymentIntentId": payment_intent.id,
    }


async def create_subscription(customer_id: str, price_id: str) -> dict:
    """Create a Stripe Subscription for the given customer and price.

    Returns key subscription fields as a plain dict.
    """
    subscription = stripe.Subscription.create(
        customer=customer_id,
        items=[{"price": price_id}],
        payment_behavior="default_incomplete",
        expand=["latest_invoice.payment_intent"],
    )

    logger.info(
        "Created Stripe Subscription %s for customer %s",
        subscription.id,
        customer_id,
    )

    # The latest invoice may carry a PaymentIntent when the subscription
    # requires initial payment.
    client_secret = None
    latest_invoice = subscription.get("latest_invoice")
    if latest_invoice and isinstance(latest_invoice, dict):
        pi = latest_invoice.get("payment_intent")
        if pi and isinstance(pi, dict):
            client_secret = pi.get("client_secret")

    return {
        "subscriptionId": subscription.id,
        "status": subscription.status,
        "clientSecret": client_secret,
    }


async def handle_webhook_event(payload: bytes, sig_header: str) -> dict:
    """Validate a Stripe webhook signature and return the parsed event.

    Raises ``stripe.error.SignatureVerificationError`` when the signature
    is invalid, which the caller should translate into an HTTP 400.
    """
    event = stripe.Webhook.construct_event(
        payload,
        sig_header,
        settings.stripe_webhook_secret,
    )

    event_type: str = event["type"]
    event_data: dict = event["data"]["object"]

    logger.info("Received Stripe webhook event: %s (id=%s)", event_type, event.get("id"))

    return {
        "type": event_type,
        "data": event_data,
    }
