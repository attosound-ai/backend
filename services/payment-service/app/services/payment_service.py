import logging
import random
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app import plan_catalog
from app.config import settings
from app.kafka.producer import publish_event
from app.models.subscription import Subscription
from app.models.transaction import Transaction
from app.repositories.transaction_repo import TransactionRepository
from app.schemas.subscription import (
    CancelSubscriptionResponse,
    PendingPlanChange,
    SubscriptionResponse,
)
from app.schemas.transaction import TransactionResponse

logger = logging.getLogger(__name__)

# Kafka topic constants
TOPIC_PAYMENT_COMPLETED = "payment.completed"
TOPIC_PAYMENT_FAILED = "payment.failed"
TOPIC_SUBSCRIPTION_CANCELLED = "subscription.cancelled"

# Plan prices, durations and entitlements come from app.plan_catalog
# (database backed). Nothing about plans is hardcoded here anymore.


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


def _sub_to_response(sub: Subscription, entitlements: frozenset[str] | set[str]) -> SubscriptionResponse:
    """Convert a Subscription ORM model to an API response schema."""
    plan_str = sub.plan if isinstance(sub.plan, str) else sub.plan.value
    pending = None
    if sub.pending_plan and sub.pending_plan_applies_at:
        pending = PendingPlanChange(
            target_plan=sub.pending_plan,
            applies_at=sub.pending_plan_applies_at.isoformat(),
        )
    return SubscriptionResponse(
        id=str(sub.id),
        user_id=str(sub.user_id),
        plan=plan_str,
        status=sub.status if isinstance(sub.status, str) else sub.status.value,
        starts_at=sub.starts_at.isoformat() if sub.starts_at else "",
        expires_at=sub.expires_at.isoformat() if sub.expires_at else "",
        transaction_id=str(sub.transaction_id) if sub.transaction_id else None,
        entitlements=sorted(entitlements),
        pending_change=pending,
        created_at=sub.created_at.isoformat() if sub.created_at else "",
        updated_at=sub.updated_at.isoformat() if sub.updated_at else "",
    )


