//! Which signed tokens are a session (Nov 12 2026).
//!
//! Every token user-service signs uses the shared secret, including the 2FA
//! temporary token it hands out after the password alone, before the second
//! factor. That one was accepted here as a session (no issuer check, no
//! expiry check), so the password alone reached the content endpoints. It
//! must only ever work on POST /auth/login/2fa.
//!
//! Pure, no dependencies, so the rule is tested with `rustc --test` too.

/// Issuer of the 2FA temporary token.
pub const ISSUER_TWO_FACTOR: &str = "atto-sound-2fa";
/// Scope the 2FA temporary token carries since Nov 12 2026.
pub const SCOPE_TWO_FACTOR_PENDING: &str = "2fa_pending";

/// True for the 2FA temporary token, old shape (only the issuer) or new
/// (issuer and scope). Such a token is never a session.
pub fn is_two_factor_pending(iss: Option<&str>, scope: Option<&str>) -> bool {
    iss == Some(ISSUER_TWO_FACTOR) || scope == Some(SCOPE_TWO_FACTOR_PENDING)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_and_current_two_factor_tokens_are_not_sessions() {
        assert!(is_two_factor_pending(Some("atto-sound-2fa"), None));
        assert!(is_two_factor_pending(Some("atto-sound-2fa"), Some("2fa_pending")));
        assert!(is_two_factor_pending(Some("atto-sound-user-service"), Some("2fa_pending")));
    }

    #[test]
    fn sessions_and_other_tokens_are_untouched() {
        assert!(!is_two_factor_pending(Some("atto-sound-user-service"), Some("user")));
        assert!(!is_two_factor_pending(Some("atto-sound-user-service"), None));
        assert!(!is_two_factor_pending(None, None));
        assert!(!is_two_factor_pending(Some("atto-sound-signup"), Some("signup_pending")));
    }
}
