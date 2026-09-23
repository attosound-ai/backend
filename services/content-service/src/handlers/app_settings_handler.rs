use actix_web::{delete, get, put, web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::middleware::admin_auth::verify_admin_token;
use crate::repositories::AppSettingsRepository;

pub const FEED_MENU_KEY: &str = "feed_menu";
pub const SPLASH_SCALE_KEY: &str = "splash_scale";

/// The menu entries the app knows how to act on. An item with any other key
/// is rejected here, because the app would have nothing to open for it.
const FEED_MENU_ITEM_KEYS: [&str; 6] = [
    "following",
    "notifications",
    "store",
    "about",
    "dating",
    "art",
];

/// Icon names the app can draw (lucide-react-native exports). Kept as a
/// closed list so an admin typo never leaves an item without an icon.
const FEED_MENU_ICONS: [&str; 30] = [
    "Users", "Bell", "ShoppingBag", "Info", "Heart", "Palette", "Star", "Music", "Mic", "Store",
    "Gift", "Sparkles", "Globe", "Calendar", "Camera", "Film", "Headphones", "MessageCircle",
    "Shirt", "Ticket", "Trophy", "Zap", "Radio", "BookOpen", "Compass", "Flame", "Handshake",
    "Newspaper", "Video", "Megaphone",
];

const SPLASH_SCALE_MIN: f64 = 0.15;
const SPLASH_SCALE_MAX: f64 = 0.8;

fn unauthorized() -> HttpResponse {
    HttpResponse::Unauthorized().json(json!({
        "success": false, "data": null, "error": "Unauthorized",
    }))
}

fn bad_request(msg: String) -> HttpResponse {
    HttpResponse::BadRequest().json(json!({
        "success": false, "data": null, "error": msg,
    }))
}

/// Validates the feed menu: an array of `{key, label?, icon?, hidden?}` with
/// each known key at most once. Returns the cleaned array.
pub fn validate_feed_menu(value: &Value) -> Result<Value, String> {
    let items = value
        .as_array()
        .ok_or_else(|| "items must be an array".to_string())?;
    if items.len() > 20 {
        return Err("too many items".to_string());
    }
    let mut seen: Vec<String> = Vec::new();
    let mut cleaned: Vec<Value> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let obj = item
            .as_object()
            .ok_or_else(|| format!("item {} must be an object", i))?;
        let key = obj
            .get("key")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .ok_or_else(|| format!("item {} needs a key", i))?;
        if !FEED_MENU_ITEM_KEYS.contains(&key) {
            return Err(format!("item {}: unknown key {}", i, key));
        }
        if seen.iter().any(|k| k == key) {
            return Err(format!("item {}: key {} repeated", i, key));
        }
        seen.push(key.to_string());
        let mut out = serde_json::Map::new();
        out.insert("key".into(), Value::String(key.to_string()));
        if let Some(label) = obj.get("label").and_then(Value::as_str) {
            let label = label.trim();
            if label.chars().count() > 40 {
                return Err(format!("item {}: label longer than 40 characters", i));
            }
            if !label.is_empty() {
                out.insert("label".into(), Value::String(label.to_string()));
            }
        }
        if let Some(icon) = obj.get("icon").and_then(Value::as_str) {
            let icon = icon.trim();
            if !icon.is_empty() {
                if !FEED_MENU_ICONS.contains(&icon) {
                    return Err(format!("item {}: unknown icon {}", i, icon));
                }
                out.insert("icon".into(), Value::String(icon.to_string()));
            }
        }
        if let Some(hidden) = obj.get("hidden").and_then(Value::as_bool) {
            if hidden {
                out.insert("hidden".into(), Value::Bool(true));
            }
        }
        cleaned.push(Value::Object(out));
    }
    Ok(Value::Array(cleaned))
}

pub fn validate_splash_scale(value: f64) -> Result<f64, String> {
    if !value.is_finite() || !(SPLASH_SCALE_MIN..=SPLASH_SCALE_MAX).contains(&value) {
        return Err(format!(
            "scale must be between {} and {}",
            SPLASH_SCALE_MIN, SPLASH_SCALE_MAX
        ));
    }
    Ok((value * 1000.0).round() / 1000.0)
}

