use bson::oid::ObjectId;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// One admin editable setting the mobile app reads at launch, keyed by name and
/// stored as free JSON, so a new setting is a new key, not a new collection.
///
/// Keys in use (Sep 23 2026):
/// * `feed_menu`    the feed header menu: item order, labels, icons, hidden.
/// * `splash_scale` the launch splash mark width as a fraction of the screen.
///
/// Served to the app inside `GET /api/v1/content/app-logo` (the one request
/// every cold launch already makes), so a change lands on the next launch or
/// refresh with no rebuild.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSetting {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    pub key: String,
    pub value: bson::Bson,
    #[serde(with = "bson::serde_helpers::chrono_datetime_as_bson_datetime")]
    pub updated_at: DateTime<Utc>,
}
