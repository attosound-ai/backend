use actix_web::{delete, get, patch, post, web, HttpRequest, HttpResponse};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::middleware::admin_auth::verify_admin_token;
use crate::models::ChatWallpaper;
use crate::repositories::ChatWallpaperRepository;

const WALLPAPER_KINDS: [&str; 3] = ["image", "gradient", "pattern"];

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
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    gradient_colors: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pattern_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pattern_opacity: Option<f32>,
    sort_order: i32,
    /// Only present on admin responses.
    #[serde(skip_serializing_if = "Option::is_none")]
    is_active: Option<bool>,
    created_at: String,
}

impl ChatWallpaperResponse {
    fn public(w: ChatWallpaper) -> Self {
        Self {
            id: w.id.map(|oid| oid.to_hex()).unwrap_or_default(),
            name: w.name,
            image_url: w.image_url,
            thumbnail_url: w.thumbnail_url,
            tint_color: w.tint_color,
            overlay_opacity: w.overlay_opacity,
            kind: w.kind.unwrap_or_else(|| "image".to_string()),
            gradient_colors: w.gradient_colors,
            pattern_url: w.pattern_url,
            pattern_opacity: w.pattern_opacity,
            sort_order: w.sort_order,
            is_active: None,
            created_at: w.created_at.to_rfc3339(),
        }
    }

    fn admin(w: ChatWallpaper) -> Self {
        let is_active = w.is_active;
        let mut response = Self::public(w);
        response.is_active = Some(is_active);
        response
    }
}

impl From<ChatWallpaper> for ChatWallpaperResponse {
    fn from(w: ChatWallpaper) -> Self {
        Self::public(w)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateChatWallpaperRequest {
    name: String,
    /// `image`, `gradient` or `pattern`. Defaults to `image`.
    #[serde(default)]
    kind: Option<String>,
    /// Required for `image`; the tile must already be hosted.
    #[serde(default)]
    image_url: Option<String>,
    #[serde(default)]
    thumbnail_url: Option<String>,
    #[serde(default)]
    tint_color: Option<String>,
    #[serde(default)]
    overlay_opacity: Option<f32>,
    /// Two to four HEX colours, required for `gradient` and `pattern`.
    #[serde(default)]
    gradient_colors: Option<Vec<String>>,
    /// Required for `pattern`; the tile must already be hosted.
    #[serde(default)]
    pattern_url: Option<String>,
    #[serde(default)]
    pattern_opacity: Option<f32>,
    #[serde(default)]
    sort_order: i32,
    #[serde(default = "default_true")]
    is_active: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetActiveRequest {
    is_active: bool,
}

fn default_true() -> bool {
    true
}

fn is_hex_color(value: &str) -> bool {
    let v = value.trim();
    (v.len() == 7 || v.len() == 9)
        && v.starts_with('#')
        && v[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn unauthorized() -> HttpResponse {
    HttpResponse::Unauthorized().json(json!({
        "success": false, "data": null, "error": "Unauthorized",
    }))
}

fn bad_request(message: &str) -> HttpResponse {
    HttpResponse::BadRequest().json(json!({
        "success": false, "data": null, "error": message,
    }))
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

// ── Admin ────────────────────────────────────────────────────────────

/// `GET /api/v1/admin/chat-wallpapers` — every wallpaper, active or not.
#[get("/api/v1/admin/chat-wallpapers")]
pub async fn admin_list_chat_wallpapers(
    req: HttpRequest,
    repo: web::Data<ChatWallpaperRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return unauthorized();
    }
    match repo.list_all().await {
        Ok(wallpapers) => {
            let items: Vec<ChatWallpaperResponse> = wallpapers
                .into_iter()
                .map(ChatWallpaperResponse::admin)
                .collect();
            HttpResponse::Ok().json(json!({ "success": true, "data": items, "error": null }))
        }
        Err(err) => {
            log::error!("Failed admin list chat wallpapers: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to load chat wallpapers",
            }))
        }
    }
}

/// `POST /api/v1/admin/chat-wallpapers` — create a wallpaper. Image and
/// pattern tiles must already be hosted (atto-web uploads them to Cloudinary
/// before calling this).
#[post("/api/v1/admin/chat-wallpapers")]
pub async fn admin_create_chat_wallpaper(
    req: HttpRequest,
    body: web::Json<CreateChatWallpaperRequest>,
    repo: web::Data<ChatWallpaperRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return unauthorized();
    }
    let payload = body.into_inner();
    let name = payload.name.trim().to_string();
    if name.is_empty() {
        return bad_request("name is required");
    }
    let kind = payload
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .unwrap_or("image")
        .to_string();
    if !WALLPAPER_KINDS.contains(&kind.as_str()) {
        return bad_request("kind must be image, gradient or pattern");
    }
    let image_url = payload
        .image_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let pattern_url = payload
        .pattern_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let gradient_colors: Option<Vec<String>> = payload.gradient_colors.map(|colors| {
        colors
            .into_iter()
            .map(|c| c.trim().to_uppercase())
            .filter(|c| !c.is_empty())
            .collect()
    });
    match kind.as_str() {
        "image" if image_url.is_none() => return bad_request("imageUrl is required for image wallpapers"),
        "gradient" | "pattern" => match &gradient_colors {
            Some(colors) if (2..=4).contains(&colors.len()) => {
                if colors.iter().any(|c| !is_hex_color(c)) {
                    return bad_request("gradientColors must be HEX colours like #1A1A1A");
                }
            }
            _ => return bad_request("gradientColors needs two to four HEX colours"),
        },
        _ => {}
    }
    if kind == "pattern" && pattern_url.is_none() {
        return bad_request("patternUrl is required for pattern wallpapers");
    }
    if let Some(o) = payload.overlay_opacity {
        if !(0.0..=1.0).contains(&o) {
            return bad_request("overlayOpacity must be between 0 and 1");
        }
    }
    if let Some(o) = payload.pattern_opacity {
        if !(0.0..=1.0).contains(&o) {
            return bad_request("patternOpacity must be between 0 and 1");
        }
    }
    if let Some(tint) = payload.tint_color.as_deref() {
        if !tint.trim().is_empty() && !is_hex_color(tint) {
            return bad_request("tintColor must be a HEX colour");
        }
    }

    let now = Utc::now();
    let wallpaper = ChatWallpaper {
        id: None,
        name,
        image_url: image_url.unwrap_or_default(),
        thumbnail_url: payload
            .thumbnail_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        tint_color: payload
            .tint_color
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        overlay_opacity: payload.overlay_opacity,
        kind: Some(kind.clone()),
        gradient_colors: if kind == "image" { None } else { gradient_colors },
        pattern_url: if kind == "pattern" { pattern_url } else { None },
        pattern_opacity: if kind == "pattern" { payload.pattern_opacity } else { None },
        is_active: payload.is_active,
        sort_order: payload.sort_order,
        created_at: now,
        updated_at: now,
    };
    match repo.insert(wallpaper).await {
        Ok(saved) => HttpResponse::Created().json(json!({
            "success": true,
            "data": ChatWallpaperResponse::admin(saved),
            "error": null,
        })),
        Err(err) => {
            log::error!("Failed to insert chat wallpaper: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to save chat wallpaper",
            }))
        }
    }
}

