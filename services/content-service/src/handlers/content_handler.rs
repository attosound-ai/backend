use actix_web::{delete, get, post, web, HttpRequest, HttpResponse};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

use crate::config::Config;
use crate::middleware::extract_user_id;
use crate::services::{ContentError, ContentService};

#[derive(Debug, Deserialize)]
pub struct CreateContentBody {
    pub content_type: String,
    #[serde(default)]
    pub title: String,
    pub text_content: Option<String>,
    #[serde(default)]
    pub file_paths: Vec<String>,
    #[serde(default)]
    pub metadata: HashMap<String, String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct PaginationQuery {
    pub page: Option<u64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
struct ContentResponse {
    id: String,
    author_id: String,
    content_type: String,
    title: String,
    text_content: Option<String>,
    file_paths: Vec<String>,
    metadata: HashMap<String, String>,
    tags: Vec<String>,
    created_at: String,
    updated_at: String,
}

impl From<crate::models::Content> for ContentResponse {
    fn from(c: crate::models::Content) -> Self {
        Self {
            id: c.id.map(|oid| oid.to_hex()).unwrap_or_default(),
            author_id: c.author_id,
            content_type: c.content_type,
            title: c.title,
            text_content: c.text_content,
            file_paths: c.file_paths,
            metadata: c.metadata,
            tags: c.tags,
            created_at: c.created_at.to_rfc3339(),
            updated_at: c.updated_at.to_rfc3339(),
        }
    }
}

fn error_response(err: ContentError) -> HttpResponse {
    match &err {
        ContentError::NotFound => HttpResponse::NotFound().json(json!({
            "success": false,
            "data": null,
            "error": err.to_string()
        })),
        ContentError::InvalidContentType(_) | ContentError::InvalidId(_) => {
            HttpResponse::BadRequest().json(json!({
                "success": false,
                "data": null,
                "error": err.to_string()
            }))
        }
        ContentError::Unauthorized => HttpResponse::Forbidden().json(json!({
            "success": false,
            "data": null,
            "error": err.to_string()
        })),
        ContentError::DatabaseError(_) => {
            HttpResponse::InternalServerError().json(json!({
                "success": false,
                "data": null,
                "error": "Internal server error"
            }))
        }
    }
}

#[post("/api/v1/content")]
pub async fn create_content(
    req: HttpRequest,
    body: web::Json<CreateContentBody>,
    svc: web::Data<ContentService>,
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

    let input = crate::models::CreateContentInput {
        author_id: user_id,
        content_type: body.content_type.clone(),
        title: body.title.clone(),
        text_content: body.text_content.clone(),
        file_paths: body.file_paths.clone(),
        metadata: body.metadata.clone(),
        tags: body.tags.clone(),
    };

    match svc.create_content(input).await {
        Ok(content) => {
            let resp: ContentResponse = content.into();
            HttpResponse::Created().json(json!({
                "success": true,
                "data": resp,
                "error": null
            }))
        }
        Err(e) => error_response(e),
    }
}

#[get("/api/v1/content/{id}")]
pub async fn get_content(
    path: web::Path<String>,
    svc: web::Data<ContentService>,
) -> HttpResponse {
    let id = path.into_inner();
    match svc.get_content(&id).await {
        Ok(content) => {
            let resp: ContentResponse = content.into();
            HttpResponse::Ok().json(json!({
                "success": true,
                "data": resp,
                "error": null
            }))
        }
        Err(e) => error_response(e),
    }
}

#[get("/api/v1/content")]
pub async fn list_content(
    query: web::Query<PaginationQuery>,
    svc: web::Data<ContentService>,
) -> HttpResponse {
    let page = query.page.unwrap_or(1).max(1);
    let limit = query.limit.unwrap_or(20).min(100).max(1);

    match svc.list_content(page, limit).await {
        Ok((contents, total)) => {
            let items: Vec<ContentResponse> = contents.into_iter().map(|c| c.into()).collect();
            let total_pages = ((total as f64) / (limit as f64)).ceil() as u64;
            HttpResponse::Ok().json(json!({
                "success": true,
                "data": items,
                "meta": {
                    "page": page,
                    "limit": limit,
                    "total": total,
                    "total_pages": total_pages,
                    "has_more": page < total_pages
                },
                "error": null
            }))
        }
        Err(e) => error_response(e),
    }
}

#[delete("/api/v1/content/{id}")]
pub async fn delete_content(
    req: HttpRequest,
    path: web::Path<String>,
    svc: web::Data<ContentService>,
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

    let id = path.into_inner();
    match svc.delete_content(&id, &user_id).await {
        Ok(()) => HttpResponse::Ok().json(json!({
            "success": true,
            "data": null,
            "error": null
        })),
        Err(e) => error_response(e),
    }
}
