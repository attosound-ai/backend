package middleware

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/atto-sound/user-service/internal/config"
	"github.com/gofiber/fiber/v2"
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

// Regression test for the post-deploy 500 panic: when the Authorization header
// is missing, RequireAuth must respond 401 and STOP — not fall through to
// claims.EffectiveScope() with a nil claims pointer. Previously extractClaims
// returned `nil, c.JSON(...)` and the caller compared the JSON-return
// (always nil on success) to nil, so the nil-check passed and the handler
// dereferenced nil claims.
func TestRequireAuth_MissingHeaderReturns401NotPanic(t *testing.T) {
	app := fiber.New()
	app.Get("/protected", RequireAuth(newTestMgr()), func(c *fiber.Ctx) error {
		return c.SendString("should not reach")
	})

	req := httptest.NewRequest("GET", "/protected", nil)
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("Test request: %v", err)
	}
	if resp.StatusCode != fiber.StatusUnauthorized {
		t.Fatalf("expected 401 without auth header, got %d", resp.StatusCode)
	}
}

func TestRequireAuth_MalformedHeaderReturns401NotPanic(t *testing.T) {
	app := fiber.New()
	app.Get("/protected", RequireAuth(newTestMgr()), func(c *fiber.Ctx) error {
		return c.SendString("should not reach")
	})

	req := httptest.NewRequest("GET", "/protected", nil)
	req.Header.Set("Authorization", "NotBearer xyz")
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("Test request: %v", err)
	}
	if resp.StatusCode != fiber.StatusUnauthorized {
		t.Fatalf("expected 401 for malformed header, got %d", resp.StatusCode)
	}
}

func TestRequireSignupScope_MissingHeaderReturns401NotPanic(t *testing.T) {
	app := fiber.New()
	app.Get("/signup", RequireSignupScope(newTestMgr()), func(c *fiber.Ctx) error {
		return c.SendString("should not reach")
	})

	req := httptest.NewRequest("GET", "/signup", nil)
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("Test request: %v", err)
	}
	if resp.StatusCode != fiber.StatusUnauthorized {
		t.Fatalf("expected 401 without auth header, got %d", resp.StatusCode)
	}
}

func TestRequireAuth_SignupTokenForbidden(t *testing.T) {
	mgr := newTestMgr()
	tok, _, err := mgr.GenerateSignupToken("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", time.Hour)
	if err != nil {
		t.Fatalf("issue signup token: %v", err)
	}

	app := fiber.New()
	app.Get("/protected", RequireAuth(mgr), func(c *fiber.Ctx) error {
		return c.SendString("ok")
	})

	req := httptest.NewRequest("GET", "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("Test request: %v", err)
	}
	if resp.StatusCode != fiber.StatusForbidden {
		t.Fatalf("expected 403 for signup token on user route, got %d", resp.StatusCode)
	}
}