/// `GET /api/v1/admin/app-settings`: everything the dashboard edits.
#[get("/api/v1/admin/app-settings")]
pub async fn admin_get_app_settings(
    req: HttpRequest,
    repo: web::Data<AppSettingsRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return unauthorized();
    }
    let feed_menu = repo.get(FEED_MENU_KEY).await;
    let splash_scale = repo.get(SPLASH_SCALE_KEY).await;
    match (feed_menu, splash_scale) {
        (Ok(menu), Ok(scale)) => HttpResponse::Ok().json(json!({
            "success": true,
            "data": {
                "feedMenu": menu,
                "splashScale": scale.and_then(|v| v.as_f64()),
                "menuItemKeys": FEED_MENU_ITEM_KEYS,
                "menuIcons": FEED_MENU_ICONS,
                "splashScaleMin": SPLASH_SCALE_MIN,
                "splashScaleMax": SPLASH_SCALE_MAX,
            },
            "error": null,
        })),
        (Err(err), _) | (_, Err(err)) => {
            log::error!("Failed to read app settings: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to load app settings",
            }))
        }
    }
}

#[derive(Debug, Deserialize)]
struct SetFeedMenuRequest {
    items: Value,
}

/// `PUT /api/v1/admin/app-settings/feed-menu`: replace the menu.
#[put("/api/v1/admin/app-settings/feed-menu")]
pub async fn admin_set_feed_menu(
    req: HttpRequest,
    body: web::Json<SetFeedMenuRequest>,
    repo: web::Data<AppSettingsRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return unauthorized();
    }
    let cleaned = match validate_feed_menu(&body.items) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
    match repo.set(FEED_MENU_KEY, cleaned).await {
        Ok(v) => HttpResponse::Ok().json(json!({ "success": true, "data": { "feedMenu": v }, "error": null })),
        Err(err) => {
            log::error!("Failed to set feed menu: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to save feed menu",
            }))
        }
    }
}

/// `DELETE /api/v1/admin/app-settings/feed-menu`: back to the app's built in menu.
#[delete("/api/v1/admin/app-settings/feed-menu")]
pub async fn admin_clear_feed_menu(
    req: HttpRequest,
    repo: web::Data<AppSettingsRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return unauthorized();
    }
    match repo.clear(FEED_MENU_KEY).await {
        Ok(removed) => HttpResponse::Ok().json(json!({ "success": true, "data": { "removed": removed }, "error": null })),
        Err(err) => {
            log::error!("Failed to clear feed menu: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to clear feed menu",
            }))
        }
    }
}

#[derive(Debug, Deserialize)]
struct SetSplashScaleRequest {
    scale: f64,
}

/// `PUT /api/v1/admin/app-settings/splash-scale`: the launch mark's width as a
/// fraction of the screen width (0.15 to 0.8). The app defaults to 0.3.
#[put("/api/v1/admin/app-settings/splash-scale")]
pub async fn admin_set_splash_scale(
    req: HttpRequest,
    body: web::Json<SetSplashScaleRequest>,
    repo: web::Data<AppSettingsRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return unauthorized();
    }
    let scale = match validate_splash_scale(body.scale) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
    match repo.set(SPLASH_SCALE_KEY, json!(scale)).await {
        Ok(v) => HttpResponse::Ok().json(json!({ "success": true, "data": { "splashScale": v }, "error": null })),
        Err(err) => {
            log::error!("Failed to set splash scale: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to save splash scale",
            }))
        }
    }
}

/// `DELETE /api/v1/admin/app-settings/splash-scale`: back to the app default.
#[delete("/api/v1/admin/app-settings/splash-scale")]
pub async fn admin_clear_splash_scale(
    req: HttpRequest,
    repo: web::Data<AppSettingsRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return unauthorized();
    }
    match repo.clear(SPLASH_SCALE_KEY).await {
        Ok(removed) => HttpResponse::Ok().json(json!({ "success": true, "data": { "removed": removed }, "error": null })),
        Err(err) => {
            log::error!("Failed to clear splash scale: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to clear splash scale",
            }))
        }
    }
}
