"""Entitlement enum, entitlement catalog and the plan seed.

The runtime source of truth for plans is the database (see
app/plan_catalog.py). This module keeps three things:

* the Entitlement enum, the closed list of feature keys the apps understand,
* ENTITLEMENT_CATALOG, labels the admin UI shows next to each key,
* the SEED_* tables used to fill the plans table on first boot.

The sync helpers at the bottom only look at the seed. They exist for tests
and for code paths that cannot reach the database.
"""

import enum


class Entitlement(str, enum.Enum):
    BROWSE_SEARCH = "browse_search"
    LISTEN = "listen"
    COMMENT = "comment"
    RECORD_UPLOAD = "record_upload"
    ADVANCED_PRODUCTION = "advanced_production"
    AI_AVATARS = "ai_avatars"
    ENHANCED_ANALYTICS = "enhanced_analytics"
    PRIORITY_DISCOVERY = "priority_discovery"
    TALENT_DASHBOARD = "talent_dashboard"
    EXPORTABLE_REPORTS = "exportable_reports"
    EARLY_ACCESS = "early_access"
    BRIDGE_NUMBER = "bridge_number"


ENTITLEMENT_KEYS: frozenset[str] = frozenset(e.value for e in Entitlement)

# Plain labels for the admin UI. Order matters, it is the display order.
ENTITLEMENT_CATALOG: list[dict[str, str]] = [
    {"key": "browse_search", "label": "Browse and search", "description": "Discover creators and recordings."},
    {"key": "listen", "label": "Listen", "description": "Play recordings and mixes."},
    {"key": "comment", "label": "Comment", "description": "Comment on and engage with content."},
    {"key": "record_upload", "label": "Record and upload", "description": "Record calls and upload content."},
    {"key": "advanced_production", "label": "Advanced production", "description": "Multitrack mixing and production tools."},
    {"key": "ai_avatars", "label": "AI avatars", "description": "Generate short AI avatar videos."},
    {"key": "enhanced_analytics", "label": "Enhanced analytics", "description": "Detailed listener and engagement analytics."},
    {"key": "priority_discovery", "label": "Priority discovery", "description": "Boosted placement in discovery feeds."},
    {"key": "talent_dashboard", "label": "Talent dashboard", "description": "Talent analytics and discovery dashboard."},
    {"key": "exportable_reports", "label": "Exportable reports", "description": "Download data reports."},
    {"key": "early_access", "label": "Early access", "description": "Early access to emerging talent."},
    {"key": "bridge_number", "label": "Bridge phone number", "description": "A dedicated phone number that records calls."},
]

# ── Seed tables (first boot only) ──────────────────────────────────

SEED_PLAN_ENTITLEMENTS: dict[str, frozenset[Entitlement]] = {
    "connect_free": frozenset(
        {Entitlement.BROWSE_SEARCH, Entitlement.LISTEN, Entitlement.COMMENT}
    ),
    "record": frozenset(
        {
            Entitlement.BROWSE_SEARCH,
            Entitlement.LISTEN,
            Entitlement.COMMENT,
            Entitlement.RECORD_UPLOAD,
            Entitlement.BRIDGE_NUMBER,
        }
    ),
    "record_pro": frozenset(
        {
            Entitlement.BROWSE_SEARCH,
            Entitlement.LISTEN,
            Entitlement.COMMENT,
            Entitlement.RECORD_UPLOAD,
            Entitlement.ADVANCED_PRODUCTION,
            Entitlement.AI_AVATARS,
            Entitlement.ENHANCED_ANALYTICS,
            Entitlement.PRIORITY_DISCOVERY,
            Entitlement.BRIDGE_NUMBER,
        }
    ),
    "connect_pro": frozenset(
        {
            Entitlement.BROWSE_SEARCH,
            Entitlement.LISTEN,
            Entitlement.COMMENT,
            Entitlement.RECORD_UPLOAD,
            Entitlement.ENHANCED_ANALYTICS,
            Entitlement.TALENT_DASHBOARD,
            Entitlement.EXPORTABLE_REPORTS,
            Entitlement.EARLY_ACCESS,
            Entitlement.BRIDGE_NUMBER,
        }
    ),
}

# Price in cents. A higher price is a valid upgrade target.
SEED_PLAN_PRICES_CENTS: dict[str, int] = {
    "connect_free": 0,
    "record": 9900,
    "record_pro": 13900,
    "connect_pro": 199900,
}

SEED_PLAN_DISPLAY_NAMES: dict[str, str] = {
    "connect_free": "Connect",
    "record": "Record",
    "record_pro": "Record Pro",
    "connect_pro": "Connect Pro",
}

SEED_PLAN_FEATURES: dict[str, list[str]] = {
    "connect_free": [
        "Search and discover creators",
        "Listen to recordings",
        "Comment and engage with content",
        "Community browsing",
    ],
    "record": [
        "Record and upload content",
        "Create a profile",
        "Community engagement",
        "Bridge phone number",
    ],
    "record_pro": [
        "Advanced production suite",
        "AI avatar videos (4 to 10 sec)",
        "Unlimited recordings",
        "Enhanced analytics",
        "Priority discovery algorithm",
        "Bridge phone number",
    ],
    "connect_pro": [
        "Talent analytics and discovery dashboard",
        "Top emerging creators highlighted",
        "Engagement and demographic insights",
        "Trending voices and breakout creators",
        "Exportable data reports",
        "Early access to emerging talent",
        "Bridge phone number",
    ],
}

# Billing metadata per seed plan: (billing_period, duration_days, popular, sort_order).
SEED_PLAN_BILLING: dict[str, tuple[str, int, bool, int]] = {
    "connect_free": ("forever", 36500, False, 0),
    "record": ("year", 365, False, 1),
    "record_pro": ("year", 365, True, 2),
    "connect_pro": ("year", 365, False, 3),
}

SEED_FREE_PLAN_KEY = "connect_free"

# Backwards compatible aliases for older imports.
PLAN_ENTITLEMENTS = SEED_PLAN_ENTITLEMENTS
PLAN_PRICES_ORDER = SEED_PLAN_PRICES_CENTS
PLAN_DISPLAY_NAMES = SEED_PLAN_DISPLAY_NAMES
PLAN_FEATURES = SEED_PLAN_FEATURES


# ── Sync helpers over the seed ─────────────────────────────────────

def get_entitlements(plan: str) -> frozenset[Entitlement]:
    """Seed entitlements for a plan, defaulting to the free plan."""
    return SEED_PLAN_ENTITLEMENTS.get(plan, SEED_PLAN_ENTITLEMENTS[SEED_FREE_PLAN_KEY])


def has_entitlement(plan: str, entitlement: Entitlement) -> bool:
    """Check whether a seed plan includes an entitlement."""
    return entitlement in get_entitlements(plan)


def can_upgrade(current: str, target: str) -> bool:
    """True when the target seed plan costs more than the current one."""
    return SEED_PLAN_PRICES_CENTS.get(target, 0) > SEED_PLAN_PRICES_CENTS.get(current, 0)
