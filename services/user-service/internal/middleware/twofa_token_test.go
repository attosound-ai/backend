package middleware

import (
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"

	"github.com/atto-sound/user-service/internal/models"
)

// The 2FA temporary token is handed out after the password alone. Until
// Nov 12 2026 it carried a numeric sub and no scope, so RequireAuth read it
// as a full session: password only, no second factor, and /auth/me (and every
// other route) answered 200 for 5 minutes. It must only ever work on
// POST /auth/login/2fa.

// legacy2FAToken builds the token exactly as Generate2FAToken did before the
// fix (still in flight on any phone mid login during the deploy).
func legacy2FAToken(t *testing.T, m *JWTManager, userID uint64) string {
	t.Helper()
	now := time.Now()
	id := strconv.FormatUint(userID, 10)
	claims := JWTClaims{
		UserID: id,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   id,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
			Issuer:    "atto-sound-2fa",
		},
	}
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(m.secret)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func meApp(m *JWTManager) *fiber.App {
	app := fiber.New()
	app.Get("/auth/me", RequireAuth(m), func(c *fiber.Ctx) error { return c.SendString("session") })
	app.Get("/users/search", OptionalAuth(m), func(c *fiber.Ctx) error {
		if c.Locals("userID") != nil {
			return c.SendString("signed in")
		}
		return c.SendString("anonymous")
	})
	return app
}

func call(t *testing.T, app *fiber.App, path, token string) (int, string) {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	n, _ := res.Body.Read(buf)
	return res.StatusCode, string(buf[:n])
}

func TestTwoFactorTokenIsNeverASession(t *testing.T) {
	m := newTestMgr()
	app := meApp(m)
	fresh, err := m.Generate2FAToken(281)
	if err != nil {
		t.Fatal(err)
	}
	for name, tok := range map[string]string{"legacy": legacy2FAToken(t, m, 281), "current": fresh} {
		if code, _ := call(t, app, "/auth/me", tok); code != 401 {
			t.Fatalf("%s 2FA token on /auth/me: status %d, want 401", name, code)
		}
		if _, body := call(t, app, "/users/search", tok); body != "anonymous" {
			t.Fatalf("%s 2FA token must not sign in an optional auth route, got %q", name, body)
		}
	}
}

func TestNormalSessionStillWorks(t *testing.T) {
	m := newTestMgr()
	pair, err := m.GenerateTokenPair(&testUser)
	if err != nil {
		t.Fatal(err)
	}
	if code, body := call(t, meApp(m), "/auth/me", pair.AccessToken); code != 200 || body != "session" {
		t.Fatalf("access token: %d %q", code, body)
	}
}

// The second step of the login keeps working with both shapes, so a phone
// that got its temp token from the old build finishes its login.
func TestValidate2FATokenAcceptsLegacyAndCurrent(t *testing.T) {
	m := newTestMgr()
	fresh, _ := m.Generate2FAToken(281)
	for name, tok := range map[string]string{"legacy": legacy2FAToken(t, m, 281), "current": fresh} {
		claims, err := m.Validate2FAToken(tok)
		if err != nil || claims.UserID != "281" {
			t.Fatalf("%s: Validate2FAToken = %+v, %v; want user 281", name, claims, err)
		}
	}
	pair, _ := m.GenerateTokenPair(&testUser)
	if _, err := m.Validate2FAToken(pair.AccessToken); err == nil {
		t.Fatal("an access token passed as a 2FA token")
	}
}

func TestIsSessionToken(t *testing.T) {
	m := newTestMgr()
	pair, _ := m.GenerateTokenPair(&testUser)
	fresh, _ := m.Generate2FAToken(281)
	cases := map[string]bool{pair.AccessToken: true, pair.RefreshToken: true, fresh: false, legacy2FAToken(t, m, 1): false}
	for tok, want := range cases {
		claims, err := m.ValidateToken(tok)
		if err != nil {
			t.Fatal(err)
		}
		if got := IsSessionToken(claims); got != want {
			t.Fatalf("IsSessionToken = %v, want %v (iss %q scope %q)", got, want, claims.Issuer, claims.Scope)
		}
	}
}

var testUser = models.User{ID: 281, Username: "westcol", Role: models.RoleListener}