/// `PATCH /api/v1/admin/chat-wallpapers/{id}` — retire or restore a wallpaper.
#[patch("/api/v1/admin/chat-wallpapers/{id}")]
pub async fn admin_set_chat_wallpaper_active(
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<SetActiveRequest>,
    repo: web::Data<ChatWallpaperRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return unauthorized();
    }
    let id = path.into_inner();
    match repo.set_active(&id, body.is_active).await {
        Ok(0) => HttpResponse::NotFound().json(json!({
            "success": false, "data": null, "error": "Chat wallpaper not found",
        })),
        Ok(_) => HttpResponse::Ok().json(json!({
            "success": true, "data": { "id": id, "isActive": body.is_active }, "error": null,
        })),
        Err(err) => {
            log::error!("Failed to update chat wallpaper {}: {}", id, err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to update chat wallpaper",
            }))
        }
    }
}

/// `DELETE /api/v1/admin/chat-wallpapers/{id}` — hard delete.
#[delete("/api/v1/admin/chat-wallpapers/{id}")]
pub async fn admin_delete_chat_wallpaper(
    req: HttpRequest,
    path: web::Path<String>,
    repo: web::Data<ChatWallpaperRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return unauthorized();
    }
    let id = path.into_inner();
    match repo.delete_by_id(&id).await {
        Ok(0) => HttpResponse::NotFound().json(json!({
            "success": false, "data": null, "error": "Chat wallpaper not found",
        })),
        Ok(_) => HttpResponse::Ok().json(json!({
            "success": true, "data": { "id": id }, "error": null,
        })),
        Err(err) => {
            log::error!("Failed to delete chat wallpaper {}: {}", id, err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to delete chat wallpaper",
            }))
        }
    }
}
