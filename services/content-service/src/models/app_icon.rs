use bson::oid::ObjectId;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};

/// Flexible datetime deserializer — accepts both BSON Date (documents
/// written by this service) and ISO strings (documents seeded manually
/// from the Mongo shell). Mirrors `chat_wallpaper::flexible_datetime`.
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

/// A dynamic app-icon catalog record.
///
/// `slot_name` is the contract between this document and the mobile binary:
/// it MUST exactly match a key declared in the mobile app's
/// `@howincodes/expo-dynamic-app-icon` plugin block in `app.json`. The
/// admin web uploads the user-facing metadata (display `name`, `preview_url`,
/// `sort_order`, `is_active`) — the actual home-screen bitmap is bundled in
/// the binary, not on the server. Adding a new icon to the picker therefore
/// requires both a new admin row AND a new mobile build.
///
/// Expected collection: `app_icons` inside the `atto_content` database.
/// Minimal seed document:
///
/// ```json
/// {
///   "slot_name": "noir",
///   "name": "Noir",
///   "preview_url": "https://res.cloudinary.com/.../atto/app-icons/noir.png",
///   "is_active": true,
///   "sort_order": 0,
///   "created_at": { "$date": "2026-05-20T00:00:00Z" },
///   "updated_at": { "$date": "2026-05-20T00:00:00Z" }
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppIcon {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    /// Slot identifier as declared in the mobile binary. Unique per
    /// collection (enforced via a unique index created at startup).
    pub slot_name: String,

    /// Human-readable display name shown under the tile in the picker.
    pub name: String,

    /// Public URL of the preview thumbnail. Typically 256×256 PNG/WebP
    /// served from Cloudinary under `atto/app-icons/`.
    pub preview_url: String,

    /// Only active icons are returned to the mobile client. Flip to
    /// `false` to retire a slot without deleting the row (e.g., while the
    /// matching binary build is still rolling out / being rolled back).
    #[serde(default = "default_true")]
    pub is_active: bool,

    /// Display order in the picker (lower first). Ties break by `created_at`.
    #[serde(default)]
    pub sort_order: i32,

    #[serde(deserialize_with = "flexible_datetime")]
    pub created_at: DateTime<Utc>,

    #[serde(deserialize_with = "flexible_datetime")]
    pub updated_at: DateTime<Utc>,
}

fn default_true() -> bool {
    true
}
