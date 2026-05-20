use actix_web::{delete, get, post, web, HttpRequest, HttpResponse};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::middleware::admin_auth::verify_admin_token;
use crate::models::AppIcon;
use crate::repositories::AppIconRepository;

/// Wire shape sent to mobile clients. camelCase to match the rest of the API.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppIconResponse {
    id: String,
    slot_name: String,
    name: String,
    preview_url: String,
    sort_order: i32,
    created_at: String,
    /// Only populated for admin responses (`/admin/app-icons`). The public
    /// catalog endpoint omits it because every row it returns is active.
    #[serde(skip_serializing_if = "Option::is_none")]
    is_active: Option<bool>,
}

impl AppIconResponse {
    fn public(icon: AppIcon) -> Self {
        Self {
            id: icon.id.map(|oid| oid.to_hex()).unwrap_or_default(),
            slot_name: icon.slot_name,
            name: icon.name,
            preview_url: icon.preview_url,
            sort_order: icon.sort_order,
            created_at: icon.created_at.to_rfc3339(),
            is_active: None,
        }
    }

    fn admin(icon: AppIcon) -> Self {
        let is_active = icon.is_active;
        let mut response = Self::public(icon);
        response.is_active = Some(is_active);
        response
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertAppIconRequest {
    /// Required: must match a slot declared in the mobile binary's
    /// expo-dynamic-app-icon plugin config (e.g., "noir", "blueprint").
    slot_name: String,
    name: String,
    preview_url: String,
    #[serde(default)]
    sort_order: i32,
    #[serde(default = "default_true")]
    is_active: bool,
}

fn default_true() -> bool {
    true
}

// ── Public ───────────────────────────────────────────────────────────

/// `GET /api/v1/content/app-icons`
///
/// Public catalog (no JWT required). Mobile clients cache the response via
/// React Query and refresh on app focus, so admin changes show up within
/// one refresh cycle — no rebuild required to retire / reorder / rename a
/// slot. Adding NEW slots still needs a binary build because the icon
/// bitmaps are bundled (see model docs).
#[get("/api/v1/content/app-icons")]
pub async fn list_app_icons(repo: web::Data<AppIconRepository>) -> HttpResponse {
    match repo.list_active().await {
        Ok(icons) => {
            let items: Vec<AppIconResponse> =
                icons.into_iter().map(AppIconResponse::public).collect();
            HttpResponse::Ok().json(json!({
                "success": true,
                "data": items,
                "error": null,
            }))
        }
        Err(err) => {
            log::error!("Failed to list app icons: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false,
                "data": null,
                "error": "Failed to load app icons",
            }))
        }
    }
}

// ── Admin ────────────────────────────────────────────────────────────

/// `GET /api/v1/admin/app-icons`
///
/// Admin listing — includes inactive rows.
#[get("/api/v1/admin/app-icons")]
pub async fn admin_list_app_icons(
    req: HttpRequest,
    repo: web::Data<AppIconRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return HttpResponse::Unauthorized().json(json!({
            "success": false, "data": null, "error": "Unauthorized",
        }));
    }
    match repo.list_all().await {
        Ok(icons) => {
            let items: Vec<AppIconResponse> =
                icons.into_iter().map(AppIconResponse::admin).collect();
            HttpResponse::Ok().json(json!({
                "success": true, "data": items, "error": null,
            }))
        }
        Err(err) => {
            log::error!("Failed admin list app icons: {}", err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to load app icons",
            }))
        }
    }
}

/// `POST /api/v1/admin/app-icons`
///
/// Upsert by `slotName`. The slot name is the contract with the binary —
/// re-posting an existing slot updates its metadata; posting a new slot
/// inserts it. The body's `previewUrl` must already be hosted (e.g.,
/// Cloudinary URL produced by atto-web's upload step before this call).
#[post("/api/v1/admin/app-icons")]
pub async fn admin_create_app_icon(
    req: HttpRequest,
    body: web::Json<UpsertAppIconRequest>,
    repo: web::Data<AppIconRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return HttpResponse::Unauthorized().json(json!({
            "success": false, "data": null, "error": "Unauthorized",
        }));
    }
    let payload = body.into_inner();
    if payload.slot_name.trim().is_empty() {
        return HttpResponse::BadRequest().json(json!({
            "success": false, "data": null, "error": "slotName is required",
        }));
    }
    if payload.preview_url.trim().is_empty() {
        return HttpResponse::BadRequest().json(json!({
            "success": false, "data": null, "error": "previewUrl is required",
        }));
    }
    if payload.name.trim().is_empty() {
        return HttpResponse::BadRequest().json(json!({
            "success": false, "data": null, "error": "name is required",
        }));
    }

    match repo
        .upsert(
            &payload.slot_name,
            &payload.name,
            &payload.preview_url,
            payload.sort_order,
            payload.is_active,
        )
        .await
    {
        Ok(icon) => HttpResponse::Created().json(json!({
            "success": true,
            "data": AppIconResponse::admin(icon),
            "error": null,
        })),
        Err(err) => {
            log::error!("Failed to upsert app icon {}: {}", payload.slot_name, err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to save app icon",
            }))
        }
    }
}

/// `DELETE /api/v1/admin/app-icons/{id}`
///
/// Hard-delete by ObjectId. For "soft retire" use the upsert above with
/// `isActive: false`.
#[delete("/api/v1/admin/app-icons/{id}")]
pub async fn admin_delete_app_icon(
    req: HttpRequest,
    path: web::Path<String>,
    repo: web::Data<AppIconRepository>,
) -> HttpResponse {
    if !verify_admin_token(&req) {
        return HttpResponse::Unauthorized().json(json!({
            "success": false, "data": null, "error": "Unauthorized",
        }));
    }
    let id = path.into_inner();
    match repo.delete_by_id(&id).await {
        Ok(0) => HttpResponse::NotFound().json(json!({
            "success": false, "data": null, "error": "App icon not found",
        })),
        Ok(_) => HttpResponse::Ok().json(json!({
            "success": true, "data": { "id": id }, "error": null,
        })),
        Err(err) => {
            log::error!("Failed to delete app icon {}: {}", id, err);
            HttpResponse::InternalServerError().json(json!({
                "success": false, "data": null, "error": "Failed to delete app icon",
            }))
        }
    }
}
