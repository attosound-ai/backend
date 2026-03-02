use actix_web::{get, HttpResponse};
use serde_json::json;

#[get("/health")]
pub async fn health_check() -> HttpResponse {
    HttpResponse::Ok().json(json!({
        "status": "ok",
        "service": "content-service"
    }))
}
