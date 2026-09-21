use actix_web::{delete, get, post, web, HttpRequest, HttpResponse};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::middleware::admin_auth::verify_admin_token;
use crate::models::AppLogo;
use crate::repositories::AppLogoRepository;

/// Query params for the public endpoint. The app passes its own build number so
/// the server can target logos by version.
#[derive(Debug, Deserialize)]
struct AppLogoQuery {
    #[serde(default, rename = "appBuild")]
    app_build: Option<i32>,
}

/// Public response: the single resolved logo for THIS client (camelCase).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedLogoResponse {
    image_url: String,
    /// Launch splash image when the admin set one; absent means the splash
    /// follows `image_url`. Always optional so older builds ignore it.
    #[serde(skip_serializing_if = "Option::is_none")]
    splash_image_url: Option<String>,
    updated_at: String,
}

/// Admin response: the full stored config so the dashboard can show current state.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminLogoResponse {
    image_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    splash_image_url: Option<String>,
    min_version: Option<i32>,
    fallback_image_url: Option<String>,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetAppLogoRequest {
    /// Already-hosted URL of the primary logo (Cloudinary URL from atto-web).
    image_url: String,
    /// Minimum app build that receives `image_url`. Omit/null = all version-aware
    /// clients.
    #[serde(default)]
    min_version: Option<i32>,
    /// What clients below `min_version` see. Omit/null = their bundled default.
    #[serde(default)]
    fallback_image_url: Option<String>,
}

/// Resolve which URL a given client build should see.
///
/// A client only reaches this with a URL when it sent `appBuild` — i.e. a
/// version-aware build (>= the first that both sends its build and hides its
/// own drawn wordmark). Older, gate-less builds never send `appBuild`, so they
/// get the fallback (or nothing) and can never double-draw a baked-in wordmark.
fn resolve_url(logo: &AppLogo, app_build: Option<i32>) -> Option<String> {
    match app_build {
        None => logo.fallback_image_url.clone(),
        Some(build) => match logo.min_version {
            Some(min) if build < min => logo.fallback_image_url.clone(),
            _ => Some(logo.image_url.clone()),
        },
    }
}

// ── Public ───────────────────────────────────────────────────────────

/// `GET /api/v1/content/app-logo?appBuild=<n>`
///
/// Public (no JWT). Returns the logo resolved for the requesting build, or
/// `data: null` (app shows its bundled default). Cached client-side and
/// refreshed on focus, so admin changes land within one refresh, no rebuild.
#[get("/api/v1/content/app-logo")]
pub async fn get_app_logo(
    query: web::Query<AppLogoQuery>,
    repo: web::Data<AppLogoRepository>,
) -> HttpResponse {
    // Record the highest build we see so the admin hint stays truthful without
    // any hardcoded version. Fire-and-forget: never blocks or fails the read.
    if let Some(build) = query.app_build {
        let repo = repo.clone();
        actix_web::rt::spawn(async move {
            if let Err(err) = repo.record_seen_build(build).await {
                log::warn!("Failed to record seen build {}: {}", build, err);
            }
        });
    }
    // The splash only goes to version aware builds, like the main logo.
    let splash = match query.app_build {
        Some(_) => repo.get_splash().await.ok().flatten().map(|l| l.image_url),
        None => None,
    };
    match repo.get_current().await {
        Ok(Some(logo)) => {
            let updated_at = logo.updated_at.to_rfc3339();
            match resolve_url(&logo, query.app_build) {
                Some(url) => HttpResponse::Ok().json(json!({
                    "success": true,
                    "data": ResolvedLogoResponse {
                        image_url: url,
                        splash_image_url: splash,
                        updated_at,
                    },
                    "error": null,
                })),
                None => HttpResponse::Ok().json(json!({
                    "success": true, "data": null, "error": null,
                })),
            }
        }
        Ok(None) => HttpResponse::Ok().json(json!({
            "success": true, "data": null, "error": null,
        })),
        Err(err) => {
            log::error!("Failed to get app logo: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to load app logo",
            }))
        }
    }
}

// ── Admin ────────────────────────────────────────────────────────────

