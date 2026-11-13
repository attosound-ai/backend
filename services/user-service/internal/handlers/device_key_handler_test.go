package handlers

import (
	"bytes"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"

	"github.com/atto-sound/user-service/internal/config"
	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
)

const deviceTestSecret = "device-key-test-secret"

func deviceTestMgr() *middleware.JWTManager {
	return middleware.NewJWTManager(&config.Config{
		JWTSecret: deviceTestSecret, JWTAccessExpiry: 15 * time.Minute, JWTRefreshExpiry: time.Hour,
	})
}

// signed builds a token with the shared secret, like any token user-service
// issues (session, 2FA temporary, signup).
func signed(t *testing.T, sub, iss, scope string) string {
	t.Helper()
	now := time.Now()
	c := middleware.JWTClaims{
		UserID: sub,
		Scope:  scope,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject: sub, Issuer: iss,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		},
	}
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(deviceTestSecret))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// Only a real session may enroll a device key. The 2FA temporary token (the
// password alone) passes RequireAuth on main before the Nov 12 fix; if it
// could enroll a key, the second factor would be skipped for good.
func TestOnlyASessionEnrollsADeviceKey(t *testing.T) {
	mgr := deviceTestMgr()
	app := fiber.New()
	app.Post("/auth/devices", middleware.RequireAuth(mgr), func(c *fiber.Ctx) error {
		uid, ok := sessionClaims(c)
		if !ok {
			return unauthorized(c)
		}
		return c.SendString(strconv.FormatUint(uid, 10))
	})

	pair, err := mgr.GenerateTokenPair(&models.User{ID: 281, Username: "westcol"})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		token string
		ok    bool
	}{
		{"session", pair.AccessToken, true},
		{"2fa legacy", signed(t, "281", "atto-sound-2fa", ""), false},
		{"2fa current", signed(t, "2fa:281", "atto-sound-2fa", "2fa_pending"), false},
		{"2fa scope, session issuer", signed(t, "281", "atto-sound-user-service", "2fa_pending"), false},
		{"no scope", signed(t, "281", "atto-sound-user-service", ""), false},
		{"signup", signed(t, "signup:abc", "atto-sound-signup", "signup_pending"), false},
	}
	for _, tc := range cases {
		req := httptest.NewRequest("POST", "/auth/devices", bytes.NewReader([]byte("{}")))
		req.Header.Set("Authorization", "Bearer "+tc.token)
		req.Header.Set("Content-Type", "application/json")
		res, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		// 401 or 403 depending on whether the 2FA fix is merged; never 200.
		if got := res.StatusCode == 200; got != tc.ok {
			t.Fatalf("%s: status %d, want allowed=%v", tc.name, res.StatusCode, tc.ok)
		}
	}
}
