package handlers

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/atto-sound/user-service/internal/config"
	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

// internalRoutesApp mounts the routes exactly as cmd/server/main.go does.
func internalRoutesApp(t *testing.T) (*fiber.App, *middleware.JWTManager) {
	t.Helper()
	mgr := middleware.NewJWTManager(&config.Config{
		JWTSecret: "test-secret-please-ignore", JWTAccessExpiry: 15 * time.Minute, JWTRefreshExpiry: time.Hour,
	})
	h := &UserHandler{profiles: newFakeProfiles()}
	app := fiber.New()
	users := app.Group("/users")
	users.Get("/:id", middleware.OptionalAuth(mgr), h.GetUser)
	h.MountInternalRoutes(users, middleware.RequireInternalCallerOrOwner(mgr, "id"))
	return app, mgr
}

// telephonyToken mirrors what telephony-service signs per request.
func telephonyToken(t *testing.T) string {
	t.Helper()
	now := time.Now()
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, middleware.JWTClaims{
		UserID: "service:telephony-service",
		Scope:  middleware.ScopeService,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    middleware.TelephonyServiceTokenIssuer,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Minute)),
		},
	}).SignedString([]byte("test-secret-please-ignore"))
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func get(t *testing.T, app *fiber.App, target, token string) (int, string) {
	t.Helper()
	req := httptest.NewRequest("GET", target, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

// The Nov 12 2026 hole: both routes answered without a session. Fiber routes
// are case insensitive and tolerate a trailing slash, so those spellings are
// covered too (Kong's regex alone did not catch PUSH-TOKENS).
func TestInternalRoutes_AnonymousGetsNothing(t *testing.T) {
	app, _ := internalRoutesApp(t)
	for _, target := range []string{
		"/users/7/push-tokens",
		"/users/7/linked-account-ids",
		"/users/7/PUSH-TOKENS",
		"/users/7/Linked-Account-Ids",
		"/users/7/push-tokens/",
		"/users/999999999/push-tokens",
	} {
		code, body := get(t, app, target, "")
		if code != fiber.StatusUnauthorized {
			t.Errorf("%s: got %d, want 401", target, code)
		}
		if strings.Contains(body, "ExponentPushToken") || strings.Contains(body, "userIds") {
			t.Errorf("%s leaked data: %s", target, body)
		}
	}
}

func TestInternalRoutes_StrangerSessionGetsNothing(t *testing.T) {
	app, mgr := internalRoutesApp(t)
	tok := tokenFor(t, mgr, strangerID)
	for _, target := range []string{"/users/7/push-tokens", "/users/7/linked-account-ids"} {
		if code, body := get(t, app, target, tok); code != fiber.StatusForbidden {
			t.Errorf("%s: got %d (%s), want 403", target, code, body)
		}
	}
}

func TestInternalRoutes_TelephonyKeepsWorking(t *testing.T) {
	app, _ := internalRoutesApp(t)
	tok := telephonyToken(t)

	code, body := get(t, app, "/users/7/push-tokens", tok)
	if code != 200 {
		t.Fatalf("push-tokens: got %d (%s)", code, body)
	}
	var tokens struct {
		Data struct {
			Tokens []struct{ Token, Platform, DeviceID string } `json:"tokens"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &tokens); err != nil || len(tokens.Data.Tokens) != 1 || tokens.Data.Tokens[0].Token == "" {
		t.Fatalf("push-tokens shape changed: %s", body)
	}

	code, body = get(t, app, "/users/7/linked-account-ids", tok)
	if code != 200 || !strings.Contains(body, `"userIds"`) {
		t.Fatalf("linked-account-ids: got %d (%s)", code, body)
	}
}

func TestInternalRoutes_OwnerMayReadOwn(t *testing.T) {
	app, mgr := internalRoutesApp(t)
	tok := tokenFor(t, mgr, strangerID)
	if code, body := get(t, app, "/users/"+itoa(strangerID)+"/push-tokens", tok); code != 200 {
		t.Fatalf("owner reading own tokens: got %d (%s)", code, body)
	}
}

// The public profile next to them is unchanged.
func TestInternalRoutes_PublicProfileStillOpen(t *testing.T) {
	app, _ := internalRoutesApp(t)
	if code, body := get(t, app, "/users/"+itoa(strangerID), ""); code != 200 {
		t.Fatalf("public profile: got %d (%s)", code, body)
	}
}

func itoa(n uint64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
