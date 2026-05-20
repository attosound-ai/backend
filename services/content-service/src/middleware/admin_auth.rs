//! Admin-only routes are protected with a shared-secret HTTP header.
//!
//! The expected use is service-to-service: the Next.js admin web (atto-web)
//! reads the secret from a Vercel env var and forwards every admin write to
//! the backend with `X-Admin-Token: <secret>`. The browser never sees the
//! secret — it stays on the Next.js server. Kong routes admin paths to the
//! same service as the public endpoints; the gate is enforced here.
//!
//! This is intentionally simpler than a full JWT-with-role flow — the admin
//! surface is small and only one client (atto-web) needs access. When the
//! surface grows we can upgrade to issuing admin JWTs from user-service.

use actix_web::HttpRequest;
use std::env;

/// Verify the request carries a matching `X-Admin-Token` header. Returns
/// `true` on match; `false` on missing/mismatched header or when the env
/// var is unset (fails closed).
pub fn verify_admin_token(req: &HttpRequest) -> bool {
    let expected = match env::var("ADMIN_API_SECRET") {
        Ok(value) if !value.is_empty() => value,
        _ => {
            // No secret configured → reject every admin write.
            log::warn!(
                "ADMIN_API_SECRET is not set; rejecting admin request to {}",
                req.path()
            );
            return false;
        }
    };

    let Some(header_value) = req.headers().get("X-Admin-Token") else {
        return false;
    };
    let Ok(provided) = header_value.to_str() else {
        return false;
    };

    constant_time_eq(provided.as_bytes(), expected.as_bytes())
}

/// Constant-time byte comparison to avoid timing-side-channel leaks. Both
/// strings are checked for equal length and every byte is XOR'd.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
