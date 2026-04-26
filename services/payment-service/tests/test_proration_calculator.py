"""Tests for proration_calculator.

These are pure-function tests — no DB, no Stripe, no async. Ground-truth
math for upgrade prorating and downgrade scheduling.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.services.proration_calculator import (
    PLAN_PRICE_USD,
    calculate_upgrade_charge_cents,
    classify,
    days_remaining,
    preview,
)


# ── classify() ─────────────────────────────────────────────────────────


def test_classify_same_plan_returns_same():
    assert classify("record", "record") == "same"


def test_classify_higher_tier_is_upgrade():
    assert classify("connect_free", "record") == "upgrade"
    assert classify("record", "record_pro") == "upgrade"
    assert classify("record_pro", "connect_pro") == "upgrade"


def test_classify_lower_tier_is_downgrade():
    assert classify("record_pro", "record") == "downgrade"
    assert classify("connect_pro", "record_pro") == "downgrade"
    assert classify("record", "connect_free") == "downgrade"


def test_classify_unknown_plan_treated_as_free():
    # Unknown plans rank as 0 — same as connect_free.
    assert classify("nonexistent", "record") == "upgrade"


# ── days_remaining() ───────────────────────────────────────────────────


def test_days_remaining_full_year():
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    expires = now + timedelta(days=365)
    assert days_remaining(expires, now) == 365


def test_days_remaining_half_year():
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    expires = now + timedelta(days=180)
    assert days_remaining(expires, now) == 180


def test_days_remaining_clamped_to_zero_when_expired():
    now = datetime(2026, 6, 1, tzinfo=timezone.utc)
    expires = now - timedelta(days=10)
    assert days_remaining(expires, now) == 0


def test_days_remaining_clamped_to_365_when_far_future():
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    expires = now + timedelta(days=400)
    assert days_remaining(expires, now) == 365


# ── calculate_upgrade_charge_cents() ───────────────────────────────────


def test_upgrade_charge_record_to_record_pro_full_year():
    """Full $40 differential ($139 - $99) when upgrading on day one."""
    cents = calculate_upgrade_charge_cents("record", "record_pro", 365)
    assert cents == 4000


def test_upgrade_charge_record_to_record_pro_half_year():
    """Half the differential when half the year is left."""
    cents = calculate_upgrade_charge_cents("record", "record_pro", 182)
    # ($139 - $99) * 182/365 * 100 = $19.94... → 1995 cents (rounded)
    assert cents == 1995


def test_upgrade_charge_record_to_record_pro_one_day_left():
    """Almost zero when subscription is about to expire."""
    cents = calculate_upgrade_charge_cents("record", "record_pro", 1)
    # $40 * 1/365 * 100 = $0.1095... → 11 cents
    assert cents == 11


def test_upgrade_charge_zero_when_no_days_left():
    cents = calculate_upgrade_charge_cents("record", "record_pro", 0)
    assert cents == 0


def test_upgrade_charge_zero_for_same_plan():
    cents = calculate_upgrade_charge_cents("record", "record", 365)
    assert cents == 0


def test_upgrade_charge_zero_when_target_cheaper():
    """Defensive: if classifier mislabels, the math still doesn't charge."""
    cents = calculate_upgrade_charge_cents("record_pro", "record", 100)
    assert cents == 0


def test_upgrade_charge_free_to_record():
    cents = calculate_upgrade_charge_cents("connect_free", "record", 365)
    assert cents == 9900


def test_upgrade_charge_record_to_connect_pro():
    """The big jump — $1999 - $99 = $1900 differential."""
    cents = calculate_upgrade_charge_cents("record", "connect_pro", 365)
    assert cents == 190000  # $1900.00


def test_upgrade_charge_round_half_up():
    """Verify rounding: $40 * 273/365 * 100 = $29.917... → 2992."""
    cents = calculate_upgrade_charge_cents("record", "record_pro", 273)
    assert cents == 2992


# ── preview() — full snapshots ─────────────────────────────────────────


