use actix_web::{delete, get, put, web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::middleware::admin_auth::verify_admin_token;
use crate::repositories::{AppLogoRepository, AppSettingsRepository};

pub const FEED_MENU_KEY: &str = "feed_menu";
pub const SPLASH_SCALE_KEY: &str = "splash_scale";
/// Builds below this number must update before they can be used. Absent or 0
/// means nobody is blocked, which is the safe default: a setting that locks
/// everyone out must never be the result of a missing value.
pub const MIN_BUILD_KEY: &str = "min_build";
/// What the blocking screen says. Optional; the app has its own wording.
pub const UPDATE_COPY_KEY: &str = "update_copy";

/// A guard against the worst mistake this feature allows: typing a build that
/// does not exist yet locks every user out with no way back, and it cannot be
/// undone from the app. The dashboard shows the highest build ever seen and
/// this refuses anything far beyond it.
const MIN_BUILD_MAX_AHEAD: i64 = 5;

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

/// The minimum build, sane or nothing. Zero and negatives clear the gate.
pub fn validate_min_build(value: i64, highest_seen: i64) -> Result<i64, String> {
    if value <= 0 {
        return Ok(0);
    }
    if highest_seen > 0 && value > highest_seen + MIN_BUILD_MAX_AHEAD {
        return Err(format!(
            "build {} does not exist yet: the highest build ever seen is {}. Forcing it would lock every user out with no way back.",
            value, highest_seen
        ));
    }
    Ok(value)
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
    logos: web::Data<AppLogoRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return unauthorized();
    }
    let feed_menu = repo.get(FEED_MENU_KEY).await;
    let splash_scale = repo.get(SPLASH_SCALE_KEY).await;
    let min_build = repo.get(MIN_BUILD_KEY).await.ok().flatten().and_then(|v| v.as_i64());
    let update_copy = repo.get(UPDATE_COPY_KEY).await.ok().flatten();
    // El build más alto que se ha visto jamás. Es lo que evita que alguien
    // escriba un número que no existe y deje a todo el mundo fuera.
    let highest_seen = logos.get_max_seen_build().await.ok().flatten();
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
                "minBuild": min_build.unwrap_or(0),
                "updateCopy": update_copy,
                "highestSeenBuild": highest_seen,
                "minBuildMaxAhead": MIN_BUILD_MAX_AHEAD,
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


// ── Forced update ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct SetMinBuildRequest {
    build: i64,
}

/// `PUT /api/v1/admin/app-settings/min-build`: builds below this must update.
#[put("/api/v1/admin/app-settings/min-build")]
pub async fn admin_set_min_build(
    req: HttpRequest,
    body: web::Json<SetMinBuildRequest>,
    repo: web::Data<AppSettingsRepository>,
    logos: web::Data<AppLogoRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return unauthorized();
    }
    let highest = logos.get_max_seen_build().await.ok().flatten().unwrap_or(0) as i64;
    let build = match validate_min_build(body.build, highest) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
    match repo.set(MIN_BUILD_KEY, json!(build)).await {
        Ok(v) => HttpResponse::Ok()
            .json(json!({ "success": true, "data": { "minBuild": v }, "error": null })),
        Err(err) => {
            log::error!("Failed to set min build: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to save minimum build",
            }))
        }
    }
}

/// `DELETE /api/v1/admin/app-settings/min-build`: nobody is blocked again.
#[delete("/api/v1/admin/app-settings/min-build")]
pub async fn admin_clear_min_build(
    req: HttpRequest,
    repo: web::Data<AppSettingsRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return unauthorized();
    }
    match repo.set(MIN_BUILD_KEY, json!(0)).await {
        Ok(_) => HttpResponse::Ok()
            .json(json!({ "success": true, "data": { "minBuild": 0 }, "error": null })),
        Err(err) => {
            log::error!("Failed to clear min build: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to clear minimum build",
            }))
        }
    }
}

#[derive(Debug, Deserialize)]
struct SetUpdateCopyRequest {
    title: Option<String>,
    message: Option<String>,
    button: Option<String>,
    url: Option<String>,
}

fn trim_limited(v: Option<String>, max: usize) -> Option<String> {
    v.map(|s| s.trim().chars().take(max).collect::<String>())
        .filter(|s| !s.is_empty())
}

/// `PUT /api/v1/admin/app-settings/update-copy`: what the blocking screen says.
#[put("/api/v1/admin/app-settings/update-copy")]
pub async fn admin_set_update_copy(
    req: HttpRequest,
    body: web::Json<SetUpdateCopyRequest>,
    repo: web::Data<AppSettingsRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return unauthorized();
    }
    let body = body.into_inner();
    let url = trim_limited(body.url, 300);
    if let Some(u) = &url {
        if !(u.starts_with("https://") || u.starts_with("itms-")) {
            return bad_request("the link must start with https:// or itms-".to_string());
        }
    }
    let copy = json!({
        "title": trim_limited(body.title, 60),
        "message": trim_limited(body.message, 240),
        "button": trim_limited(body.button, 30),
        "url": url,
    });
    match repo.set(UPDATE_COPY_KEY, copy).await {
        Ok(v) => HttpResponse::Ok()
            .json(json!({ "success": true, "data": { "updateCopy": v }, "error": null })),
        Err(err) => {
            log::error!("Failed to set update copy: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to save the update wording",
            }))
        }
    }
}

/// `GET /api/v1/content/app-release`
///
/// Public, and deliberately its OWN endpoint rather than riding along with the
/// logo: the logo response is `data: null` whenever no logo is configured, and
/// a gate that blocks the whole app must never depend on an unrelated setting
/// being present. Answers in one small read and is safe to call on every
/// launch and resume.
#[get("/api/v1/content/app-release")]
pub async fn get_app_release(
    repo: web::Data<AppSettingsRepository>,
) -> HttpResponse {
    let min_build = repo
        .get(MIN_BUILD_KEY)
        .await
        .unwrap_or_else(|err| {
            log::warn!("Failed to read min build: {}", err);
            None
        })
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let copy = repo.get(UPDATE_COPY_KEY).await.unwrap_or_else(|err| {
        log::warn!("Failed to read update copy: {}", err);
        None
    });
    HttpResponse::Ok().json(json!({
        "success": true,
        "data": { "minBuild": min_build, "copy": copy },
        "error": null,
    }))
}

#[cfg(test)]
mod tests_min_build {
    use super::*;

    // El error que no tiene vuelta atrás: fijar un build que no existe deja a
    // todo el mundo fuera, y desde dentro del bloqueo no se puede deshacer.
    #[test]
    fn rechaza_un_build_que_todavia_no_existe() {
        let err = validate_min_build(500, 224).unwrap_err();
        assert!(err.contains("does not exist yet"), "{}", err);
        assert!(err.contains("224"), "{}", err);
    }

    #[test]
    fn acepta_el_build_mas_alto_visto_y_un_margen_corto() {
        assert_eq!(validate_min_build(224, 224).unwrap(), 224);
        assert_eq!(validate_min_build(229, 224).unwrap(), 229);
    }

    #[test]
    fn cero_y_negativos_levantan_el_bloqueo() {
        assert_eq!(validate_min_build(0, 224).unwrap(), 0);
        assert_eq!(validate_min_build(-3, 224).unwrap(), 0);
    }

    // Sin ningún build visto no hay con qué comparar, así que no se inventa un
    // límite: se confía en quien escribe, que es lo único honesto ahí.
    #[test]
    fn sin_referencia_no_se_impone_un_limite() {
        assert_eq!(validate_min_build(9000, 0).unwrap(), 9000);
    }
}
