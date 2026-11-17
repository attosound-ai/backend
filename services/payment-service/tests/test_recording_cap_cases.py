"""The recording cap and the open recording switch, end to end over the routes.

Three cases (David, Nov 12 2026): no limit (today), a limit, and a value
changed from the admin dashboard reaching the app's /me.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import plan_catalog
from app.config import settings
from app.database import get_session
from app.middleware.auth import get_current_user_id
from app.plan_catalog import PlanRow, setting_flag, with_open_recording
from app.routers import admin as admin_module
from app.routers import subscriptions as subs_module
from app.routers.admin import PlanSettingsBody

TOKEN = "test-admin-token"
BASE = frozenset({"browse_search", "listen", "comment"})


def plan(key: str, price: int, ents: set[str], cap: int | None = None, sort: int = 0) -> PlanRow:
    return PlanRow(
        key=key,
        name=key,
        description=None,
        price_cents=price,
        currency="USD",
        billing_period="forever" if price == 0 else "year",
        duration_days=365,
        stripe_price_id=None,
        popular=False,
        active=True,
        sort_order=sort,
        features=(),
        entitlements=frozenset(ents),
        max_recording_seconds=cap,
    )


class FakeStore:
    """The catalog in memory: plans by key and the plan_settings rows."""

    def __init__(self):
        self.plans = {
            "connect_free": plan("connect_free", 0, set(BASE)),
            "record": plan("record", 9900, set(BASE) | {"record_upload"}, sort=1),
            "record_pro": plan(
                "record_pro", 13900, set(BASE) | {"record_upload", "advanced_production"}, sort=2
            ),
        }
        self.settings: dict[str, dict] = {}
        self.user_plan = "record"


@pytest.fixture
def store(monkeypatch):
    st = FakeStore()

    async def snapshot(_session):
        return tuple(sorted(st.plans.values(), key=lambda r: r.sort_order))

    async def settings_snapshot(_session):
        return dict(st.settings)

    monkeypatch.setattr(plan_catalog, "snapshot", snapshot)
    monkeypatch.setattr(plan_catalog, "settings_snapshot", settings_snapshot)
    return st


@pytest.fixture
def client(store, monkeypatch):
    """/me and the admin plan update, over the in memory catalog."""
    from dataclasses import replace

    monkeypatch.setattr(settings, "admin_api_secret", TOKEN)

    class Svc:
        def __init__(self, _session):
            pass

        async def get_active_subscription(self, _user_id):
            return None

    monkeypatch.setattr(subs_module, "PaymentService", Svc)

    async def free_plan_key(_session):
        return store.user_plan

    monkeypatch.setattr(plan_catalog, "free_plan_key", free_plan_key)

    class FakePlan:
        def __init__(self, row: PlanRow):
            self.row = row
            self.max_recording_seconds = row.max_recording_seconds

    class SettingRow:
        """A stored plan_settings row: writing its value writes the store."""

        def __init__(self, key):
            self.key = key
            self.updated_at = None

        @property
        def value(self):
            return store.settings[self.key]

        @value.setter
        def value(self, new):
            store.settings[self.key] = new

    class Session:
        async def get(self, model, key):
            if model.__name__ == "Plan" and key in store.plans:
                return FakePlan(store.plans[key])
            if model.__name__ == "PlanSetting" and key in store.settings:
                return SettingRow(key)
            return None

        def add(self, obj):
            store.settings[obj.key] = obj.value

        async def commit(self):
            return None

        async def refresh(self, _obj):
            return None

        async def execute(self, *_a, **_k):
            raise AssertionError("not used")

    session = Session()

    async def get_session_override():
        yield session

    async def update_plan(key, body, session=None):  # mirrors admin_update_plan's write
        changes = body.model_dump(exclude_unset=True)
        if "max_recording_seconds" in changes:
            store.plans[key] = replace(
                store.plans[key], max_recording_seconds=changes["max_recording_seconds"]
            )
        plan_catalog.invalidate()
        return {"ok": True}

    app = FastAPI()
    app.include_router(subs_module.router)

    @app.put("/test/plans/{key}")
    async def _put(key: str, body: admin_module.PlanUpdate):
        return await update_plan(key, body)

    app.include_router(admin_module.router)
    app.dependency_overrides[get_session] = get_session_override
    app.dependency_overrides[get_current_user_id] = lambda: "42"
    with TestClient(app) as c:
        yield c


def me(client) -> dict:
    r = client.get("/payments/subscriptions/me")
    assert r.status_code == 200, r.text
    return r.json()["data"]


# ── Case 1: no limit and everything open (today) ───────────────────

def test_today_no_limit_and_recording_open_for_every_plan(client, store):
    for key in ("connect_free", "record", "record_pro"):
        store.user_plan = key
        data = me(client)
        assert data["maxRecordingSeconds"] is None
        assert {"record_upload", "advanced_production"} <= set(data["entitlements"])
    paywall = client.get("/payments/subscriptions/paywall").json()["data"]
    assert paywall["recordingRequiresPlan"] is False


# ── Case 2: a limit set on Record ─────────────────────────────────

def test_a_cap_on_record_reaches_me_and_pro_stays_free(client, store):
    from dataclasses import replace

    store.plans["record"] = replace(store.plans["record"], max_recording_seconds=180)
    store.user_plan = "record"
    assert me(client)["maxRecordingSeconds"] == 180
    store.user_plan = "record_pro"
    assert me(client)["maxRecordingSeconds"] is None


# ── Case 3: the value changed from the admin dashboard ────────────

def test_changing_the_value_from_the_panel_changes_me(client, store):
    store.user_plan = "record"
    assert client.put("/test/plans/record", json={"maxRecordingSeconds": 240}).status_code == 200
    assert me(client)["maxRecordingSeconds"] == 240
    assert client.put("/test/plans/record", json={"maxRecordingSeconds": 0}).status_code == 200
    assert me(client)["maxRecordingSeconds"] is None


def test_the_switch_requires_the_plan_again_and_back(client, store):
    headers = {"X-Admin-Token": TOKEN}
    store.user_plan = "record"
    r = client.put(
        "/api/v1/admin/plans/settings", json={"requirePaidPlanToRecord": True}, headers=headers
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["settings"] == {"requirePaidPlanToRecord": True}
    assert "advanced_production" not in me(client)["entitlements"]
    assert "record_upload" in me(client)["entitlements"]
    paywall = client.get("/payments/subscriptions/paywall").json()["data"]
    assert paywall["recordingRequiresPlan"] is True
    client.put(
        "/api/v1/admin/plans/settings", json={"requirePaidPlanToRecord": False}, headers=headers
    )
    assert "advanced_production" in me(client)["entitlements"]


def test_settings_route_needs_the_admin_token(client):
    r = client.put("/api/v1/admin/plans/settings", json={"requirePaidPlanToRecord": True})
    assert r.status_code == 401


# ── Pure pieces ───────────────────────────────────────────────────

def test_switch_reads_off_by_default_and_ignores_garbage():
    assert setting_flag({}, "x") is False
    assert setting_flag({"x": {"enabled": True}}, "x") is True
    assert setting_flag({"x": {"enabled": "yes"}}, "x") is False


def test_open_recording_adds_only_recording_and_editing():
    assert with_open_recording(BASE, False) == BASE | {"record_upload", "advanced_production"}
    assert with_open_recording(BASE, True) == BASE


def test_settings_body_rejects_unknown_fields():
    with pytest.raises(ValueError):
        PlanSettingsBody.model_validate({"teleport": True})
