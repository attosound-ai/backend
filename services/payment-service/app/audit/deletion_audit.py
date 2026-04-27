"""Post-deletion residue audit.

After a `user.deleted` Kafka event is processed, schedule a check
that runs ~60s later to verify NO rows remain for the deleted user
in any table this service can reach. Any residue is captured as
PostHog event `account_delete_orphans_detected` so we get an alarm
the moment the cleanup pipeline regresses.

Single Responsibility: detect + report. The audit never deletes —
that's the consumer's job. If we cleaned up here we would mask the
bug we're trying to surface.

Scope: this service can directly query its own Postgres connection,
which on Railway is the shared instance backing payment-service AND
telephony-service. We DO NOT cross-query the social DB or Cassandra
from here — those have their own consumers and their own audits
should live there. The PostHog event includes a `scope` property so
adding more services later doesn't conflate signals.
"""

import asyncio
import logging
import os
from datetime import datetime, timezone

import httpx
from sqlalchemy import text

logger = logging.getLogger(__name__)

# Window to give downstream consumers (telephony, etc.) time to process
# the same Kafka event before we declare the system clean. 60s is the
# upper bound observed in practice for the slowest consumer; tune via
# the env var if cross-service Kafka lag grows.
AUDIT_DELAY_SECONDS = int(os.environ.get("DELETION_AUDIT_DELAY_S", "60"))

POSTHOG_HOST = os.environ.get("POSTHOG_HOST", "https://us.i.posthog.com")
POSTHOG_API_KEY = os.environ.get("POSTHOG_API_KEY", "")

# Tables we audit. Each entry: (table, column, sql).
# `sql` is parameterised on a single :uid bind to keep injection
# surface zero — the user_ids come from a Kafka event payload which
# shouldn't contain SQL but defence in depth never hurts.
_AUDITED_TABLES: tuple[tuple[str, str], ...] = (
    ("subscriptions",            'SELECT count(*) FROM subscriptions WHERE user_id = :uid'),
    ("transactions",             'SELECT count(*) FROM transactions WHERE user_id = :uid'),
    ("calls",                    'SELECT count(*) FROM calls WHERE "userId" = :uid'),
    ("projects",                 'SELECT count(*) FROM projects WHERE "userId" = :uid'),
    ("phone_number_assignments", 'SELECT count(*) FROM phone_number_assignments WHERE "userId" = :uid'),
    ("push_tokens",              'SELECT count(*) FROM push_tokens WHERE user_id::text = :uid'),
    ("audio_segments",
     'SELECT count(*) FROM audio_segments WHERE "projectId" IN '
     '(SELECT id FROM projects WHERE "userId" = :uid)'),
    ("timeline_clips",
     'SELECT count(*) FROM timeline_clips WHERE "projectId" IN '
     '(SELECT id FROM projects WHERE "userId" = :uid)'),
)


async def _count_residue_for_user(session, user_id: str) -> dict[str, int]:
    """Return a dict mapping table → row count for any non-zero counts."""
    counts: dict[str, int] = {}
    for table_name, sql in _AUDITED_TABLES:
        try:
            result = await session.execute(text(sql), {"uid": user_id})
            n = result.scalar() or 0
            if n > 0:
                counts[table_name] = n
        except Exception as exc:
            # Table-not-found or other transient error: skip without
            # poisoning the audit. Surfaces in logs for diagnosis.
            logger.warning(
                "Audit query failed for table %s, user %s: %s",
                table_name, user_id, exc,
            )
    return counts


async def _capture_posthog(event: str, properties: dict) -> None:
    """Fire-and-forget HTTP capture to PostHog. Never raises."""
    if not POSTHOG_API_KEY:
        logger.debug("POSTHOG_API_KEY unset; skipping capture for %s", event)
        return
    payload = {
        "api_key": POSTHOG_API_KEY,
        "event": event,
        "distinct_id": "system-audit",
        "properties": properties,
    }
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(f"{POSTHOG_HOST}/capture/", json=payload)
    except Exception as exc:
        logger.warning("PostHog capture failed for %s: %s", event, exc)


async def audit_user_deletion(user_ids: list[str]) -> None:
    """Run 60s after user.deleted; emit PostHog event if anything leaks."""
    if not user_ids:
        return

    await asyncio.sleep(AUDIT_DELAY_SECONDS)

    from app.database import async_session

    leaks_by_user: dict[str, dict[str, int]] = {}

    async with async_session() as session:
        for user_id in user_ids:
            residue = await _count_residue_for_user(session, str(user_id))
            if residue:
                leaks_by_user[str(user_id)] = residue

    if not leaks_by_user:
        logger.info(
            "Deletion audit OK for users %s (delay=%ds, no residue)",
            user_ids, AUDIT_DELAY_SECONDS,
        )
        return

    total_orphan_rows = sum(
        sum(counts.values()) for counts in leaks_by_user.values()
    )

    logger.error(
        "Deletion audit FAILED — orphan rows detected: %s",
        leaks_by_user,
    )

    await _capture_posthog(
        event="account_delete_orphans_detected",
        properties={
            "scope": "payment_service.shared_postgres",
            "audit_delay_seconds": AUDIT_DELAY_SECONDS,
            "user_ids": list(leaks_by_user.keys()),
            "residue_by_user": leaks_by_user,
            "total_orphan_rows": total_orphan_rows,
            "detected_at": datetime.now(timezone.utc).isoformat(),
        },
    )
