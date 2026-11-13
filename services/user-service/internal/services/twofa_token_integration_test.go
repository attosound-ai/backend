//go:build integration

package services

// The 2FA temporary token against a real database (same scratch Postgres as
// deletion_integration_test.go):
//   USER_SERVICE_TEST_DSN="host=127.0.0.1 port=55471 user=postgres dbname=atto_users_test sslmode=disable" \
//     go test -tags integration ./internal/services -run IntegrationTwoFactor

import (
	"context"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/atto-sound/user-service/internal/config"
	"github.com/atto-sound/user-service/internal/kafka"
	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
)

// Password only, 2FA on: the login answers with a temporary token. Until
// Nov 12 2026 that token, sent to /auth/refresh, came back as a full session
// pair, so the second factor could be skipped entirely.
func TestIntegrationTwoFactorTokenCannotBeRefreshedIntoASession(t *testing.T) {
	db := integrationDB(t)
	db.Exec("TRUNCATE user_credentials")
	email := "qa_2fa@example.invalid"
	u := &models.User{Username: "qa_2fa", DisplayName: "QA", Email: &email, Role: models.RoleListener}
	if err := db.Create(u).Error; err != nil {
		t.Fatal(err)
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte("contrasena-larga"), bcrypt.MinCost)
	db.Create(&models.UserCredentials{UserID: u.ID, PasswordHash: string(hash), TwoFactorEnabled: true, TwoFactorMethod: "email"})

	jwtMgr := middleware.NewJWTManager(&config.Config{JWTSecret: "test-secret", JWTAccessExpiry: 15 * time.Minute, JWTRefreshExpiry: time.Hour})
	auth := NewAuthService(repositories.NewUserRepository(db), jwtMgr, kafka.NewProducer("127.0.0.1:1"), "http://127.0.0.1:1")

	res, err := auth.Login(context.Background(), &models.LoginRequest{Identifier: "qa_2fa", Password: "contrasena-larga"})
	if err != nil {
		t.Fatal(err)
	}
	pending, ok := res.(*models.Login2FAResponse)
	if !ok || !pending.Requires2FA || pending.TempToken == "" {
		t.Fatalf("2FA account must get a temporary token, got %+v", res)
	}
	if _, err := auth.RefreshToken(context.Background(), pending.TempToken); err == nil {
		t.Fatal("the 2FA temporary token was exchanged for a session at /auth/refresh")
	}

	// A real session still refreshes.
	db.Model(&models.UserCredentials{}).Where("user_id = ?", u.ID).Update("two_factor_enabled", false)
	res, err = auth.Login(context.Background(), &models.LoginRequest{Identifier: "qa_2fa", Password: "contrasena-larga"})
	if err != nil {
		t.Fatal(err)
	}
	session := res.(*models.AuthResponse)
	if _, err := auth.RefreshToken(context.Background(), session.Tokens.RefreshToken); err != nil {
		t.Fatalf("a normal refresh token stopped working: %v", err)
	}
}
