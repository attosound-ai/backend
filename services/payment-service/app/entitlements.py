"""Plan-to-entitlements mapping — single source of truth.

Pure data + pure functions, no I/O or database dependency.
Importable by any module that needs to check feature access.
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


PLAN_ENTITLEMENTS: dict[str, frozenset[Entitlement]] = {
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
            Entitlement.ENHANCED_ANALYTICS,
            Entitlement.TALENT_DASHBOARD,
            Entitlement.EXPORTABLE_REPORTS,
            Entitlement.EARLY_ACCESS,
            Entitlement.BRIDGE_NUMBER,
        }
    ),
}

# Price in cents — used for upgrade validation (higher price = valid upgrade target)
PLAN_PRICES_ORDER: dict[str, int] = {
    "connect_free": 0,
    "record": 9900,
    "record_pro": 13900,
    "connect_pro": 199900,
}

PLAN_DISPLAY_NAMES: dict[str, str] = {
    "connect_free": "Connect",
    "record": "Record",
    "record_pro": "Record Pro",
    "connect_pro": "Connect Pro",
}

PLAN_FEATURES: dict[str, list[str]] = {
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
        "AI avatar videos (4-10 sec)",
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


def get_entitlements(plan: str) -> frozenset[Entitlement]:
    """Return the entitlements for a plan, defaulting to connect_free."""
    return PLAN_ENTITLEMENTS.get(plan, PLAN_ENTITLEMENTS["connect_free"])


def has_entitlement(plan: str, entitlement: Entitlement) -> bool:
    """Check if a plan includes a specific entitlement."""
    return entitlement in get_entitlements(plan)


def can_upgrade(current: str, target: str) -> bool:
    """Return True if target plan is more expensive than current plan."""
    return PLAN_PRICES_ORDER.get(target, 0) > PLAN_PRICES_ORDER.get(current, 0)
