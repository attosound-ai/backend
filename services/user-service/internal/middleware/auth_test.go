package middleware

import (
	"testing"
	"time"

	"github.com/atto-sound/user-service/internal/config"
)

func newTestMgr() *JWTManager {
	return NewJWTManager(&config.Config{
		JWTSecret:        "test-secret-please-ignore",
		JWTAccessExpiry:  15 * time.Minute,
		JWTRefreshExpiry: 24 * time.Hour,
	})
}

// Tokens issued before the scope claim existed (older deployments) must still
// authenticate as ScopeUser. This is what keeps the 15 completed users on the
// app working during the cutover without forcing them to re-login.
func TestEffectiveScope_DefaultsToUser(t *testing.T) {
	c := &JWTClaims{}
	if got := c.EffectiveScope(); got != ScopeUser {
		t.Fatalf("missing scope claim should default to %q, got %q", ScopeUser, got)
	}
}

func TestEffectiveScope_RespectsClaim(t *testing.T) {
	c := &JWTClaims{Scope: ScopeSignupPending}
	if got := c.EffectiveScope(); got != ScopeSignupPending {
		t.Fatalf("explicit scope should be returned, got %q", got)
	}
}

func TestGenerateSignupToken_RoundTrip(t *testing.T) {
	mgr := newTestMgr()
	sessionID := "11111111-2222-3333-4444-555555555555"

	tok, ttl, err := mgr.GenerateSignupToken(sessionID, 24*time.Hour)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	if ttl != int64((24 * time.Hour).Seconds()) {
		t.Fatalf("ttl mismatch: got %d", ttl)
	}

	claims, err := mgr.ValidateToken(tok)
	if err != nil {
		t.Fatalf("validate token: %v", err)
	}
	if claims.EffectiveScope() != ScopeSignupPending {
		t.Fatalf("expected signup_pending scope, got %q", claims.EffectiveScope())
	}
	if claims.Issuer != "atto-sound-signup" {
		t.Fatalf("expected signup issuer, got %q", claims.Issuer)
	}
	if got := SignupSessionID(claims); got != sessionID {
		t.Fatalf("SignupSessionID extraction failed: got %q want %q", got, sessionID)
	}
}

func TestSignupSessionID_RejectsNonSignupSubject(t *testing.T) {
	c := &JWTClaims{UserID: "1234"} // numeric user ID, not "signup:<uuid>"
	if got := SignupSessionID(c); got != "" {
		t.Fatalf("non-signup subject should yield empty string, got %q", got)
	}
}
