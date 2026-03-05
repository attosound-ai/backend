import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.kafka.producer import publish_event
from app.models.subscription import Subscription
from app.models.transaction import Transaction
from app.repositories.transaction_repo import TransactionRepository
from app.entitlements import get_entitlements
from app.schemas.subscription import CancelSubscriptionResponse, SubscriptionResponse
from app.schemas.transaction import TransactionResponse

logger = logging.getLogger(__name__)

# Kafka topic constants
TOPIC_PAYMENT_COMPLETED = "payment.completed"
TOPIC_PAYMENT_FAILED = "payment.failed"
TOPIC_SUBSCRIPTION_CANCELLED = "subscription.cancelled"

# Plan configuration
PLAN_DURATIONS_DAYS: dict[str, int] = {
    "connect_free": 36500,  # ~100 years (effectively unlimited)
    "record": 365,
    "record_pro": 365,
    "connect_pro": 365,
    # Legacy mappings (for in-flight subscriptions)
    "free": 36500,
    "annual": 365,
}

PLAN_PRICES: dict[str, Decimal] = {
    "connect_free": Decimal("0.00"),
    "record": Decimal("99.00"),
    "record_pro": Decimal("139.00"),
    "connect_pro": Decimal("1999.00"),
    # Legacy
    "free": Decimal("0.00"),
    "annual": Decimal("99.00"),
}


def _txn_to_response(txn: Transaction) -> TransactionResponse:
    """Convert a Transaction ORM model to an API response schema."""
    return TransactionResponse(
        id=str(txn.id),
        user_id=str(txn.user_id),
        amount=str(txn.amount),
        currency=txn.currency,
        type=txn.type if isinstance(txn.type, str) else txn.type.value,
        status=txn.status if isinstance(txn.status, str) else txn.status.value,
        recipient_id=str(txn.recipient_id) if txn.recipient_id else None,
        reference_id=txn.reference_id,
        description=txn.description,
        created_at=txn.created_at.isoformat() if txn.created_at else "",
        updated_at=txn.updated_at.isoformat() if txn.updated_at else "",
    )


def _sub_to_response(sub: Subscription) -> SubscriptionResponse:
    """Convert a Subscription ORM model to an API response schema."""
    plan_str = sub.plan if isinstance(sub.plan, str) else sub.plan.value
    return SubscriptionResponse(
        id=str(sub.id),
        user_id=str(sub.user_id),
        plan=plan_str,
        status=sub.status if isinstance(sub.status, str) else sub.status.value,
        starts_at=sub.starts_at.isoformat() if sub.starts_at else "",
        expires_at=sub.expires_at.isoformat() if sub.expires_at else "",
        transaction_id=str(sub.transaction_id) if sub.transaction_id else None,
        entitlements=sorted(e.value for e in get_entitlements(plan_str)),
        created_at=sub.created_at.isoformat() if sub.created_at else "",
        updated_at=sub.updated_at.isoformat() if sub.updated_at else "",
    )


