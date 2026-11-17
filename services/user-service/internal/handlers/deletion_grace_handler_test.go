package handlers

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/atto-sound/user-service/internal/config"
	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/services"
)

// La app reconoce la cuenta en gracia por el 403 con este cuerpo exacto: el
// código, la fecha y el token de recuperar.
func TestPendingDeletionAnswers403WithDateAndToken(t *testing.T) {
	when := time.Date(2026, 12, 12, 10, 0, 0, 0, time.UTC)
	app := fiber.New()
	app.Get("/x", func(c *fiber.Ctx) error {
		err := &services.ErrAccountPendingDeletion{UserID: 281, Username: "westcol", ScheduledDeletionAt: when,
			RecoveryToken: "tok", AlsoRecovers: []string{"aramis"}}
		if done, werr := writePendingDeletion(c, err); done {
			return werr
		}
		return c.SendStatus(500)
	})
	app.Get("/y", func(c *fiber.Ctx) error {
		if done, werr := writePendingDeletion(c, errors.New("invalid credentials")); done {
			return werr
		}
		return c.SendStatus(401)
	})

	res, err := app.Test(httptest.NewRequest("GET", "/x", nil))
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}
	var body struct {
		Success bool   `json:"success"`
		Error   string `json:"error"`
		Data    struct {
			UserID              uint64    `json:"userId"`
			Username            string    `json:"username"`
			ScheduledDeletionAt time.Time `json:"scheduledDeletionAt"`
			RecoveryToken       string    `json:"recoveryToken"`
			AlsoRecovers        []string  `json:"alsoRecovers"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Success || body.Error != "account_pending_deletion" || body.Data.UserID != 281 || body.Data.Username != "westcol" ||
		!body.Data.ScheduledDeletionAt.Equal(when) || body.Data.RecoveryToken != "tok" || len(body.Data.AlsoRecovers) != 1 {
		t.Fatalf("body wrong: %+v", body)
	}

	res, _ = app.Test(httptest.NewRequest("GET", "/y", nil))
	if res.StatusCode != 401 {
		t.Fatalf("other errors must pass through, got %d", res.StatusCode)
	}
}

func TestRecoverAccountRejectsMissingAndBadTokens(t *testing.T) {
	jwtMgr := middleware.NewJWTManager(testJWTConfig())
	auth := services.NewAuthService(nil, jwtMgr, nil, "http://127.0.0.1:1")
	h := NewAuthHandler(auth)
	app := fiber.New()
	app.Post("/auth/login/recover", h.RecoverAccount)

	post := func(body string) int {
		req := httptest.NewRequest("POST", "/auth/login/recover", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode
	}
	if got := post(`{}`); got != 400 {
		t.Fatalf("missing token: %d, want 400", got)
	}
	if got := post(`{"recoveryToken":"basura"}`); got != 401 {
		t.Fatalf("garbage token: %d, want 401", got)
	}
	// Un token de sesión normal no sirve para recuperar.
	session, _ := jwtMgr.GenerateServiceToken(time.Minute)
	if got := post(`{"recoveryToken":"` + session + `"}`); got != 401 {
		t.Fatalf("service token accepted: %d, want 401", got)
	}
}

func TestAdminPendingDeletionsRouteAndFilter(t *testing.T) {
	f := accounts()
	app := fiber.New()
	h := NewAdminHandler(f)
	app.Get("/users/admin/pending-deletions", middleware.RequireAdminToken(testSecret), h.ListPendingDeletions)
	app.Get("/users/admin", middleware.RequireAdminToken(testSecret), h.ListUsers)

	get := func(target, tok string) int {
		req := httptest.NewRequest("GET", target, nil)
		if tok != "" {
			req.Header.Set(middleware.AdminTokenHeader, tok)
		}
		res, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode
	}
	if got := get("/users/admin/pending-deletions", ""); got != 401 {
		t.Fatalf("pending list without token: %d, want 401", got)
	}
	if got := get("/users/admin/pending-deletions", testSecret); got != 200 {
		t.Fatalf("pending list: %d, want 200", got)
	}
	if got := get("/users/admin?pendingDeletion=true", testSecret); got != 200 || f.listFilter.PendingDeletion == nil || !*f.listFilter.PendingDeletion {
		t.Fatalf("pendingDeletion filter not passed: %d %+v", got, f.listFilter)
	}
	if got := get("/users/admin?pendingDeletion=quizas", testSecret); got != 400 {
		t.Fatalf("bad filter: %d, want 400", got)
	}
}

func testJWTConfig() *config.Config {
	return &config.Config{JWTSecret: "test-secret", JWTAccessExpiry: 15 * time.Minute, JWTRefreshExpiry: time.Hour}
}
