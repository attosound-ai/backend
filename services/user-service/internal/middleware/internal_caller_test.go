package middleware

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/atto-sound/user-service/internal/config"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

const victimID = 42

func internalApp(mgr *JWTManager) *fiber.App {
	app := fiber.New()
	app.Get("/users/:id/push-tokens", RequireInternalCallerOrOwner(mgr, "id"), func(c *fiber.Ctx) error {
		return c.SendString("tokens")
	})
	return app
}

func statusFor(t *testing.T, app *fiber.App, target, authHeader string) int {
	t.Helper()
	req := httptest.NewRequest("GET", target, nil)
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("request %s: %v", target, err)
	}
	return resp.StatusCode
}

// signRaw signs arbitrary claims with the test secret, to forge tokens the
// service itself never issues.
func signRaw(t *testing.T, secret string, claims JWTClaims) string {
	t.Helper()
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func serviceClaims(issuer string, life time.Duration) JWTClaims {
	now := time.Now()
	return JWTClaims{
		UserID: "service:telephony-service",
		Scope:  ScopeService,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(life)),
		},
	}
}

func userToken(t *testing.T, mgr *JWTManager, id uint64) string {
	t.Helper()
	pair, err := mgr.GenerateTokenPair(&models.User{ID: id, Username: "u", Role: models.RoleCreator})
	if err != nil {
		t.Fatal(err)
	}
	return pair.AccessToken
}

const testSecret = "test-secret-please-ignore"

func TestInternalCaller_Allows(t *testing.T) {
	mgr := newTestMgr()
	app := internalApp(mgr)
	own, _ := mgr.GenerateServiceToken(time.Minute)

	cases := map[string]string{
		"telephony service token": signRaw(t, testSecret, serviceClaims(TelephonyServiceTokenIssuer, time.Minute)),
		"user-service own token":  own,
		"owner session":           userToken(t, mgr, victimID),
	}
	for name, tok := range cases {
		if got := statusFor(t, app, "/users/42/push-tokens", "Bearer "+tok); got != 200 {
			t.Errorf("%s: got %d, want 200", name, got)
		}
	}
}

func TestInternalCaller_RejectsAnonymousAndForged(t *testing.T) {
	mgr := newTestMgr()
	app := internalApp(mgr)

	cases := map[string]string{
		"no header":       "",
		"empty bearer":    "Bearer ",
		"basic auth":      "Basic dXNlcjpwYXNz",
		"garbage":         "Bearer not-a-jwt",
		"wrong secret":    "Bearer " + signRaw(t, "another-secret", serviceClaims(TelephonyServiceTokenIssuer, time.Minute)),
		"expired service": "Bearer " + signRaw(t, testSecret, serviceClaims(TelephonyServiceTokenIssuer, -time.Second)),
		"alg none":        "Bearer eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJzZXJ2aWNlOngiLCJzY29wZSI6InNlcnZpY2UifQ.",
	}
	for name, h := range cases {
		if got := statusFor(t, app, "/users/42/push-tokens", h); got != fiber.StatusUnauthorized {
			t.Errorf("%s: got %d, want 401", name, got)
		}
	}
}

func TestInternalCaller_RejectsValidButNotAllowed(t *testing.T) {
	mgr := newTestMgr()
	app := internalApp(mgr)

	signup, _, _ := mgr.GenerateSignupToken("11111111-2222-3333-4444-555555555555", time.Hour)
	twoFA, _ := mgr.Generate2FAToken(victimID)

	noExp := serviceClaims(TelephonyServiceTokenIssuer, time.Minute)
	noExp.ExpiresAt = nil
	userSubject := serviceClaims(TelephonyServiceTokenIssuer, time.Minute)
	userSubject.UserID = "42"

	cases := map[string]string{
		"another user's session":   userToken(t, mgr, victimID+1),
		"signup token":             signup,
		"2FA temp token of owner":  twoFA,
		"unknown service issuer":   signRaw(t, testSecret, serviceClaims("atto-sound-somebody-else", time.Minute)),
		"long lived service token": signRaw(t, testSecret, serviceClaims(TelephonyServiceTokenIssuer, time.Hour)),
		"service token, no exp":    signRaw(t, testSecret, noExp),
		"service token, user sub":  signRaw(t, testSecret, userSubject),
	}
	for name, tok := range cases {
		if got := statusFor(t, app, "/users/42/push-tokens", "Bearer "+tok); got != fiber.StatusForbidden {
			t.Errorf("%s: got %d, want 403", name, got)
		}
	}
}

// The owner check compares numbers, so a zero padded or non numeric path id
// never matches somebody else's session by string tricks.
func TestInternalCaller_OwnerPathMustBeTheSameNumber(t *testing.T) {
	mgr := newTestMgr()
	app := internalApp(mgr)
	tok := userToken(t, mgr, victimID)

	if got := statusFor(t, app, "/users/042/push-tokens", "Bearer "+tok); got != 200 {
		t.Errorf("zero padded own id: got %d, want 200", got)
	}
	for _, target := range []string{"/users/43/push-tokens", "/users/me/push-tokens", "/users/0/push-tokens"} {
		if got := statusFor(t, app, target, "Bearer "+tok); got != fiber.StatusForbidden {
			t.Errorf("%s: got %d, want 403", target, got)
		}
	}
}

// A different JWT secret configured on the service must not accept tokens
// signed with the default one: the check is the signature, not the shape.
func TestInternalCaller_DefaultSecretTokenRefusedByRealSecret(t *testing.T) {
	mgr := NewJWTManager(&config.Config{JWTSecret: "the-real-production-like-secret", JWTAccessExpiry: time.Minute, JWTRefreshExpiry: time.Hour})
	app := internalApp(mgr)
	forged := signRaw(t, "change-me-in-production", serviceClaims(TelephonyServiceTokenIssuer, time.Minute))
	if got := statusFor(t, app, "/users/42/push-tokens", "Bearer "+forged); got != fiber.StatusUnauthorized {
		t.Fatalf("token signed with the default secret: got %d, want 401", got)
	}
}
