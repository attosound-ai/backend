use actix_multipart::Multipart;
use actix_web::{delete, post, web, HttpRequest, HttpResponse};
use futures::StreamExt;
use log::{error, info};
use serde_json::json;
use std::path::Path;
use uuid::Uuid;

use crate::cloudinary::{CloudinaryClient, SignedUploadParams};
use crate::cloudinary::types::SignUploadRequest;
use crate::config::Config;
use crate::middleware::extract_user_id;

/// POST /api/v1/media/sign — Generate signed Cloudinary upload parameters.
/// The frontend uses these to upload directly to Cloudinary (no file bytes through our server).
#[post("/api/v1/media/sign")]
pub async fn sign_upload(
    req: HttpRequest,
    body: web::Json<SignUploadRequest>,
    cloudinary: web::Data<CloudinaryClient>,
    config: web::Data<Config>,
) -> HttpResponse {
    let user_id = match extract_user_id(&req, &config.jwt_secret) {
        Some(id) => id,
        None => {
            return HttpResponse::Unauthorized().json(json!({
                "success": false,
                "data": null,
                "error": "Missing X-User-ID header"
            }));
        }
    };

    // Validate resource_type
    if !["image", "video", "raw"].contains(&body.resource_type.as_str()) {
        return HttpResponse::BadRequest().json(json!({
            "success": false,
            "data": null,
            "error": "Invalid resource_type. Must be: image, video, or raw"
        }));
    }

    // Resolve context → folder + eager transformations
    let (folder, eager) = match CloudinaryClient::resolve_context(&body.context) {
        Some(resolved) => resolved,
        None => {
            return HttpResponse::BadRequest().json(json!({
                "success": false,
                "data": null,
                "error": "Invalid context. Must be: avatar, content, audio, chat, video, or reel"
            }));
        }
    };

    // Generate unique public_id
    let short_uuid = &Uuid::new_v4().to_string().replace('-', "")[..12];
    let public_id = format!("{}_{}", body.context, short_uuid);

    info!(
        "[MEDIA] Signing upload for user={} context={} public_id={}/{}",
        user_id, body.context, folder, public_id
    );

    let params = cloudinary.sign_upload(
        folder,
        &public_id,
        &body.resource_type,
        eager.as_deref(),
    );

    HttpResponse::Ok().json(json!({
        "success": true,
        "data": params,
        "error": null
    }))
}

/// POST /api/v1/media/upload — Legacy local disk upload (kept for backward compatibility).
#[post("/api/v1/media/upload")]
pub async fn upload_media(
    req: HttpRequest,
    mut payload: Multipart,
    config: web::Data<Config>,
) -> HttpResponse {
    let _user_id = match extract_user_id(&req, &config.jwt_secret) {
        Some(id) => id,
        None => {
            return HttpResponse::Unauthorized().json(json!({
                "success": false,
                "data": null,
                "error": "Missing X-User-ID header"
            }));
        }
    };

    let upload_dir = &config.upload_dir;
    let max_file_size = config.max_file_size;

    // Ensure upload directory exists
    if let Err(e) = tokio::fs::create_dir_all(upload_dir).await {
        error!("Failed to create upload directory: {}", e);
        return HttpResponse::InternalServerError().json(json!({
            "success": false,
            "data": null,
            "error": "Failed to create upload directory"
        }));
    }

    let mut file_paths: Vec<String> = Vec::new();

    while let Some(item) = payload.next().await {
        let mut field = match item {
            Ok(f) => f,
            Err(e) => {
                error!("Multipart error: {}", e);
                return HttpResponse::BadRequest().json(json!({
                    "success": false,
                    "data": null,
                    "error": format!("Multipart error: {}", e)
                }));
            }
        };

        // Get original filename and extension
        let original_filename = field
            .content_disposition()
            .and_then(|cd| cd.get_filename().map(|s| s.to_owned()))
            .unwrap_or_else(|| "unknown".to_owned());

        let extension = Path::new(&original_filename)
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("");

        // Generate UUID-based filename preserving extension
        let new_filename = if extension.is_empty() {
            Uuid::new_v4().to_string()
        } else {
            format!("{}.{}", Uuid::new_v4(), extension)
        };

        // Sanitize the filename
        let safe_filename = sanitize_filename::sanitize(&new_filename);
        let file_path = format!("{}/{}", upload_dir, safe_filename);

        // Read field data with size limit
        let mut data = Vec::new();
        let mut total_size: usize = 0;

        while let Some(chunk) = field.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    error!("Failed to read chunk: {}", e);
                    return HttpResponse::BadRequest().json(json!({
                        "success": false,
                        "data": null,
                        "error": format!("Failed to read upload data: {}", e)
                    }));
                }
            };

            total_size += chunk.len();
            if total_size > max_file_size {
                return HttpResponse::PayloadTooLarge().json(json!({
                    "success": false,
                    "data": null,
                    "error": format!("File exceeds maximum size of {} bytes", max_file_size)
                }));
            }

            data.extend_from_slice(&chunk);
        }

        // Write file to disk
        if let Err(e) = tokio::fs::write(&file_path, &data).await {
            error!("Failed to write file {}: {}", file_path, e);
            return HttpResponse::InternalServerError().json(json!({
                "success": false,
                "data": null,
                "error": "Failed to save uploaded file"
            }));
        }

        file_paths.push(file_path);
    }

    if file_paths.is_empty() {
        return HttpResponse::BadRequest().json(json!({
            "success": false,
            "data": null,
            "error": "No files uploaded"
        }));
    }

    HttpResponse::Ok().json(json!({
        "success": true,
        "data": {
            "file_paths": file_paths
        },
        "error": null
    }))
}

