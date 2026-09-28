"""Pure function tests for the plan catalog paywall logic.

No database: the helpers take PlanRow snapshots directly.
"""

from app.plan_catalog import (
    PlanRow,
    compute_paid_features,
    compute_paywall_required,
    pick_free_plan,
)


def row(key: str, price: int, ents: set[str], active: bool = True, sort: int = 0) -> PlanRow:
    return PlanRow(
        key=key,
        name=key.title(),
        description=None,
        price_cents=price,
        currency="USD",
        billing_period="forever" if price == 0 else "year",
        duration_days=36500 if price == 0 else 365,
        stripe_price_id=None,
        popular=False,
        active=active,
        sort_order=sort,
        features=(),
        entitlements=frozenset(ents),
    )


BASE = {"browse_search", "listen", "comment"}


def test_no_paid_features_when_free_plan_has_everything():
    rows = [
        row("free", 0, BASE | {"record_upload", "bridge_number"}),
        row("paid", 9900, BASE | {"record_upload", "bridge_number"}, sort=1),
    ]
    assert compute_paid_features(rows) == []
    assert compute_paywall_required(rows) is False


def test_paid_features_when_paid_plan_has_extras():
    rows = [
        row("free", 0, BASE),
        row("record", 9900, BASE | {"record_upload", "bridge_number"}, sort=1),
        row("pro", 13900, BASE | {"record_upload", "ai_avatars"}, sort=2),
    ]
    assert compute_paid_features(rows) == ["ai_avatars", "bridge_number", "record_upload"]
    assert compute_paywall_required(rows) is True


def test_inactive_plans_are_ignored():
    rows = [
        row("free", 0, BASE),
        row("legacy", 5000, BASE | {"talent_dashboard"}, active=False, sort=1),
    ]
    assert compute_paid_features(rows) == []
    assert compute_paywall_required(rows) is False


def test_inactive_free_plan_is_not_the_free_plan():
    rows = [
        row("old_free", 0, BASE | {"record_upload"}, active=False),
        row("free", 0, BASE, sort=5),
        row("paid", 9900, BASE | {"record_upload"}, sort=1),
    ]
    assert pick_free_plan(rows).key == "free"
    assert compute_paid_features(rows) == ["record_upload"]


def test_free_plan_is_lowest_sort_order_zero_price():
    rows = [row("free_b", 0, BASE, sort=2), row("free_a", 0, BASE, sort=1)]
    assert pick_free_plan(rows).key == "free_a"


def test_no_free_plan_means_every_paid_entitlement_is_paid():
    rows = [row("paid", 9900, BASE | {"record_upload"})]
    assert pick_free_plan(rows) is None
    assert compute_paid_features(rows) == sorted(BASE | {"record_upload"})


def test_price_dollars_formats_two_decimals():
    assert row("x", 13900, set()).price_dollars == "139.00"
    assert row("y", 0, set()).price_dollars == "0.00"
