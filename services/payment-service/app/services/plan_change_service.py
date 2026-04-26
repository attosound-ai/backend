"""Plan change orchestration: upgrade (prorated charge) or downgrade (scheduled).

Single Responsibility: orchestrates the moving parts (calculator, repo, Stripe).
The math lives in proration_calculator. The Stripe calls live in stripe_service.
The DB writes live in TransactionRepository. This file coordinates.
"""

import logging
from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

import stripe
from sqlalchemy.ext.asyncio import AsyncSession

from app.entitlements import can_upgrade
from app.models.subscription import Subscription
from app.models.transaction import Transaction
from app.repositories.transaction_repo import TransactionRepository
from app.services.proration_calculator import (
    PLAN_RANK,
    PlanChangePreview,
    preview as build_preview,
)
from app.services.stripe_service import get_or_create_customer

logger = logging.getLogger(__name__)


class PlanChangeError(ValueError):
    """Raised when a plan change is not allowed (unknown plan, no active sub, etc)."""


class PlanChangeService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = TransactionRepository(session)

    # ── Read-only preview ─────────────────────────────────────────────

    async def preview(self, user_id: str, target_plan: str) -> PlanChangePreview:
        sub = await self.repo.get_active_subscription(user_id)
        if not sub:
            raise PlanChangeError("No active subscription")
        if target_plan not in PLAN_RANK:
            raise PlanChangeError(f"Unknown plan: {target_plan}")
        return build_preview(sub.plan, target_plan, sub.expires_at)

    # ── State-mutating actions ────────────────────────────────────────

    async def start_change(
        self,
        user_id: str,
        target_plan: str,
        email: str = "",
    ) -> dict:
        """Start a plan change.

        - upgrade   → returns { kind: 'upgrade', clientSecret, paymentIntentId, amountCents }
        - downgrade → returns { kind: 'downgrade_scheduled', appliesAt }
        - same      → raises PlanChangeError

        `email` is only required for upgrades (Stripe customer lookup/creation).
        """
        sub = await self.repo.get_active_subscription(user_id)
        if not sub:
            raise PlanChangeError("No active subscription")

        prv = build_preview(sub.plan, target_plan, sub.expires_at)

        if prv.direction == "same":
            raise PlanChangeError("Already on this plan")

        if prv.direction == "upgrade":
            if not can_upgrade(sub.plan, target_plan):
                raise PlanChangeError("Invalid upgrade path")
            return await self._charge_upgrade_prorated(sub, prv, email or "")

        # downgrade
        await self.repo.schedule_subscription_change(
            sub.id, target_plan, prv.applies_at
        )
        return {
            "kind": "downgrade_scheduled",
            "appliesAt": prv.applies_at.isoformat(),
            "targetPlan": target_plan,
        }

    async def cancel_pending_change(self, user_id: str) -> Subscription | None:
        sub = await self.repo.get_active_subscription(user_id)
        if not sub:
            return None
        if not sub.pending_plan:
            return sub
        return await self.repo.clear_pending_change(sub.id)

    async def confirm_upgrade_paid(
        self, user_id: str, target_plan: str, payment_intent_id: str
    ) -> Subscription | None:
        """Called after the mobile client confirms the PaymentIntent succeeded.

        Materializes the plan change in our DB. The webhook is the
        authoritative path; this is a low-latency UX accelerator.
        """
        sub = await self.repo.get_active_subscription(user_id)
        if not sub:
            return None

        # Idempotent: if Stripe already pushed the webhook and updated us, no-op.
        if sub.plan == target_plan:
            return sub

        # Record the prorated transaction (best-effort; webhook will reconcile).
        # We don't know the exact amount here without re-fetching the PI;
        # leaving txn creation to the webhook keeps a single source of truth.
        return await self.repo.upgrade_subscription_plan(sub.id, target_plan)

    # ── Internals ─────────────────────────────────────────────────────

    async def _charge_upgrade_prorated(
        self,
        sub: Subscription,
        prv: PlanChangePreview,
        email: str,
    ) -> dict:
        if prv.amount_due_cents <= 0:
            # Edge case: target costs ≤ current at this point in cycle.
            # Apply immediately without charging.
            await self.repo.upgrade_subscription_plan(sub.id, prv.target_plan)
            return {
                "kind": "upgrade_free",
                "appliesAt": datetime.now(timezone.utc).isoformat(),
                "targetPlan": prv.target_plan,
            }

        customer_id = await get_or_create_customer(sub.user_id, email)

        intent = stripe.PaymentIntent.create(
            amount=prv.amount_due_cents,
            currency="usd",
            customer=customer_id,
            description=(
                f"Plan change: {prv.current_plan} → {prv.target_plan} "
                f"(prorated, {prv.days_remaining} days left)"
            ),
            metadata={
                "user_id": sub.user_id,
                "subscription_id": str(sub.id),
                "kind": "plan_change_upgrade",
                "from_plan": prv.current_plan,
                "to_plan": prv.target_plan,
                "days_remaining": str(prv.days_remaining),
            },
            automatic_payment_methods={"enabled": True},
        )

        logger.info(
            "PaymentIntent %s created for prorated upgrade user=%s %s→%s amount=%scts",
            intent.id, sub.user_id, prv.current_plan, prv.target_plan,
            prv.amount_due_cents,
        )

        # Persist a pending transaction so we have a paper trail even if the
        # client dies before confirming.
        await self.repo.create_transaction(
            Transaction(
                id=uuid4(),
                user_id=sub.user_id,
                amount=Decimal(prv.amount_due_cents) / 100,
                currency="USD",
                type="subscription",
                status="pending",
                reference_id=intent.id,
                description=f"Prorated upgrade {prv.current_plan} → {prv.target_plan}",
            )
        )

        return {
            "kind": "upgrade",
            "clientSecret": intent.client_secret,
            "paymentIntentId": intent.id,
            "amountCents": prv.amount_due_cents,
            "currency": "usd",
            "targetPlan": prv.target_plan,
        }


# ── Lazy materialization helper (called from get_active_subscription) ─

async def materialize_pending_if_due(
    repo: TransactionRepository, sub: Subscription
) -> Subscription:
    """If the subscription has a scheduled change whose date has passed,
    apply it inline. Avoids a cron job — the change appears the next time
    anyone reads the subscription.
    """
    if not sub.pending_plan or not sub.pending_plan_applies_at:
        return sub
    if sub.pending_plan_applies_at > datetime.now(timezone.utc):
        return sub

    target = sub.pending_plan
    logger.info(
        "Materializing scheduled plan change for sub=%s %s→%s",
        sub.id, sub.plan, target,
    )
    updated = await repo.upgrade_subscription_plan(sub.id, target)
    return updated or sub