/// DELETE /api/v1/media/{public_id_or_filename} — Delete media from Cloudinary or local disk.
#[delete("/api/v1/media/{identifier}")]
pub async fn delete_media(
    req: HttpRequest,
    path: web::Path<String>,
    cloudinary: web::Data<CloudinaryClient>,
    config: web::Data<Config>,
) -> HttpResponse {
    let _user_id = match extract_user_id(&req, &config.jwt_secret) {
        Some(id) => id,
        None => {
            return HttpResponse::Unauthorized().json(json!({
                "success": false,
                "data": null,
                "error": "Missing X-User-ID header"
            }));
        }
    };

    let identifier = path.into_inner();

    // Determine resource_type from query param (default: "image")
    let resource_type = req
        .query_string()
        .split('&')
        .find_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            if parts.next() == Some("resource_type") {
                parts.next().map(String::from)
            } else {
                None
            }
        })
        .unwrap_or_else(|| "image".to_string());

    // If identifier looks like a Cloudinary public_id (contains / or _), use Cloudinary
    if identifier.contains('/') || identifier.starts_with("atto") || identifier.starts_with("avatar")
        || identifier.starts_with("content") || identifier.starts_with("audio") || identifier.starts_with("chat")
    {
        // Decode the public_id (it may be URL-encoded with folder path)
        let public_id = urlencoding::decode(&identifier)
            .unwrap_or(identifier.clone().into())
            .to_string();

        info!("[MEDIA] Deleting from Cloudinary: {} (type: {})", public_id, resource_type);

        match cloudinary.destroy(&public_id, &resource_type).await {
            Ok(()) => HttpResponse::Ok().json(json!({
                "success": true,
                "data": null,
                "error": null
            })),
            Err(e) => {
                error!("[MEDIA] Cloudinary delete failed: {}", e);
                HttpResponse::InternalServerError().json(json!({
                    "success": false,
                    "data": null,
                    "error": "Failed to delete media"
                }))
            }
        }
    } else {
        // Legacy: local file deletion
        let safe_filename = sanitize_filename::sanitize(&identifier);
        let file_path = format!("{}/{}", config.upload_dir, safe_filename);

        let canonical_upload = match std::fs::canonicalize(&config.upload_dir) {
            Ok(p) => p,
            Err(_) => {
                return HttpResponse::NotFound().json(json!({
                    "success": false,
                    "data": null,
                    "error": "File not found"
                }));
            }
        };

        let canonical_file = match std::fs::canonicalize(&file_path) {
            Ok(p) => p,
            Err(_) => {
                return HttpResponse::NotFound().json(json!({
                    "success": false,
                    "data": null,
                    "error": "File not found"
                }));
            }
        };

        if !canonical_file.starts_with(&canonical_upload) {
            return HttpResponse::Forbidden().json(json!({
                "success": false,
                "data": null,
                "error": "Access denied"
            }));
        }

        match tokio::fs::remove_file(&file_path).await {
            Ok(()) => HttpResponse::Ok().json(json!({
                "success": true,
                "data": null,
                "error": null
            })),
            Err(e) => {
                error!("Failed to delete file {}: {}", file_path, e);
                HttpResponse::InternalServerError().json(json!({
                    "success": false,
                    "data": null,
                    "error": "Failed to delete file"
                }))
            }
        }
    }
}
