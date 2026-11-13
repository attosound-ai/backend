use bson::{doc, oid::ObjectId};
use chrono::Utc;
use futures::TryStreamExt;
use mongodb::{Collection, Database};

use crate::models::ChatWallpaper;

/// Repository for chat wallpapers. Reads serve the app; writes come from the
/// admin dashboard (atto-web) through the admin endpoints.
#[derive(Clone)]
pub struct ChatWallpaperRepository {
    collection: Collection<ChatWallpaper>,
}

impl ChatWallpaperRepository {
    pub fn new(db: &Database) -> Self {
        Self {
            collection: db.collection::<ChatWallpaper>("chat_wallpapers"),
        }
    }

    /// Return every wallpaper marked `is_active=true`, ordered by
    /// `sort_order` ascending then `created_at` ascending. The client
    /// renders them in this order inside the picker grid.
    pub async fn list_active(&self) -> Result<Vec<ChatWallpaper>, mongodb::error::Error> {
        let filter = doc! { "is_active": true };
        let options = mongodb::options::FindOptions::builder()
            .sort(doc! { "sort_order": 1, "created_at": 1 })
            .limit(100)
            .build();
        let cursor = self.collection.find(filter, options).await?;
        cursor.try_collect().await
    }

    /// Every wallpaper, active or not, for the admin dashboard.
    pub async fn list_all(&self) -> Result<Vec<ChatWallpaper>, mongodb::error::Error> {
        let options = mongodb::options::FindOptions::builder()
            .sort(doc! { "sort_order": 1, "created_at": 1 })
            .limit(200)
            .build();
        let cursor = self.collection.find(doc! {}, options).await?;
        cursor.try_collect().await
    }

    /// Insert a new wallpaper and return it with its id.
    pub async fn insert(
        &self,
        mut wallpaper: ChatWallpaper,
    ) -> Result<ChatWallpaper, mongodb::error::Error> {
        let now = Utc::now();
        wallpaper.id = None;
        wallpaper.created_at = now;
        wallpaper.updated_at = now;
        let result = self.collection.insert_one(&wallpaper, None).await?;
        wallpaper.id = result.inserted_id.as_object_id();
        Ok(wallpaper)
    }

    /// Flip `is_active` without deleting the row. Returns the matched count.
    pub async fn set_active(&self, id: &str, is_active: bool) -> Result<u64, mongodb::error::Error> {
        let object_id = match ObjectId::parse_str(id) {
            Ok(oid) => oid,
            Err(_) => return Ok(0),
        };
        let result = self
            .collection
            .update_one(
                doc! { "_id": object_id },
                doc! { "$set": {
                    "is_active": is_active,
                    "updated_at": bson::DateTime::from_chrono(Utc::now()),
                } },
                None,
            )
            .await?;
        Ok(result.matched_count)
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
