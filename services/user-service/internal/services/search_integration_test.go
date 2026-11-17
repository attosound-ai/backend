//go:build integration

package services

// /users/search against a real Postgres (Nov 12 2026): wildcards are literal,
// at most 20 rows, and the anonymous lookup is one exact username.
//   USER_SERVICE_TEST_DSN="host=/tmp port=55433 user=postgres dbname=atto_users_test sslmode=disable" \
//     go test -tags integration ./internal/services -run IntegrationSearch

import (
	"context"
	"fmt"
	"testing"

	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
)

func TestIntegrationSearchCannotCopyTheDirectory(t *testing.T) {
	db := integrationDB(t)
	names := []string{"attosound", "alpha", "beta_x", "zz", "xuser", "user"}
	for i := 0; i < 25; i++ {
		names = append(names, fmt.Sprintf("user%02d", i))
	}
	for _, n := range names {
		if err := db.Create(&models.User{Username: n, DisplayName: n, Role: models.RoleListener}).Error; err != nil {
			t.Fatal(err)
		}
	}
	svc := NewUserService(repositories.NewUserRepository(db), nil)
	ctx := context.Background()

	count := func(q string) int {
		t.Helper()
		rows, err := svc.SearchUsers(ctx, q, 100)
		if err != nil {
			t.Fatal(err)
		}
		return len(rows)
	}
	for _, q := range []string{"__", "%%", "_%", `\_`, "_", "%", " a "} {
		if n := count(q); n != 0 {
			t.Errorf("q=%q answered %d rows, want 0", q, n)
		}
	}
	if n := count("a_"); n != 1 {
		t.Errorf("q=a_ (literal, beta_x) answered %d rows, want 1", n)
	}
	if n := count("user"); n != 20 {
		t.Errorf("q=user answered %d rows, want 20", n)
	}
	rows, _ := svc.SearchUsers(ctx, "user", 20)
	if len(rows) == 0 || rows[0].Username != "user" {
		t.Errorf("the exact username is not first: %v", rows)
	}

	exact, err := svc.SearchUsersExact(ctx, "ATTOSOUND")
	if err != nil || len(exact) != 1 || exact[0].Username != "attosound" {
		t.Errorf("exact lookup: %v %v", exact, err)
	}
	for _, q := range []string{"atto", "_ttosound", "%", "attosound%"} {
		if rows, _ := svc.SearchUsersExact(ctx, q); len(rows) != 0 {
			t.Errorf("exact lookup %q answered %d rows", q, len(rows))
		}
	}
}