def test_preview_upgrade_returns_immediate_charge_and_now_applies_at():
    now = datetime(2026, 4, 26, 12, 0, tzinfo=timezone.utc)
    expires = datetime(2026, 12, 31, tzinfo=timezone.utc)
    p = preview("record", "record_pro", expires, now)

    assert p.direction == "upgrade"
    assert p.current_plan == "record"
    assert p.target_plan == "record_pro"
    assert p.amount_due_cents > 0
    # applies_at == now for upgrades
    assert p.applies_at == now
    # 249 days from Apr 26 to Dec 31
    assert 248 <= p.days_remaining <= 250


def test_preview_downgrade_returns_zero_charge_and_period_end_applies_at():
    now = datetime(2026, 4, 26, tzinfo=timezone.utc)
    expires = datetime(2026, 12, 31, tzinfo=timezone.utc)
    p = preview("record_pro", "record", expires, now)

    assert p.direction == "downgrade"
    assert p.amount_due_cents == 0
    # applies_at == expires_at (end of current period)
    assert p.applies_at == expires


def test_preview_same_plan_is_noop():
    now = datetime(2026, 4, 26, tzinfo=timezone.utc)
    expires = now + timedelta(days=200)
    p = preview("record", "record", expires, now)

    assert p.direction == "same"
    assert p.amount_due_cents == 0


def test_preview_upgrade_from_free_charges_full_remaining():
    """A free user upgrading mid-year still gets prorated.

    The free plan duration is effectively 100 years, so days_remaining is
    capped at 365 — the user pays for one year forward.
    """
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    expires = now + timedelta(days=36500)  # free plan ~100 years
    p = preview("connect_free", "record", expires, now)

    assert p.direction == "upgrade"
    assert p.amount_due_cents == 9900  # full $99
    assert p.days_remaining == 365


# ── parametrized table for quick scanning ─────────────────────────────


@pytest.mark.parametrize(
    "current,target,days,expected_cents",
    [
        ("record", "record_pro", 365, 4000),       # full year diff
        ("record", "record_pro", 273, 2992),       # ~3/4 year
        ("record", "record_pro", 182, 1995),       # half year
        ("record", "record_pro", 91, 997),         # ~1/4 year ($40*91/365*100=997.26→997)
        ("record", "record_pro", 30, 329),         # one month left
        ("record", "record_pro", 7, 77),           # one week
        ("record", "record_pro", 0, 0),            # expired
        ("record_pro", "connect_pro", 365, 186000),  # big jump
        ("connect_free", "record", 365, 9900),     # free → paid
        ("connect_free", "record_pro", 365, 13900), # free → top
    ],
)
def test_upgrade_charge_table(
    current: str, target: str, days: int, expected_cents: int
):
    assert calculate_upgrade_charge_cents(current, target, days) == expected_cents


# ── invariants ─────────────────────────────────────────────────────────


def test_invariant_charge_never_exceeds_full_year_diff():
    """For upgrade pairs, the charge can't exceed (target - current) * 100."""
    for current in ["connect_free", "record", "record_pro"]:
        for target in ["record", "record_pro", "connect_pro"]:
            if PLAN_PRICE_USD[target] <= PLAN_PRICE_USD[current]:
                continue  # only check upgrade pairs
            max_diff_cents = int((PLAN_PRICE_USD[target] - PLAN_PRICE_USD[current]) * 100)
            for days in [0, 1, 30, 100, 200, 365]:
                cents = calculate_upgrade_charge_cents(current, target, days)
                assert cents <= max_diff_cents, (
                    f"{current}→{target} {days}d: {cents} > {max_diff_cents}"
                )


def test_invariant_charge_monotonic_in_days():
    """More days remaining → never less charge."""
    last = -1
    for days in [0, 30, 90, 180, 270, 365]:
        cents = calculate_upgrade_charge_cents("record", "record_pro", days)
        assert cents >= last, f"non-monotonic at days={days}: {cents} < {last}"
        last = cents


def test_invariant_downgrade_never_charges():
    """Downgrades always show $0 in preview, regardless of days remaining."""
    for days in [0, 50, 200, 365]:
        now = datetime(2026, 4, 26, tzinfo=timezone.utc)
        expires = now + timedelta(days=days)
        p = preview("record_pro", "record", expires, now)
        assert p.direction == "downgrade"
        assert p.amount_due_cents == 0
