"""Nothing is created for an account that no longer exists.

Oct 1 2026: the app polled the bridge number claim while its account was
being deleted; this service created a free subscription for the deleted
user half a second after the deletion, telephony gave it a phone number,
and the deletion audit could only report the orphans. These tests pin the
guard and the audit's repair.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.audit import deletion_audit as audit
from app.services import payment_service as ps
from app.user_lookup import UserGoneError


def gone(monkeypatch):
    async def _no(_session, _uid):
        return False

    monkeypatch.setattr(ps, "user_exists", _no)


def service():
    svc = ps.PaymentService(MagicMock())
    svc.repo = MagicMock()
    svc.repo.get_active_subscription = AsyncMock(return_value=None)
    svc.repo.create_subscription = AsyncMock()
    return svc


@pytest.mark.asyncio
async def test_claim_for_a_deleted_account_creates_nothing(monkeypatch):
    gone(monkeypatch)
    published = AsyncMock()
    monkeypatch.setattr(ps, "publish_event", published)
    svc = service()
    assert await svc.claim_bridge_number("277") == (None, "user_deleted")
    svc.repo.create_subscription.assert_not_awaited()
    published.assert_not_awaited()


@pytest.mark.asyncio
async def test_free_subscription_is_refused_for_a_deleted_account(monkeypatch):
    gone(monkeypatch)
    svc = service()
    with pytest.raises(UserGoneError):
        await svc.create_free_subscription("277")
    svc.repo.create_subscription.assert_not_awaited()


@pytest.mark.asyncio
async def test_plan_switch_is_refused_for_a_deleted_account(monkeypatch):
    gone(monkeypatch)
    with pytest.raises(UserGoneError):
        await service().select_plan_without_payment("277", "record_pro")


# ── The audit repairs instead of only reporting ───────────────────────────


class _Session:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def audit_world(monkeypatch, *, exists, residue):
    monkeypatch.setattr(audit, "AUDIT_DELAY_SECONDS", 0)
    import app.database as db

    monkeypatch.setattr(db, "async_session", lambda: _Session())
    import app.user_lookup as lookup

    async def _exists(_s, uid):
        return exists.get(uid, False)

    monkeypatch.setattr(lookup, "user_exists", _exists)

    async def _residue(_s, uid):
        return residue.get(uid, {})

    monkeypatch.setattr(audit, "_count_residue_for_user", _residue)
    captured = AsyncMock()
    monkeypatch.setattr(audit, "_capture_posthog", captured)
    published = AsyncMock()
    import app.kafka.producer as producer

    monkeypatch.setattr(producer, "publish_event", published)
    return captured, published


def test_leak_of_a_deleted_account_is_reported_and_repaired(monkeypatch):
    captured, published = audit_world(
        monkeypatch, exists={}, residue={"277": {"subscriptions": 1, "phone_number_assignments": 1}}
    )
    asyncio.run(audit.audit_user_deletion(["277"]))
    assert captured.await_args.kwargs["event"] == "account_delete_orphans_detected"
    assert captured.await_args.kwargs["properties"]["will_repair"] is True
    topic, payload = published.await_args.args
    assert topic == "user.deleted"
    assert payload["data"] == {"userIds": ["277"], "repair": True}


def test_a_repair_pass_never_repairs_again(monkeypatch):
    captured, published = audit_world(monkeypatch, exists={}, residue={"277": {"subscriptions": 1}})
    asyncio.run(audit.audit_user_deletion(["277"], attempt=1))
    assert captured.await_args.kwargs["properties"]["will_repair"] is False
    published.assert_not_awaited()


def test_a_clean_repair_pass_is_reported_as_repaired(monkeypatch):
    captured, published = audit_world(monkeypatch, exists={}, residue={})
    asyncio.run(audit.audit_user_deletion(["277"], attempt=1))
    assert captured.await_args.kwargs["event"] == "account_delete_orphans_repaired"
    published.assert_not_awaited()


def test_an_account_that_still_exists_is_never_touched(monkeypatch):
    captured, published = audit_world(
        monkeypatch, exists={"281": True}, residue={"281": {"subscriptions": 1}}
    )
    asyncio.run(audit.audit_user_deletion(["281"]))
    captured.assert_not_awaited()
    published.assert_not_awaited()
