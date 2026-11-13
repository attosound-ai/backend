package services

import (
	"strconv"
	"time"

	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
)

// IssueSession opens a session for an account that just proved who it is
// some other way than the password (a remembered device key, Nov 12 2026).
// Same rules as the password login: an account in its deletion grace gets
// ErrAccountPendingDeletion (the recover screen), never a session.
func (s *AuthService) IssueSession(user *models.User) (*models.AuthResponse, error) {
	return s.sessionFor(user)
}

// deviceKeyRevoker is the part of DeviceKeyService that AuthService calls.
type deviceKeyRevoker interface {
	RevokeAllForUser(userID uint64, reason string)
}

// SetDeviceKeys lets password and 2FA changes end the remembered devices.
func (s *AuthService) SetDeviceKeys(r deviceKeyRevoker) { s.deviceKeys = r }

func (s *AuthService) revokeDeviceKeys(userID uint64, reason string) {
	if s.deviceKeys != nil {
		s.deviceKeys.RevokeAllForUser(userID, reason)
	}
}

// ResetSessionCutoff is the sessions_valid_after a password reset at now
// writes: every token issued in an earlier second is closed. JWT iat counts
// whole seconds and RefreshToken closes iat <= cutoff, so the cut is the
// second before the reset; the fresh session issued right after it (same
// second) stays valid. A token minted in that same second just before the
// reset survives too: a one second window, accepted.
func ResetSessionCutoff(now time.Time) time.Time {
	return time.Unix(now.Unix()-1, 0).UTC()
}

// SessionStillOpen says whether the session behind these (already verified)
// claims was not closed since it was issued, and the account is not in its
// deletion grace. RequireAuth stays stateless (access tokens end on their
// own within 15 minutes), but a route that MINTS new tokens must check it:
// otherwise a stolen access token could trade its last minutes, after a
// password reset, for a fresh 7 day session (POST /auth/switch-account to
// itself is allowed and re-issues tokens).
func (s *AuthService) SessionStillOpen(claims *middleware.JWTClaims) bool {
	if claims == nil {
		return false
	}
	uid, err := strconv.ParseUint(claims.UserID, 10, 64)
	if err != nil {
		return false
	}
	user, err := s.repo.FindByID(uid)
	if err != nil || user == nil || user.IsDeactivated() {
		return false
	}
	return !sessionRevoked(claims.IssuedAt, user.SessionsValidAfter)
}
