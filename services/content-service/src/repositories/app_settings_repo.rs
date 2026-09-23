use bson::doc;
use chrono::Utc;
use mongodb::{
    options::{IndexOptions, UpdateOptions},
    Collection, Database, IndexModel,
};

use crate::models::AppSetting;

#[derive(Clone)]
pub struct AppSettingsRepository {
    collection: Collection<AppSetting>,
}

impl AppSettingsRepository {
    pub fn new(db: &Database) -> Self {
        Self {
            collection: db.collection::<AppSetting>("app_settings"),
        }
    }

    /// Unique `key` so a setting can never fork into two documents. Idempotent.
    pub async fn ensure_indexes(&self) -> Result<(), mongodb::error::Error> {
        let index = IndexModel::builder()
            .keys(doc! { "key": 1 })
            .options(IndexOptions::builder().unique(true).build())
            .build();
        self.collection.create_index(index, None).await?;
        Ok(())
    }

    pub async fn get(&self, key: &str) -> Result<Option<serde_json::Value>, mongodb::error::Error> {
        let found = self.collection.find_one(doc! { "key": key }, None).await?;
        Ok(found.map(|s| serde_json::Value::from(s.value)))
    }

    pub async fn set(
        &self,
        key: &str,
        value: serde_json::Value,
    ) -> Result<serde_json::Value, mongodb::error::Error> {
        let now = Utc::now();
        let bson_value = bson::Bson::try_from(value.clone()).map_err(|e| {
            mongodb::error::Error::custom(format!("setting {} is not valid BSON: {}", key, e))
        })?;
        let update = doc! {
            "$set": { "value": bson_value, "updated_at": bson::DateTime::from_chrono(now) },
            "$setOnInsert": { "key": key },
        };
        self.collection
            .update_one(
                doc! { "key": key },
                update,
                UpdateOptions::builder().upsert(true).build(),
            )
            .await?;
        Ok(value)
    }

    /// Returns true when a document was removed.
    pub async fn clear(&self, key: &str) -> Result<bool, mongodb::error::Error> {
        let res = self.collection.delete_one(doc! { "key": key }, None).await?;
        Ok(res.deleted_count > 0)
    }
}
