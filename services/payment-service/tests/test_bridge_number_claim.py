"""The payment free path to a bridge number.

Before this, provisioning hung off `payment.completed` alone. With the admin
giving the free plan every feature, signup skipped the paywall and a new
creator never got a number. These tests pin the claim rules.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from app.services import payment_service as ps


def make_service(monkeypatch, *, sub, entitlements, free_sub=None):
    svc = ps.PaymentService(MagicMock())
    svc.repo = MagicMock()
    calls = {"n": 0}

    async def get_active(_user_id):
        calls["n"] += 1
        if sub is None and calls["n"] > 1:
            return free_sub
        return sub

    svc.repo.get_active_subscription = get_active
    svc.create_free_subscription = AsyncMock()
    published = AsyncMock()
    monkeypatch.setattr(ps, "publish_event", published)
    monkeypatch.setattr(
        ps.plan_catalog, "entitlements_for", AsyncMock(return_value=frozenset(entitlements))
    )
    monkeypatch.setattr(ps.plan_catalog, "free_plan_key", AsyncMock(return_value="connect_free"))
    return svc, published


def sub_with(bridge=None, plan="connect_free"):
    return SimpleNamespace(id=uuid4(), plan=plan, bridge_number=bridge)


@pytest.mark.asyncio
async def test_entitled_without_number_requests_provisioning(monkeypatch):
    sub = sub_with()
    svc, published = make_service(monkeypatch, sub=sub, entitlements={"bridge_number", "listen"})
    number, status = await svc.claim_bridge_number("42")
    assert (number, status) == (None, "provisioning")
    published.assert_awaited_once()
    topic, payload = published.await_args.args
    assert topic == "payment.completed"
    assert payload["user_id"] == "42"
    assert payload["type"] == "plan_entitlement"
    assert payload["amount"] == "0"
    assert payload["subscription_id"] == str(sub.id)


@pytest.mark.asyncio
async def test_not_entitled_never_publishes(monkeypatch):
    svc, published = make_service(monkeypatch, sub=sub_with(), entitlements={"listen"})
    assert await svc.claim_bridge_number("42") == (None, "not_entitled")
    published.assert_not_awaited()


@pytest.mark.asyncio
async def test_existing_number_is_returned_without_a_new_request(monkeypatch):
    svc, published = make_service(
        monkeypatch, sub=sub_with("+15005550006"), entitlements={"bridge_number"}
    )
    assert await svc.claim_bridge_number("42") == ("+15005550006", "assigned")
    published.assert_not_awaited()


@pytest.mark.asyncio
async def test_failed_marker_retries_provisioning(monkeypatch):
    svc, published = make_service(
        monkeypatch, sub=sub_with("FAILED:twilio down"), entitlements={"bridge_number"}
    )
    assert await svc.claim_bridge_number("42") == (None, "provisioning")
    published.assert_awaited_once()


@pytest.mark.asyncio
async def test_missing_subscription_is_created_first(monkeypatch):
    """The user.created event may not have landed yet when signup claims."""
    created = sub_with()
    svc, published = make_service(
        monkeypatch, sub=None, entitlements={"bridge_number"}, free_sub=created
    )
    assert await svc.claim_bridge_number("42") == (None, "provisioning")
    svc.create_free_subscription.assert_awaited_once_with("42")
    assert published.await_args.args[1]["subscription_id"] == str(created.id)


@pytest.mark.asyncio
async def test_repeat_claims_stay_safe(monkeypatch):
    """Each claim republishes until the number lands; telephony is idempotent."""
    svc, published = make_service(monkeypatch, sub=sub_with(), entitlements={"bridge_number"})
    await svc.claim_bridge_number("42")
    await svc.claim_bridge_number("42")
    assert published.await_count == 2


# ── Route guard ───────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("role", "for_user_id", "expected_target"),
    [("creator", None, "7"), ("creator", "99", "7"), ("representative", "99", "99")],
)
async def test_route_targets(monkeypatch, role, for_user_id, expected_target):
    from app.routers import payments

    seen = {}

    class FakeSvc:
        def __init__(self, _session):
            pass

        async def claim_bridge_number(self, target):
            seen["target"] = target
            return None, "provisioning"

    monkeypatch.setattr(payments, "PaymentService", FakeSvc)
    res = await payments.claim_bridge_number(
        user_id="7", role=role, for_user_id=for_user_id, session=MagicMock()
    )
    assert seen["target"] == expected_target
    assert res.data["status"] == "provisioning"


@pytest.mark.asyncio
@pytest.mark.parametrize(("role", "for_user_id"), [("listener", None), ("user", "99"), ("representative", None)])
async def test_route_rejects_non_creators(monkeypatch, role, for_user_id):
    from fastapi import HTTPException

    from app.routers import payments

    with pytest.raises(HTTPException) as exc:
        await payments.claim_bridge_number(
            user_id="7", role=role, for_user_id=for_user_id, session=MagicMock()
        )
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_route_maps_not_entitled_to_403(monkeypatch):
    from fastapi import HTTPException

    from app.routers import payments

    class FakeSvc:
        def __init__(self, _session):
            pass

        async def claim_bridge_number(self, _target):
            return None, "not_entitled"

    monkeypatch.setattr(payments, "PaymentService", FakeSvc)
    with pytest.raises(HTTPException) as exc:
        await payments.claim_bridge_number(
            user_id="7", role="creator", for_user_id=None, session=MagicMock()
        )
    assert exc.value.status_code == 403
