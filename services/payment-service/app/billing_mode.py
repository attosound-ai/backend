"""Whether the money this service reports is real.

The operator panel shows revenue, MRR and ARR. With a Stripe TEST key every
payment behind those figures was made with a test card and moved no money, and
the panel has to say so instead of presenting them as income (owner, Oct 6
2026: the panel "should show real data").
"""

from typing import Literal

StripeMode = Literal["live", "test", "unconfigured"]


def stripe_mode(secret_key: str | None) -> StripeMode:
    """`live` only for a live secret or restricted key; anything else is not real money."""
    key = (secret_key or "").strip()
    if key.startswith(("sk_live_", "rk_live_")):
        return "live"
    if key.startswith(("sk_test_", "rk_test_")):
        return "test"
    return "unconfigured"