class PaymentService:
    """Business logic for payments and subscriptions."""

    def __init__(self, session: AsyncSession) -> None:
        self.repo = TransactionRepository(session)
        self.session = session

    # ── Transactions ──────────────────────────────────────────────

    async def create_transaction(
        self,
        user_id: str,
        amount: Decimal,
        currency: str,
        txn_type: str,
        recipient_id: str | None = None,
        description: str | None = None,
    ) -> TransactionResponse:
        """Create a transaction, simulate processing, and publish a Kafka event."""
        txn = Transaction(
            id=uuid4(),
            user_id=user_id,
            amount=amount,
            currency=currency,
            type=txn_type,
            status="pending",
            recipient_id=UUID(recipient_id) if recipient_id else None,
            description=description,
        )
        txn = await self.repo.create_transaction(txn)

        # Simulate payment processing -- mark as completed
        txn = await self.repo.update_transaction_status(txn.id, "completed")
        logger.info("Transaction %s completed for user %s", txn.id, user_id)

        # Publish Kafka event
        await publish_event(
            TOPIC_PAYMENT_COMPLETED,
            {
                "event_type": TOPIC_PAYMENT_COMPLETED,
                "transaction_id": str(txn.id),
                "user_id": user_id,
                "amount": str(txn.amount),
                "currency": txn.currency,
                "type": txn.type if isinstance(txn.type, str) else txn.type.value,
            },
        )

        return _txn_to_response(txn)

    async def get_transaction(self, transaction_id: str) -> TransactionResponse | None:
        """Fetch a single transaction by ID."""
        txn = await self.repo.get_transaction_by_id(UUID(transaction_id))
        if not txn:
            return None
        return _txn_to_response(txn)

    async def list_transactions(
        self,
        user_id: str,
        cursor: str | None = None,
        limit: int = 20,
    ) -> tuple[list[TransactionResponse], int, str | None, bool]:
        """Return paginated transactions for a user."""
        transactions, total = await self.repo.list_transactions(
            user_id, cursor, limit
        )
        items = [_txn_to_response(t) for t in transactions]
        next_cursor = str(transactions[-1].id) if len(transactions) == limit else None
        has_more = len(transactions) == limit
        return items, total, next_cursor, has_more

    # ── Subscriptions ─────────────────────────────────────────────

    async def create_subscription(
        self,
        user_id: str,
        plan: str,
    ) -> SubscriptionResponse:
        """Create or upgrade a user's subscription.

        Steps:
        1. Cancel any active subscriptions for this user.
        2. If the plan has a cost, create a payment transaction.
        3. Create the new subscription record.
        """
        price = PLAN_PRICES.get(plan, Decimal("9.99"))
        duration_days = PLAN_DURATIONS_DAYS.get(plan, 30)
        now = datetime.now(timezone.utc)

        # Cancel existing active subscriptions
        await self.repo.deactivate_user_subscriptions(user_id)

        transaction_id = None
        if price > 0:
            # Create a payment transaction for paid plans
            txn = Transaction(
                id=uuid4(),
                user_id=user_id,
                amount=price,
                currency="USD",
                type="subscription",
                status="completed",
                description=f"Subscription: {plan} plan",
            )
            txn = await self.repo.create_transaction(txn)
            transaction_id = txn.id

            await publish_event(
                TOPIC_PAYMENT_COMPLETED,
                {
                    "event_type": TOPIC_PAYMENT_COMPLETED,
                    "transaction_id": str(txn.id),
                    "user_id": user_id,
                    "amount": str(price),
                    "currency": "USD",
                    "type": "subscription",
                },
            )

        sub = Subscription(
            id=uuid4(),
            user_id=user_id,
            plan=plan,
            starts_at=now,
            expires_at=now + timedelta(days=duration_days),
            status="active",
            transaction_id=transaction_id,
            bridge_number=None,  # Assigned async via Kafka number.provisioned
        )
        sub = await self.repo.create_subscription(sub)
        logger.info(
            "Subscription %s created for user %s, plan=%s", sub.id, user_id, plan
        )
        return _sub_to_response(sub)

    async def get_active_subscription(
        self, user_id: str
    ) -> SubscriptionResponse | None:
        """Return the current active subscription for a user."""
        sub = await self.repo.get_active_subscription(user_id)
        if not sub:
            return None
        return _sub_to_response(sub)

    async def cancel_subscription(
        self, user_id: str
    ) -> CancelSubscriptionResponse | None:
        """Cancel the user's active subscription."""
        sub = await self.repo.get_active_subscription(user_id)
        if not sub:
            return None

        cancelled = await self.repo.cancel_subscription(sub.id)
        if not cancelled:
            return None

        logger.info("Subscription %s cancelled for user %s", sub.id, user_id)

        # Notify telephony service to release the provisioned number
        await publish_event(
            TOPIC_SUBSCRIPTION_CANCELLED,
            {
                "event_type": TOPIC_SUBSCRIPTION_CANCELLED,
                "user_id": user_id,
                "subscription_id": str(cancelled.id),
            },
        )

        return CancelSubscriptionResponse(
            id=str(cancelled.id),
            status="cancelled",
            message="Subscription cancelled successfully",
        )

    async def create_free_subscription(self, user_id: str) -> SubscriptionResponse:
        """Create a default free-tier subscription for a new user.

        Skips creation if the user already has an active subscription
        (e.g. they paid during registration before the Kafka event arrived).
        """
        existing = await self.repo.get_active_subscription(user_id)
        if existing:
            logger.info(
                "User %s already has active subscription %s (plan=%s), skipping free tier",
                user_id, existing.id, existing.plan,
            )
            return _sub_to_response(existing)

        now = datetime.now(timezone.utc)
        sub = Subscription(
            id=uuid4(),
            user_id=user_id,
            plan="connect_free",
            starts_at=now,
            expires_at=now + timedelta(days=PLAN_DURATIONS_DAYS["connect_free"]),
            status="active",
            transaction_id=None,
        )
        sub = await self.repo.create_subscription(sub)
        logger.info("Free subscription created for new user %s", user_id)
        return _sub_to_response(sub)

    # ── Stripe webhook helpers ────────────────────────────────────

    async def create_subscription_from_webhook(
        self,
        user_id: str,
        plan_id: str,
        stripe_payment_intent_id: str,
        amount: Decimal,
    ) -> SubscriptionResponse:
        """Create a subscription record after Stripe confirms payment.

        Called by the webhook handler when a ``payment_intent.succeeded``
        event is received.  This records the transaction and activates the
        corresponding subscription.
        """
        duration_days = PLAN_DURATIONS_DAYS.get(plan_id, 30)
        now = datetime.now(timezone.utc)

        # Cancel existing active subscriptions
        await self.repo.deactivate_user_subscriptions(user_id)

        # Record the payment transaction
        txn = Transaction(
            id=uuid4(),
            user_id=user_id,
            amount=amount,
            currency="USD",
            type="subscription",
            status="completed",
            reference_id=stripe_payment_intent_id,
            description=f"Stripe payment for {plan_id} plan",
        )
        txn = await self.repo.create_transaction(txn)

        await publish_event(
            TOPIC_PAYMENT_COMPLETED,
            {
                "event_type": TOPIC_PAYMENT_COMPLETED,
                "transaction_id": str(txn.id),
                "user_id": user_id,
                "amount": str(amount),
                "currency": "USD",
                "type": "subscription",
                "stripe_payment_intent_id": stripe_payment_intent_id,
            },
        )

        # Create the subscription
        sub = Subscription(
            id=uuid4(),
            user_id=user_id,
            plan=plan_id if plan_id in ("connect_free", "record", "record_pro", "connect_pro") else "record",
            starts_at=now,
            expires_at=now + timedelta(days=duration_days),
            status="active",
            transaction_id=txn.id,
            bridge_number=None,  # Assigned async via Kafka number.provisioned
        )
        sub = await self.repo.create_subscription(sub)
        logger.info(
            "Subscription %s created from Stripe webhook for user %s, plan=%s",
            sub.id,
            user_id,
            plan_id,
        )
        return _sub_to_response(sub)

    # ── Bridge number ─────────────────────────────────────────────

    async def get_bridge_number(self, user_id: str) -> tuple[str | None, str]:
        """Return the bridge phone number and provisioning status for the user.

        Returns ``(phone_number, 'assigned')``, ``(None, 'provisioning')``,
        or ``(None, 'failed')`` when Twilio provisioning failed.
        """
        sub = await self.repo.get_active_subscription(user_id)
        if sub and sub.bridge_number:
            if sub.bridge_number.startswith("FAILED:"):
                return None, "failed"
            return sub.bridge_number, "assigned"
        return None, "provisioning"

    async def update_bridge_number(self, user_id: str, phone_number: str) -> None:
        """Set the bridge number on the user's active subscription.

        Called by the Kafka consumer when a ``number.provisioned`` event
        arrives from the telephony service.
        """
        await self.repo.update_subscription_bridge_number(user_id, phone_number)
        logger.info(
            "Bridge number updated to %s for user %s", phone_number, user_id
        )

    async def mark_provisioning_failed(self, user_id: str, reason: str) -> None:
        """Store a provisioning failure sentinel on the subscription.

        Uses the bridge_number column with a "FAILED:" prefix so the
        endpoint can return status='failed' without a DB migration.
        Called by the Kafka consumer on ``number.provisioning.failed`` events.
        """
        sentinel = f"FAILED:{reason[:200]}"
        await self.repo.update_subscription_bridge_number(user_id, sentinel)
        logger.warning(
            "Provisioning failed for user %s: %s", user_id, reason
        )
