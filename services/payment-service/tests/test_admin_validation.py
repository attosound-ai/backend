"""Pydantic validation of admin plan payloads."""

import pytest
from pydantic import ValidationError

from app.routers.admin import EntitlementsBody, PlanCreate, PlanUpdate


def _valid(**overrides):
    body = {"key": "starter_monthly", "name": "Starter", "priceCents": 999, "billingPeriod": "month"}
    body.update(overrides)
    return body


def test_valid_create_uses_camel_case_and_defaults():
    plan = PlanCreate.model_validate(_valid(entitlements=["listen", "listen", "record_upload"]))
    assert plan.key == "starter_monthly"
    assert plan.price_cents == 999
    assert plan.currency == "USD"
    assert plan.active is True
    assert plan.entitlements == ["listen", "record_upload"]


@pytest.mark.parametrize("bad_key", ["Bad Key", "x", "UPPER", "with-dash", "1starts", "a" * 65, ""])
def test_key_must_be_lowercase_snake_2_to_64(bad_key):
    with pytest.raises(ValidationError):
        PlanCreate.model_validate(_valid(key=bad_key))


def test_unknown_entitlement_rejected():
    with pytest.raises(ValidationError) as exc:
        PlanCreate.model_validate(_valid(entitlements=["listen", "teleport"]))
    assert "teleport" in str(exc.value)


def test_bad_billing_period_rejected():
    with pytest.raises(ValidationError):
        PlanCreate.model_validate(_valid(billingPeriod="weekly"))


def test_negative_price_rejected():
    with pytest.raises(ValidationError):
        PlanCreate.model_validate(_valid(priceCents=-1))


def test_currency_is_upper_cased_and_three_letters():
    assert PlanCreate.model_validate(_valid(currency="eur")).currency == "EUR"
    with pytest.raises(ValidationError):
        PlanCreate.model_validate(_valid(currency="EURO"))


def test_unknown_fields_rejected():
    with pytest.raises(ValidationError):
        PlanCreate.model_validate(_valid(subscribers=5))


def test_update_is_partial_and_ignores_key():
    upd = PlanUpdate.model_validate({"priceCents": 1299})
    assert upd.model_dump(exclude_unset=True) == {"price_cents": 1299}
    with pytest.raises(ValidationError):
        PlanUpdate.model_validate({"key": "other"})


def test_entitlements_body_validates_keys():
    assert EntitlementsBody.model_validate({"entitlements": ["comment", "listen"]}).entitlements == ["comment", "listen"]
    with pytest.raises(ValidationError):
        EntitlementsBody.model_validate({"entitlements": ["nope"]})
