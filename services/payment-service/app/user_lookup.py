"""Does an account still exist?

The services share one Postgres, and ``users`` is the source of truth for
whether an account exists. Asked before creating anything for a user: on
Oct 1 2026 the app kept polling ``POST /bridge-number/claim`` while the
account was being deleted, this service created a free subscription for a
user that had been deleted half a second earlier, and telephony assigned
it a phone number. The deletion audit caught it; nothing cleaned it.
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


class UserGoneError(Exception):
    """The account no longer exists (deleted), so nothing is created for it."""

    def __init__(self, user_id: str):
        super().__init__(f"user {user_id} does not exist")
        self.user_id = user_id


async def user_exists(session: AsyncSession, user_id: str) -> bool:
    result = await session.execute(
        text("SELECT 1 FROM users WHERE id::text = :uid LIMIT 1"), {"uid": str(user_id)}
    )
    return result.first() is not None
