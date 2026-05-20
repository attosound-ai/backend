use bson::{doc, oid::ObjectId};
use chrono::Utc;
use futures::TryStreamExt;
use mongodb::{
    options::{FindOptions, IndexOptions},
    Collection, Database, IndexModel,
};

use crate::models::AppIcon;

/// Repository for the dynamic app-icon catalog. Unlike `ChatWallpaperRepository`
/// (read-only — wallpapers were seeded by hand) the admin web actively writes
/// here, so we expose insert / delete / find-by-slot in addition to the
/// public listing.
#[derive(Clone)]
pub struct AppIconRepository {
    collection: Collection<AppIcon>,
}

impl AppIconRepository {
    pub fn new(db: &Database) -> Self {
        Self {
            collection: db.collection::<AppIcon>("app_icons"),
        }
    }

    /// Ensure the indexes required for safe writes (unique `slot_name`) and
    /// fast public reads (`is_active + sort_order`) exist. Called once at
    /// service startup; idempotent.
    pub async fn ensure_indexes(&self) -> Result<(), mongodb::error::Error> {
        let unique_slot = IndexModel::builder()
            .keys(doc! { "slot_name": 1 })
            .options(IndexOptions::builder().unique(true).build())
            .build();
        let active_order = IndexModel::builder()
            .keys(doc! { "is_active": 1, "sort_order": 1 })
            .build();
        self.collection
            .create_indexes(vec![unique_slot, active_order], None)
            .await?;
        Ok(())
    }

    /// Public catalogue — only active icons, ordered as they will appear
    /// in the picker.
    pub async fn list_active(&self) -> Result<Vec<AppIcon>, mongodb::error::Error> {
        let filter = doc! { "is_active": true };
        let options = FindOptions::builder()
            .sort(doc! { "sort_order": 1, "created_at": 1 })
            .limit(50)
            .build();
        let cursor = self.collection.find(filter, options).await?;
        cursor.try_collect().await
    }

    /// Admin listing — includes inactive rows so the admin UI can re-enable
    /// previously retired slots.
    pub async fn list_all(&self) -> Result<Vec<AppIcon>, mongodb::error::Error> {
        let options = FindOptions::builder()
            .sort(doc! { "sort_order": 1, "created_at": 1 })
            .limit(200)
            .build();
        let cursor = self.collection.find(doc! {}, options).await?;
        cursor.try_collect().await
    }

    /// Upsert by `slot_name`. The slot name is the binary contract — if it
    /// already exists we update the metadata in place; otherwise we insert.
    /// Returns the persisted document.
    pub async fn upsert(
        &self,
        slot_name: &str,
        name: &str,
        preview_url: &str,
        sort_order: i32,
        is_active: bool,
    ) -> Result<AppIcon, mongodb::error::Error> {
        let now = Utc::now();
        let filter = doc! { "slot_name": slot_name };
        let update = doc! {
            "$set": {
                "name": name,
                "preview_url": preview_url,
                "sort_order": sort_order,
                "is_active": is_active,
                "updated_at": bson::DateTime::from_chrono(now),
            },
            "$setOnInsert": {
                "slot_name": slot_name,
                "created_at": bson::DateTime::from_chrono(now),
            },
        };
        self.collection
            .update_one(
                filter.clone(),
                update,
                mongodb::options::UpdateOptions::builder().upsert(true).build(),
            )
            .await?;
        // Fetch the now-canonical document.
        let icon = self.collection.find_one(filter, None).await?;
        icon.ok_or_else(|| {
            mongodb::error::Error::custom("upsert returned no document".to_string())
        })
    }

    /// Delete by hex ObjectId. Returns the number of documents removed (0 or 1).
    pub async fn delete_by_id(&self, id: &str) -> Result<u64, mongodb::error::Error> {
        let object_id = match ObjectId::parse_str(id) {
            Ok(oid) => oid,
            Err(_) => return Ok(0),
        };
        let result = self
            .collection
            .delete_one(doc! { "_id": object_id }, None)
            .await?;
        Ok(result.deleted_count)
    }
}
