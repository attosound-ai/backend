use bson::doc;
use futures::TryStreamExt;
use mongodb::{Collection, Database};

use crate::models::ChatWallpaper;

/// Read-only repository for chat wallpapers. Writes happen out-of-band
/// (admin inserts documents in Mongo directly), so no insert/update/delete
/// methods are exposed here — scope is intentionally small.
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
}