class PaymentService:
    """Business logic for payments and subscriptions."""

    def __init__(self, session: AsyncSession) -> None:
        self.repo = TransactionRepository(session)
        self.session = session

    async def _to_response(self, sub: Subscription) -> SubscriptionResponse:
        plan_str = sub.plan if isinstance(sub.plan, str) else sub.plan.value
        entitlements = await plan_catalog.entitlements_for(self.session, plan_str)
        return _sub_to_response(sub, entitlements)

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
        price = await plan_catalog.price_decimal(self.session, plan)
        duration_days = await plan_catalog.duration_days(self.session, plan)
        now = datetime.now(UTC)

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
            bridge_number=f"+1555{random.randint(1000000, 9999999)}" if settings.app_env == "development" else None,
        )
        sub = await self.repo.create_subscription(sub)
        logger.info(
            "Subscription %s created for user %s, plan=%s", sub.id, user_id, plan
        )
        return await self._to_response(sub)

    async def get_active_subscription(
        self, user_id: str
    ) -> SubscriptionResponse | None:
        """Return the current active subscription for a user.

        If a scheduled plan change has reached its applies_at date, materialize
        it inline before returning — no cron required.
        """
        from app.services.plan_change_service import materialize_pending_if_due

        sub = await self.repo.get_active_subscription(user_id)
        if not sub:
            return None
        sub = await materialize_pending_if_due(self.repo, sub)
        return await self._to_response(sub)

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
            return await self._to_response(existing)

        free_plan = await plan_catalog.free_plan_key(self.session)
        duration = await plan_catalog.duration_days(self.session, free_plan)
        now = datetime.now(UTC)
        sub = Subscription(
            id=uuid4(),
            user_id=user_id,
            plan=free_plan,
            starts_at=now,
            expires_at=now + timedelta(days=duration),
            status="active",
            transaction_id=None,
        )
        sub = await self.repo.create_subscription(sub)
        logger.info("Free subscription created for new user %s", user_id)
        return await self._to_response(sub)

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
        # Unknown plan ids from Stripe metadata fall back to the seed paid plan.
        if not await plan_catalog.get_plan(self.session, plan_id):
            logger.warning("Webhook carried unknown plan %s, storing record instead", plan_id)
            plan_id = "record"
        duration_days = await plan_catalog.duration_days(self.session, plan_id)
        now = datetime.now(UTC)

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
            plan=plan_id,
            starts_at=now,
            expires_at=now + timedelta(days=duration_days),
            status="active",
            transaction_id=txn.id,
            bridge_number=f"+1555{random.randint(1000000, 9999999)}" if settings.app_env == "development" else None,
        )
        sub = await self.repo.create_subscription(sub)
        logger.info(
            "Subscription %s created from Stripe webhook for user %s, plan=%s",
            sub.id,
            user_id,
            plan_id,
        )
        return await self._to_response(sub)

    async def select_plan_without_payment(self, user_id: str, plan_key: str) -> SubscriptionResponse:
        """Switch the user to ``plan_key`` with no charge (testing period).

        The caller has already checked the feature switch and that the plan is
        active. The bridge number travels with the user: losing it on every
        switch would strand a creator mid test, and telephony keys the number
        by user, not by subscription. A zero amount transaction records the
        switch so the ledger shows why a paid plan has no payment behind it.
        """
        current = await self.repo.get_active_subscription(user_id)
        if current and current.plan == plan_key:
            return await self._to_response(current)

        carried_number = None
        if current and current.bridge_number and not current.bridge_number.startswith("FAILED:"):
            carried_number = current.bridge_number

        duration_days = await plan_catalog.duration_days(self.session, plan_key)
        now = datetime.now(UTC)
        await self.repo.deactivate_user_subscriptions(user_id)

        txn = Transaction(
            id=uuid4(),
            user_id=user_id,
            amount=Decimal("0.00"),
            currency="USD",
            type="subscription",
            status="completed",
            reference_id=None,
            description=f"Plan selected without payment (testing period): {plan_key}",
        )
        txn = await self.repo.create_transaction(txn)

        sub = Subscription(
            id=uuid4(),
            user_id=user_id,
            plan=plan_key,
            starts_at=now,
            expires_at=now + timedelta(days=duration_days),
            status="active",
            transaction_id=txn.id,
            bridge_number=carried_number,
        )
        sub = await self.repo.create_subscription(sub)
        logger.info(
            "Plan selected without payment user=%s plan=%s previous=%s",
            user_id,
            plan_key,
            current.plan if current else None,
        )
        return await self._to_response(sub)

    # ── Bridge number ─────────────────────────────────────────────

    async def get_bridge_number(self, user_id: str) -> tuple[str | None, str]:
        """Return the bridge phone number and provisioning status for the user.

        Returns ``(phone_number, 'assigned')``, ``(None, 'provisioning')``,
        or ``(None, 'failed')`` when Twilio provisioning failed.
        """
        sub = await self.repo.get_active_subscription(user_id)
        logger.info(
            "get_bridge_number user=%s sub=%s plan=%s bridge=%s",
            user_id,
            sub.id if sub else None,
            sub.plan if sub else None,
            sub.bridge_number if sub else None,
        )
        if sub and sub.bridge_number:
            if sub.bridge_number.startswith("FAILED:"):
                return None, "provisioning"  # Treat as retryable — telephony may retry
            return sub.bridge_number, "assigned"
        return None, "provisioning"

    async def claim_bridge_number(self, user_id: str) -> tuple[str | None, str]:
        """Ask for the bridge number a plan grants without a payment.

        Provisioning used to hang off ``payment.completed`` alone, so when the
        admin gives the free plan the bridge number nobody ever asked the
        telephony service for one. This is the payment free trigger: it checks
        the entitlement, publishes the same event, and reports the status.
        Safe to repeat: telephony hands back the number a user already holds.

        Returns ``(None, 'not_entitled')`` when the plan has no bridge number.
        """
        sub = await self.repo.get_active_subscription(user_id)
        if not sub:
            await self.create_free_subscription(user_id)
            sub = await self.repo.get_active_subscription(user_id)
        plan = sub.plan if sub else await plan_catalog.free_plan_key(self.session)
        entitlements = await plan_catalog.entitlements_for(self.session, plan)
        if "bridge_number" not in entitlements:
            logger.info("claim_bridge_number user=%s plan=%s not entitled", user_id, plan)
            return None, "not_entitled"

        if sub and sub.bridge_number and not sub.bridge_number.startswith("FAILED:"):
            return sub.bridge_number, "assigned"

        await publish_event(
            TOPIC_PAYMENT_COMPLETED,
            {
                "event_type": TOPIC_PAYMENT_COMPLETED,
                "subscription_id": str(sub.id) if sub else "",
                "user_id": user_id,
                "amount": "0",
                "currency": "USD",
                "type": "plan_entitlement",
            },
        )
        logger.info("claim_bridge_number user=%s plan=%s provisioning requested", user_id, plan)
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
