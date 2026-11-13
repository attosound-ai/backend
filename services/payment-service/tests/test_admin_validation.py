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


def test_recording_cap_is_optional_and_camel_case():
    assert PlanCreate.model_validate(_valid()).max_recording_seconds is None
    plan = PlanCreate.model_validate(_valid(maxRecordingSeconds=180))
    assert plan.max_recording_seconds == 180


def test_zero_cap_means_no_limit():
    assert PlanCreate.model_validate(_valid(maxRecordingSeconds=0)).max_recording_seconds is None
    zero = PlanUpdate.model_validate({"maxRecordingSeconds": 0})
    assert zero.model_dump(exclude_unset=True) == {"max_recording_seconds": None}


@pytest.mark.parametrize("bad", [-1, -5, 24 * 60 * 60 + 1])
def test_recording_cap_must_be_positive_and_at_most_a_day(bad):
    with pytest.raises(ValidationError):
        PlanCreate.model_validate(_valid(maxRecordingSeconds=bad))
    with pytest.raises(ValidationError):
        PlanUpdate.model_validate({"maxRecordingSeconds": bad})


def test_update_null_cap_clears_it_and_missing_cap_keeps_it():
    cleared = PlanUpdate.model_validate({"maxRecordingSeconds": None})
    assert cleared.model_dump(exclude_unset=True) == {"max_recording_seconds": None}
    untouched = PlanUpdate.model_validate({"name": "Record"})
    assert "max_recording_seconds" not in untouched.model_dump(exclude_unset=True)
