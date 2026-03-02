import logging
from uuid import UUID

from sqlalchemy import desc, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.subscription import Subscription
from app.models.transaction import Transaction

logger = logging.getLogger(__name__)


class TransactionRepository:
    """Data-access layer for Transaction and Subscription entities."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # ── Transactions ──────────────────────────────────────────────

    async def create_transaction(self, transaction: Transaction) -> Transaction:
        """Insert a new transaction and return the refreshed instance."""
        self.session.add(transaction)
        await self.session.commit()
        await self.session.refresh(transaction)
        return transaction

    async def get_transaction_by_id(self, transaction_id: UUID) -> Transaction | None:
        """Fetch a single transaction by primary key."""
        result = await self.session.execute(
            select(Transaction).where(Transaction.id == transaction_id)
        )
        return result.scalar_one_or_none()

    async def list_transactions(
        self,
        user_id: str,
        cursor: str | None = None,
        limit: int = 20,
    ) -> tuple[list[Transaction], int]:
        """Return a page of transactions for a user, plus total count."""
        query = select(Transaction).where(Transaction.user_id == user_id)
        if cursor:
            # Cursor-based pagination: fetch records created before the cursor
            cursor_txn = await self.get_transaction_by_id(UUID(cursor))
            if cursor_txn and cursor_txn.created_at is not None:
                query = query.where(Transaction.created_at < cursor_txn.created_at)
        query = query.order_by(desc(Transaction.created_at)).limit(limit)
        result = await self.session.execute(query)
        transactions = list(result.scalars().all())

        count_query = (
            select(func.count())
            .select_from(Transaction)
            .where(Transaction.user_id == user_id)
        )
        count_result = await self.session.execute(count_query)
        total = count_result.scalar() or 0

        return transactions, total

    async def update_transaction_status(
        self, transaction_id: UUID, status: str
    ) -> Transaction | None:
        """Update a transaction's status and return the updated record."""
        await self.session.execute(
            update(Transaction)
            .where(Transaction.id == transaction_id)
            .values(status=status)
        )
        await self.session.commit()
        return await self.get_transaction_by_id(transaction_id)

    # ── Subscriptions ─────────────────────────────────────────────

    async def create_subscription(self, subscription: Subscription) -> Subscription:
        """Insert a new subscription and return the refreshed instance."""
        self.session.add(subscription)
        await self.session.commit()
        await self.session.refresh(subscription)
        return subscription

    async def get_active_subscription(self, user_id: str) -> Subscription | None:
        """Return the most recent active subscription for a user."""
        result = await self.session.execute(
            select(Subscription)
            .where(
                Subscription.user_id == user_id,
                Subscription.status == "active",
            )
            .order_by(desc(Subscription.created_at))
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def get_subscription_by_id(self, subscription_id: UUID) -> Subscription | None:
        """Fetch a single subscription by primary key."""
        result = await self.session.execute(
            select(Subscription).where(Subscription.id == subscription_id)
        )
        return result.scalar_one_or_none()

    async def cancel_subscription(self, subscription_id: UUID) -> Subscription | None:
        """Mark a subscription as cancelled."""
        await self.session.execute(
            update(Subscription)
            .where(Subscription.id == subscription_id)
            .values(status="cancelled")
        )
        await self.session.commit()
        return await self.get_subscription_by_id(subscription_id)

    async def deactivate_user_subscriptions(self, user_id: str) -> None:
        """Cancel all active subscriptions for a user (used before creating a new one)."""
        await self.session.execute(
            update(Subscription)
            .where(
                Subscription.user_id == user_id,
                Subscription.status == "active",
            )
            .values(status="cancelled")
        )
        await self.session.commit()

    async def update_subscription_bridge_number(
        self, user_id: str, phone_number: str
    ) -> None:
        """Set the bridge_number on the user's active subscription."""
        await self.session.execute(
            update(Subscription)
            .where(
                Subscription.user_id == user_id,
                Subscription.status == "active",
            )
            .values(bridge_number=phone_number)
        )
        await self.session.commit()