/// `GET /api/v1/admin/app-logo` — full stored config for the dashboard.
#[get("/api/v1/admin/app-logo")]
pub async fn admin_get_app_logo(
    req: HttpRequest,
    repo: web::Data<AppLogoRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return HttpResponse::Unauthorized().json(json!({
            "success": false, "data": null, "error": "Unauthorized",
        }));
    }
    // Highest build seen in the wild — the dashboard shows it instead of a
    // hardcoded version, so the "latest build" hint can never go stale.
    let latest_seen_build = repo.get_max_seen_build().await.ok().flatten();
    let splash = repo.get_splash().await.ok().flatten().map(|l| l.image_url);
    match repo.get_current().await {
        Ok(Some(logo)) => HttpResponse::Ok().json(json!({
            "success": true,
            "data": AdminLogoResponse {
                image_url: logo.image_url,
                splash_image_url: splash,
                min_version: logo.min_version,
                fallback_image_url: logo.fallback_image_url,
                updated_at: logo.updated_at.to_rfc3339(),
            },
            "latestSeenBuild": latest_seen_build,
            "error": null,
        })),
        Ok(None) => HttpResponse::Ok().json(json!({
            "success": true, "data": null, "latestSeenBuild": latest_seen_build, "error": null,
        })),
        Err(err) => {
            log::error!("Failed admin get app logo: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to load app logo",
            }))
        }
    }
}

/// `POST /api/v1/admin/app-logo` — set the logo + optional version target and
/// fallback. `X-Admin-Token` gated.
#[post("/api/v1/admin/app-logo")]
pub async fn admin_set_app_logo(
    req: HttpRequest,
    body: web::Json<SetAppLogoRequest>,
    repo: web::Data<AppLogoRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return HttpResponse::Unauthorized().json(json!({
            "success": false, "data": null, "error": "Unauthorized",
        }));
    }

    let image_url = body.image_url.trim();
    if image_url.is_empty() {
        return HttpResponse::BadRequest().json(json!({
            "success": false, "data": null, "error": "imageUrl is required",
        }));
    }
    let fallback = body
        .fallback_image_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    match repo.set_current(image_url, body.min_version, fallback).await {
        Ok(logo) => HttpResponse::Ok().json(json!({
            "success": true,
            "data": AdminLogoResponse {
                image_url: logo.image_url,
                splash_image_url: repo.get_splash().await.ok().flatten().map(|l| l.image_url),
                min_version: logo.min_version,
                fallback_image_url: logo.fallback_image_url,
                updated_at: logo.updated_at.to_rfc3339(),
            },
            "error": null,
        })),
        Err(err) => {
            log::error!("Failed to set app logo: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to set app logo",
            }))
        }
    }
}

// ── Splash logo ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetSplashLogoRequest {
    /// Already hosted URL of the launch splash image.
    image_url: String,
}

/// `POST /api/v1/admin/app-logo/splash` sets the launch splash image on its
/// own, leaving the header logo untouched. `X-Admin-Token` gated.
#[post("/api/v1/admin/app-logo/splash")]
pub async fn admin_set_splash_logo(
    req: HttpRequest,
    body: web::Json<SetSplashLogoRequest>,
    repo: web::Data<AppLogoRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return HttpResponse::Unauthorized().json(json!({
            "success": false, "data": null, "error": "Unauthorized",
        }));
    }
    let image_url = body.image_url.trim();
    if image_url.is_empty() || !image_url.starts_with("https://") {
        return HttpResponse::BadRequest().json(json!({
            "success": false, "data": null, "error": "imageUrl must be an https URL",
        }));
    }
    match repo.set_splash(image_url).await {
        Ok(logo) => HttpResponse::Ok().json(json!({
            "success": true,
            "data": { "splashImageUrl": logo.image_url, "updatedAt": logo.updated_at.to_rfc3339() },
            "error": null,
        })),
        Err(err) => {
            log::error!("Failed to set splash logo: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to set splash logo",
            }))
        }
    }
}

/// `DELETE /api/v1/admin/app-logo/splash` clears it: the splash follows the
/// main logo again.
#[delete("/api/v1/admin/app-logo/splash")]
pub async fn admin_clear_splash_logo(
    req: HttpRequest,
    repo: web::Data<AppLogoRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return HttpResponse::Unauthorized().json(json!({
            "success": false, "data": null, "error": "Unauthorized",
        }));
    }
    match repo.clear_splash().await {
        Ok(removed) => HttpResponse::Ok().json(json!({
            "success": true, "data": { "removed": removed }, "error": null,
        })),
        Err(err) => {
            log::error!("Failed to clear splash logo: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to clear splash logo",
            }))
        }
    }
}
