use actix_web::HttpRequest;
use jsonwebtoken::{decode, DecodingKey, Validation, Algorithm};
use serde::Deserialize;

/// JWT claims matching the user-service token structure.
/// `sub` contains the user ID (same as Go's JWTClaims.UserID).
#[derive(Debug, Deserialize)]
struct Claims {
    sub: String,
}

/// Extracts the user ID from the request.
///
/// 1. Tries `Authorization: Bearer <jwt>` header → validates with HS256 and returns `sub`.
/// 2. Falls back to `X-User-ID` header (for internal service-to-service calls).
pub fn extract_user_id(req: &HttpRequest, jwt_secret: &str) -> Option<String> {
    // Try JWT from Authorization header
    if let Some(auth_header) = req.headers().get("Authorization") {
        if let Ok(auth_str) = auth_header.to_str() {
            if let Some(token) = auth_str.strip_prefix("Bearer ") {
                let key = DecodingKey::from_secret(jwt_secret.as_bytes());
                let mut validation = Validation::new(Algorithm::HS256);
                validation.validate_exp = false; // Let refresh flow handle expiry
                if let Ok(data) = decode::<Claims>(token, &key, &validation) {
                    return Some(data.claims.sub);
                }
            }
        }
    }

    // Fallback: X-User-ID header (service-to-service)
    req.headers()
        .get("X-User-ID")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}
