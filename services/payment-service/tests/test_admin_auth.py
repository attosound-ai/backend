"""Admin token gate: missing or wrong token is rejected, empty secret fails closed."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.database import get_session
from app.routers.admin import router as admin_router


class _FakeResult:
    """Enough of a SQLAlchemy result for the empty catalog case."""

    def scalars(self):
        return self

    def unique(self):
        return self

    def mappings(self):
        return self

    def all(self):
        return []

    def scalar(self):
        return 0


class _FakeSession:
    async def execute(self, *_args, **_kwargs):
        return _FakeResult()

    async def rollback(self):
        return None


async def _fake_session():
    yield _FakeSession()


@pytest.fixture
def client(monkeypatch):
    from app import plan_catalog

    plan_catalog.invalidate()
    app = FastAPI()
    app.include_router(admin_router)
    app.dependency_overrides[get_session] = _fake_session
    with TestClient(app) as c:
        yield c
    plan_catalog.invalidate()


def test_empty_secret_returns_503(client, monkeypatch):
    monkeypatch.setattr(settings, "admin_api_secret", "")
    r = client.get("/api/v1/admin/plans", headers={"X-Admin-Token": "anything"})
    assert r.status_code == 503


def test_missing_token_returns_401(client, monkeypatch):
    monkeypatch.setattr(settings, "admin_api_secret", "topsecret")
    r = client.get("/api/v1/admin/plans")
    assert r.status_code == 401


def test_wrong_token_returns_401(client, monkeypatch):
    monkeypatch.setattr(settings, "admin_api_secret", "topsecret")
    r = client.get("/api/v1/admin/metrics", headers={"X-Admin-Token": "nope"})
    assert r.status_code == 401


def test_valid_token_passes_gate(client, monkeypatch):
    monkeypatch.setattr(settings, "admin_api_secret", "topsecret")
    r = client.get("/api/v1/admin/plans", headers={"X-Admin-Token": "topsecret"})
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert body["data"]["plans"] == []
    assert len(body["data"]["entitlements"]) == 12
    assert body["data"]["paywall"]["required"] is False


def test_mutations_are_gated_too(client, monkeypatch):
    monkeypatch.setattr(settings, "admin_api_secret", "topsecret")
    assert client.post("/api/v1/admin/plans", json={}).status_code == 401
    assert client.put("/api/v1/admin/plans/record", json={}).status_code == 401
    assert client.delete("/api/v1/admin/plans/record").status_code == 401
