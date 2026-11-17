use bson::oid::ObjectId;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};

/// Flexible datetime deserializer — accepts both BSON Date (documents written
/// by this service) and ISO strings (documents seeded from the Mongo shell).
/// Mirrors `app_icon::flexible_datetime`.
fn flexible_datetime<'de, D>(deserializer: D) -> Result<DateTime<Utc>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum FlexDate {
        BsonDate(bson::DateTime),
        ChronoDate(DateTime<Utc>),
    }

    match FlexDate::deserialize(deserializer)? {
        FlexDate::BsonDate(bd) => Ok(bd.to_chrono()),
        FlexDate::ChronoDate(cd) => Ok(cd),
    }
}

/// The single, admin-settable MAIN app logo — the wordmark shown at the top of
/// the mobile feed header.
///
/// Unlike `AppIcon` (a bundled-bitmap catalogue keyed by binary slot), the main
/// logo is served as a live URL: changing it here updates the header on the
/// next app refresh, no rebuild required. Stored as ONE document pinned to the
/// fixed singleton `key: "main"` (a unique index enforces the singleton) in the
/// `app_logo` collection inside `atto_content`.
///
/// Minimal seed document:
/// ```json
/// {
///   "key": "main",
///   "image_url": "https://res.cloudinary.com/.../atto/app-logo/main.png",
///   "created_at": { "$date": "2026-09-11T00:00:00Z" },
///   "updated_at": { "$date": "2026-09-11T00:00:00Z" }
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppLogo {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    /// Fixed singleton key ("main"). Unique per collection.
    pub key: String,

    /// Public URL of the logo image (a transparent-PNG wordmark on Cloudinary).
    pub image_url: String,

    /// Minimum app BUILD number that should receive `image_url`. `None` = every
    /// version-aware client (see the handler: a client only receives a logo at
    /// all when it sends `appBuild`, which older gate-less builds never do, so
    /// they can never double-draw a baked-in wordmark). When set, clients below
    /// this build get `fallback_image_url` instead.
    #[serde(default)]
    pub min_version: Option<i32>,

    /// What clients below `min_version` (or, defensively, any client we choose
    /// not to serve the primary to) should show. `None` = nothing, so the app
    /// falls back to its bundled default (today's look).
    #[serde(default)]
    pub fallback_image_url: Option<String>,

    #[serde(deserialize_with = "flexible_datetime")]
    pub created_at: DateTime<Utc>,

    #[serde(deserialize_with = "flexible_datetime")]
    pub updated_at: DateTime<Utc>,
}
