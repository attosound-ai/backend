//! Who owns a Cloudinary upload (Nov 12 2026).
//!
//! DELETE /api/v1/media/{id} used to destroy any asset for any signed in
//! user: nothing tied an upload to the account that made it. Now the signer
//! writes the owner into the public_id it signs ("content_<uuid>_u281").
//! Cloudinary only accepts the public_id that was signed, so nobody can mint
//! an asset carrying someone else's id. Assets signed before this change, and
//! signup avatars (no account yet), carry no owner: only the operator of the
//! panel (X-Admin-Token) can delete those.
//!
//! Pure, no dependencies, so it is tested with `rustc --test` too.

/// Marker between the random part and the owner's user id.
const OWNER_MARK: &str = "_u";

/// The public_id to sign. `owner` is the numeric user id of a signed in
/// account; anything else (a signup session) signs without an owner.
pub fn owned_public_id(context: &str, short_uuid: &str, owner: Option<&str>) -> String {
    match owner.filter(|o| is_user_id(o)) {
        Some(o) => format!("{}_{}{}{}", context, short_uuid, OWNER_MARK, o),
        None => format!("{}_{}", context, short_uuid),
    }
}

/// The owner written in a public_id (with or without its folder path).
pub fn media_owner(public_id: &str) -> Option<&str> {
    let name = public_id.rsplit('/').next().unwrap_or(public_id);
    let (_, owner) = name.rsplit_once(OWNER_MARK)?;
    if is_user_id(owner) {
        Some(owner)
    } else {
        None
    }
}

/// Only the owner of the asset, or the operator, may delete it.
pub fn can_delete_media(public_id: &str, caller: Option<&str>, is_operator: bool) -> bool {
    if is_operator {
        return true;
    }
    match (media_owner(public_id), caller) {
        (Some(owner), Some(me)) => owner == me,
        _ => false,
    }
}

fn is_user_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_ids_carry_their_owner() {
        let id = owned_public_id("content", "a1b2c3d4e5f6", Some("281"));
        assert_eq!(id, "content_a1b2c3d4e5f6_u281");
        assert_eq!(media_owner(&id), Some("281"));
        assert_eq!(media_owner(&format!("atto/content/{}", id)), Some("281"));
    }

    #[test]
    fn signup_and_legacy_ids_have_no_owner() {
        let signup = owned_public_id("avatar", "a1b2c3d4e5f6", Some("11111111-2222-3333-4444-555555555555"));
        assert_eq!(signup, "avatar_a1b2c3d4e5f6");
        assert_eq!(owned_public_id("chat", "a1b2c3d4e5f6", None), "chat_a1b2c3d4e5f6");
        assert_eq!(media_owner("atto/chat/chat_a1b2c3d4e5f6"), None);
        // A random part that happens to contain "_u" followed by letters.
        assert_eq!(media_owner("content_ab_uxyz"), None);
    }

    #[test]
    fn only_the_owner_or_the_operator_deletes() {
        let mine = "atto/content/content_a1b2c3d4e5f6_u281";
        assert!(can_delete_media(mine, Some("281"), false));
        // Before Nov 12 2026 any signed in account could do this:
        assert!(!can_delete_media(mine, Some("280"), false));
        assert!(!can_delete_media(mine, None, false));
        // Assets without an owner: operator only.
        assert!(!can_delete_media("atto/avatars/avatar_a1b2c3d4e5f6", Some("281"), false));
        assert!(can_delete_media("atto/avatars/avatar_a1b2c3d4e5f6", None, true));
        assert!(can_delete_media(mine, None, true));
    }
}
