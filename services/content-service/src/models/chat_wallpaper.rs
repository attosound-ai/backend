use bson::oid::ObjectId;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};

/// Flexible datetime deserializer — documents seeded via the Mongo shell
/// may store timestamps as ISO strings; documents inserted by this service
/// store them as BSON Date. This accepts both.
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

/// A chat wallpaper record.
///
/// Wallpapers are managed entirely via MongoDB — the admin inserts, updates
/// or disables rows directly. No admin UI or upload endpoint exists yet
/// (keeps this change small). The client fetches only `is_active=true` rows
/// and renders them as a tileable `ImageBackground` in `ChatScreen`.
///
/// Expected collection: `chat_wallpapers` inside the `atto_content` database.
/// Minimal seed document:
///
/// ```json
/// {
///   "name": "ATTO Pattern",
///   "image_url": "https://res.cloudinary.com/.../atto-tile.png",
///   "thumbnail_url": "https://res.cloudinary.com/.../atto-tile-thumb.png",
///   "tint_color": "#000000",
///   "overlay_opacity": 0.7,
///   "is_active": true,
///   "sort_order": 0,
///   "created_at": { "$date": "2026-04-14T00:00:00Z" },
///   "updated_at": { "$date": "2026-04-14T00:00:00Z" }
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatWallpaper {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    /// Human-readable name shown in the picker (e.g. "ATTO Pattern").
    pub name: String,

    /// Public URL of the tileable image. MUST have matching edges so
    /// `resizeMode="repeat"` looks seamless.
    pub image_url: String,

    /// Optional smaller preview URL used inside the picker grid.
    /// Falls back to `image_url` on the client when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,

    /// Optional HEX tint applied under the tile (useful when the tile has
    /// transparency). Defaults to black on the client when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint_color: Option<String>,

    /// Opacity of the dark overlay rendered on top of the wallpaper so
    /// chat bubbles stay legible. Range 0.0 – 1.0. Defaults to 0.7 client-side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlay_opacity: Option<f32>,

    /// Only active wallpapers are returned to the client. Flip to `false`
    /// in Mongo to retire a wallpaper without deleting the row.
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
