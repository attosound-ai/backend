"""Pure tests: which Stripe keys mean the reported money is real."""

import pytest

from app.billing_mode import stripe_mode


@pytest.mark.parametrize(
    "key",
    ["sk_live_51Abc", "rk_live_51Abc", "  sk_live_51Abc  "],
)
def test_live_keys_report_real_money(key: str) -> None:
    assert stripe_mode(key) == "live"


@pytest.mark.parametrize("key", ["sk_test_51Abc", "rk_test_51Abc"])
def test_test_keys_are_not_real_money(key: str) -> None:
    assert stripe_mode(key) == "test"


@pytest.mark.parametrize("key", ["", None, "   ", "pk_live_51Abc", "whsec_123", "sk_liveX"])
def test_anything_else_is_unconfigured(key: str | None) -> None:
    # A publishable key or a webhook secret in the wrong variable must never
    # read as "live": the panel would then present test figures as income.
    assert stripe_mode(key) == "unconfigured"
