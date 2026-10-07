"""What `GET /payments/bridge-number` says to an account without a number.

Until Oct 7 2026 it said 'provisioning' to everybody. A listener then saw
"being set up" in Settings for good, and the app asked again every four
seconds, each time with a claim that came back 403 (50 of them from one
account in three days). 'provisioning' now means a number is really on its
way; 'unavailable' means none ever will be.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from app.routers import payments
from app.services import payment_service as ps


def fake_service(monkeypatch, *, number=None, grants=True):
    """The service behind the route, recording whose plan was looked at."""
    seen = {"read": [], "plan_of": []}

    class FakeSvc:
        def __init__(self, _session):
            pass

        async def get_bridge_number(self, target):
            seen["read"].append(target)
            return (number, "assigned") if number else (None, "provisioning")

        async def plan_grants_bridge_number(self, owner):
            seen["plan_of"].append(owner)
            return grants

    monkeypatch.setattr(payments, "PaymentService", FakeSvc)
    return seen


async def ask(role, for_user_id=None):
    res = await payments.get_bridge_number(
        user_id="7", role=role, for_user_id=for_user_id, session=MagicMock()
    )
    return res.data


# ── Who is told to wait ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_creator_with_the_feature_is_waiting(monkeypatch):
    seen = fake_service(monkeypatch, grants=True)
    assert await ask("creator") == {"bridgeNumber": None, "status": "provisioning"}
    assert seen == {"read": ["7"], "plan_of": ["7"]}


@pytest.mark.asyncio
async def test_representative_waits_for_the_number_of_its_creator(monkeypatch):
    seen = fake_service(monkeypatch, grants=True)
    assert await ask("representative", "99") == {"bridgeNumber": None, "status": "provisioning"}
    assert seen == {"read": ["99"], "plan_of": ["99"]}


# ── Who is told there is none ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_creator_on_a_plan_without_the_feature_has_none(monkeypatch):
    fake_service(monkeypatch, grants=False)
    assert await ask("creator") == {"bridgeNumber": None, "status": "unavailable"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("role", "for_user_id"),
    [("listener", None), ("user", None), ("user", "99"), ("listener", "99"), ("representative", None)],
)
async def test_an_account_that_cannot_hold_a_number_has_none(monkeypatch, role, for_user_id):
    seen = fake_service(monkeypatch, grants=True)
    assert await ask(role, for_user_id) == {"bridgeNumber": None, "status": "unavailable"}
    # The plan is not even looked at: the kind of account decides.
    assert seen["plan_of"] == []


@pytest.mark.asyncio
async def test_representative_of_a_creator_without_the_feature_has_none(monkeypatch):
    seen = fake_service(monkeypatch, grants=False)
    assert await ask("representative", "99") == {"bridgeNumber": None, "status": "unavailable"}
    assert seen["plan_of"] == ["99"]


# ── A number that exists is always shown ──────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("role", "for_user_id"),
    [("creator", None), ("representative", "99"), ("listener", "99")],
)
async def test_an_assigned_number_is_returned_whatever_the_plan(monkeypatch, role, for_user_id):
    seen = fake_service(monkeypatch, number="+18602374408", grants=False)
    assert await ask(role, for_user_id) == {"bridgeNumber": "+18602374408", "status": "assigned"}
    assert seen["plan_of"] == []


# ── The claim and the read agree on who can hold a number ─────────────


@pytest.mark.parametrize(
    ("role", "for_user_id", "owner"),
    [
        ("creator", None, "7"),
        ("creator", "99", "7"),
        ("representative", "99", "99"),
        ("representative", None, None),
        ("listener", None, None),
        ("user", "99", None),
    ],
)
def test_owner_of_the_number(role, for_user_id, owner):
    assert payments.bridge_number_owner(role, "7", for_user_id) == owner


# ── The plan of the user, read without changing anything ──────────────


def service_with(monkeypatch, *, sub, entitlements):
    svc = ps.PaymentService(MagicMock())
    svc.repo = MagicMock()
    svc.repo.get_active_subscription = AsyncMock(return_value=sub)
    svc.create_free_subscription = AsyncMock()
    asked = AsyncMock(return_value=frozenset(entitlements))
    monkeypatch.setattr(ps.plan_catalog, "entitlements_for", asked)
    monkeypatch.setattr(ps.plan_catalog, "free_plan_key", AsyncMock(return_value="connect_free"))
    published = AsyncMock()
    monkeypatch.setattr(ps, "publish_event", published)
    return svc, asked, published


@pytest.mark.asyncio
async def test_plan_with_the_feature_grants_it(monkeypatch):
    sub = SimpleNamespace(id=uuid4(), plan="record", bridge_number=None)
    svc, asked, _ = service_with(monkeypatch, sub=sub, entitlements={"bridge_number", "listen"})
    assert await svc.plan_grants_bridge_number("42") is True
    assert asked.await_args.args[1] == "record"


@pytest.mark.asyncio
async def test_plan_without_the_feature_does_not(monkeypatch):
    sub = SimpleNamespace(id=uuid4(), plan="connect_free", bridge_number=None)
    svc, _, _ = service_with(monkeypatch, sub=sub, entitlements={"listen"})
    assert await svc.plan_grants_bridge_number("42") is False


@pytest.mark.asyncio
async def test_user_without_subscription_is_judged_by_the_free_plan_and_nothing_is_written(monkeypatch):
    svc, asked, published = service_with(monkeypatch, sub=None, entitlements={"bridge_number"})
    assert await svc.plan_grants_bridge_number("42") is True
    assert asked.await_args.args[1] == "connect_free"
    svc.create_free_subscription.assert_not_awaited()
    published.assert_not_awaited()
