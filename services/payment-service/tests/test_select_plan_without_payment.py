"""Plan selection with no payment (testing period).

The switch is off unless FREE_PLAN_SWITCHING is set, so a missing variable can
never hand paid plans out. These tests pin that gate, who may act for whom,
that the bridge number survives a switch, and that only creators get numbers.
"""

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.routers import subscriptions as subs
from app.schemas.subscription import SelectPlanRequest
from app.services import payment_service as ps


def make_service(monkeypatch, current):
    svc = ps.PaymentService(MagicMock())
    svc.repo = MagicMock()
    svc.repo.get_active_subscription = AsyncMock(return_value=current)
    svc.repo.deactivate_user_subscriptions = AsyncMock()
    svc.repo.create_transaction = AsyncMock(side_effect=lambda t: t)
    svc.repo.create_subscription = AsyncMock(side_effect=lambda s: s)
    svc._to_response = AsyncMock(side_effect=lambda s: s)
    monkeypatch.setattr(ps.plan_catalog, "duration_days", AsyncMock(return_value=365))
    return svc


def sub(plan, bridge=None):
    return SimpleNamespace(id=uuid4(), plan=plan, bridge_number=bridge)


@pytest.mark.asyncio
async def test_switch_creates_zero_amount_record_and_carries_number(monkeypatch):
    svc = make_service(monkeypatch, sub("connect_free", "+15005551345"))
    out = await svc.select_plan_without_payment("275", "record_pro")
    assert out.plan == "record_pro"
    assert out.status == "active"
    assert out.bridge_number == "+15005551345"
    svc.repo.deactivate_user_subscriptions.assert_awaited_once_with("275")
    txn = svc.repo.create_transaction.await_args.args[0]
    assert txn.amount == Decimal("0.00")
    assert txn.status == "completed"
    assert out.transaction_id == txn.id


@pytest.mark.asyncio
async def test_same_plan_is_a_no_op(monkeypatch):
    current = sub("record_pro", "+15005551345")
    svc = make_service(monkeypatch, current)
    assert await svc.select_plan_without_payment("275", "record_pro") is current
    svc.repo.deactivate_user_subscriptions.assert_not_awaited()
    svc.repo.create_subscription.assert_not_awaited()


@pytest.mark.asyncio
async def test_failed_marker_is_not_carried(monkeypatch):
    svc = make_service(monkeypatch, sub("connect_free", "FAILED:twilio"))
    out = await svc.select_plan_without_payment("275", "record")
    assert out.bridge_number is None


@pytest.mark.asyncio
async def test_user_without_subscription_can_switch(monkeypatch):
    svc = make_service(monkeypatch, None)
    out = await svc.select_plan_without_payment("9", "record")
    assert out.plan == "record"
    assert out.bridge_number is None


# ── Route ─────────────────────────────────────────────────────────────


class FakeSvc:
    calls: list = []

    def __init__(self, _session):
        pass

    async def select_plan_without_payment(self, user, plan):
        FakeSvc.calls.append(("select", user, plan))
        return SimpleNamespace(model_dump=lambda **_: {"plan": plan, "userId": user})

    async def claim_bridge_number(self, user):
        FakeSvc.calls.append(("claim", user))
        return None, "provisioning"

    async def get_active_subscription(self, _user):
        return None


@pytest.fixture
def route(monkeypatch):
    FakeSvc.calls = []
    monkeypatch.setattr(subs, "PaymentService", FakeSvc)
    monkeypatch.setattr(subs, "_require_active_plan", AsyncMock())
    monkeypatch.setattr(subs.settings, "free_plan_switching", True)
    return subs.select_plan


@pytest.mark.asyncio
async def test_route_is_closed_when_the_switch_is_off(monkeypatch, route):
    monkeypatch.setattr(subs.settings, "free_plan_switching", False)
    with pytest.raises(HTTPException) as exc:
        await route(SelectPlanRequest(plan="record_pro"), user_id="7", role="creator", session=MagicMock())
    assert exc.value.status_code == 403
    assert FakeSvc.calls == []


@pytest.mark.asyncio
async def test_creator_switches_own_plan_and_claims_number(route):
    res = await route(SelectPlanRequest(plan="record_pro"), user_id="7", role="creator", session=MagicMock())
    assert res.data["plan"] == "record_pro"
    assert FakeSvc.calls == [("select", "7", "record_pro"), ("claim", "7")]


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["listener", "user", "representative"])
async def test_non_creator_switches_without_getting_a_number(route, role):
    await route(SelectPlanRequest(plan="record"), user_id="7", role=role, session=MagicMock())
    assert FakeSvc.calls == [("select", "7", "record")]


@pytest.mark.asyncio
async def test_representative_switches_linked_creator(route):
    await route(
        SelectPlanRequest(plan="record", forUserId="99"),
        user_id="7",
        role="representative",
        session=MagicMock(),
    )
    assert FakeSvc.calls == [("select", "99", "record"), ("claim", "99")]


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["creator", "listener", "user"])
async def test_only_a_representative_may_act_for_someone_else(route, role):
    with pytest.raises(HTTPException) as exc:
        await route(
            SelectPlanRequest(plan="record", forUserId="99"),
            user_id="7",
            role=role,
            session=MagicMock(),
        )
    assert exc.value.status_code == 403
    assert FakeSvc.calls == []


@pytest.mark.asyncio
async def test_unknown_plan_is_rejected_before_any_write(monkeypatch, route):
    monkeypatch.setattr(
        subs, "_require_active_plan", AsyncMock(side_effect=HTTPException(status_code=404, detail="x"))
    )
    with pytest.raises(HTTPException) as exc:
        await route(SelectPlanRequest(plan="ghost"), user_id="7", role="creator", session=MagicMock())
    assert exc.value.status_code == 404
    assert FakeSvc.calls == []


def test_switch_defaults_to_off():
    from app.config import Settings

    assert Settings.model_fields["free_plan_switching"].default is False
