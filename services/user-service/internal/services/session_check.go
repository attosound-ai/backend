package services

import (
	"strconv"
	"time"

	"github.com/atto-sound/user-service/internal/middleware"
)

// ExpiredSessionGrace mirrors telephony's EXPIRED_GRACE_S: past it an
// expired token is refused without asking anything.
const ExpiredSessionGrace = 30 * 24 * time.Hour

// SessionCheck is the answer of POST /auth/session-check.
type SessionCheck struct {
	Valid  bool   `json:"valid"`
	UserID string `json:"userId,omitempty"`
	// Reason when not valid: invalid_token, not_a_session, too_old,
	// user_not_found, pending_deletion, session_revoked.
	Reason string `json:"reason,omitempty"`
}

// CheckSession says whether a session token, expired or not, still belongs
// to an open session: signed by us, a full session (not 2FA, signup or
// service), not past the grace, the account alive and out of its deletion
// grace, and issued after the last "close every session" (password reset,
// deletion request). Telephony asks it before honouring an expired token,
// so a reset reaches the VoIP path too, not only the refresh.
func (s *AuthService) CheckSession(token string, now time.Time) SessionCheck {
	claims, err := s.jwtMgr.ParseIgnoringExpiry(token)
	if err != nil {
		return SessionCheck{Reason: "invalid_token"}
	}
	if !middleware.IsSessionToken(claims) {
		return SessionCheck{Reason: "not_a_session"}
	}
	if claims.ExpiresAt != nil && now.Sub(claims.ExpiresAt.Time) > ExpiredSessionGrace {
		return SessionCheck{Reason: "too_old"}
	}
	uid, err := strconv.ParseUint(claims.UserID, 10, 64)
	if err != nil {
		return SessionCheck{Reason: "not_a_session"}
	}
	user, err := s.repo.FindByID(uid)
	if err != nil || user == nil {
		return SessionCheck{Reason: "user_not_found"}
	}
	if user.IsDeactivated() {
		return SessionCheck{Reason: "pending_deletion"}
	}
	if sessionRevoked(claims.IssuedAt, user.SessionsValidAfter) {
		return SessionCheck{Reason: "session_revoked"}
	}
	return SessionCheck{Valid: true, UserID: claims.UserID}
}
