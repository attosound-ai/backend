use bson::oid::ObjectId;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

/// Deserialize a DateTime that might be stored as BSON Date or as an ISO string.
/// MongoDB documents have mixed formats depending on how they were inserted.
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Content {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    pub author_id: String,
    pub content_type: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_content: Option<String>,
    #[serde(default)]
    pub file_paths: Vec<String>,
    #[serde(default)]
    pub metadata: HashMap<String, String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(deserialize_with = "flexible_datetime")]
    pub created_at: DateTime<Utc>,
    #[serde(deserialize_with = "flexible_datetime")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateContentInput {
    pub author_id: String,
    pub content_type: String,
    #[serde(default)]
    pub title: String,
    pub text_content: Option<String>,
    #[serde(default)]
    pub file_paths: Vec<String>,
    #[serde(default)]
    pub metadata: HashMap<String, String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateContentInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, String>>,
}

/// Allowed content types
pub const VALID_CONTENT_TYPES: &[&str] = &["audio", "image", "text", "video", "reel"];

pub fn is_valid_content_type(ct: &str) -> bool {
    VALID_CONTENT_TYPES.contains(&ct)
}
