use actix_web::{get, web, HttpResponse};
use serde::Serialize;
use serde_json::json;

use crate::models::ChatWallpaper;
use crate::repositories::ChatWallpaperRepository;

/// Response shape sent to the client. Uses camelCase field names to match
/// the rest of the API surface consumed by the React Native app and
/// keeps the Mongo `_id` exposed as a plain hex `id` string.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatWallpaperResponse {
    id: String,
    name: String,
    image_url: String,
    thumbnail_url: Option<String>,
    tint_color: Option<String>,
    overlay_opacity: Option<f32>,
    sort_order: i32,
    created_at: String,
}

impl From<ChatWallpaper> for ChatWallpaperResponse {
    fn from(w: ChatWallpaper) -> Self {
        Self {
            id: w.id.map(|oid| oid.to_hex()).unwrap_or_default(),
            name: w.name,
            image_url: w.image_url,
            thumbnail_url: w.thumbnail_url,
            tint_color: w.tint_color,
            overlay_opacity: w.overlay_opacity,
            sort_order: w.sort_order,
            created_at: w.created_at.to_rfc3339(),
        }
    }
}

/// `GET /api/v1/content/chat-wallpapers`
///
/// Public endpoint (no JWT required) that returns every active wallpaper.
/// Clients cache the response via React Query; cache invalidation happens
/// on app focus, so adding/retiring a wallpaper in Mongo is visible to
/// users within one refresh cycle — no build required.
#[get("/api/v1/content/chat-wallpapers")]
pub async fn list_chat_wallpapers(
    repo: web::Data<ChatWallpaperRepository>,
) -> HttpResponse {
    match repo.list_active().await {
        Ok(wallpapers) => {
            let items: Vec<ChatWallpaperResponse> =
                wallpapers.into_iter().map(Into::into).collect();
            HttpResponse::Ok().json(json!({
                "success": true,
                "data": items,
                "error": null
            }))
        }
        Err(err) => {
            log::error!("Failed to list chat wallpapers: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false,
                "data": null,
                "error": "Failed to load wallpapers"
            }))
        }
    }
}
