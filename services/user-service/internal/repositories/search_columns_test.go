package repositories

import (
	"context"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// sqlCapture keeps the SQL gorm builds; with DryRun nothing reaches a server.
type sqlCapture struct {
	logger.Interface
	sql []string
}

func (s *sqlCapture) LogMode(logger.LogLevel) logger.Interface { return s }
func (s *sqlCapture) Trace(_ context.Context, _ time.Time, fc func() (string, int64), _ error) {
	q, _ := fc()
	s.sql = append(s.sql, q)
}

func dryRunRepo(t *testing.T) (*UserRepository, *sqlCapture) {
	t.Helper()
	capture := &sqlCapture{Interface: logger.Discard}
	db, err := gorm.Open(postgres.New(postgres.Config{
		DSN: "host=127.0.0.1 port=1 user=nobody dbname=nothing sslmode=disable",
	}), &gorm.Config{DryRun: true, DisableAutomaticPing: true, Logger: capture})
	if err != nil {
		t.Fatalf("dry run db: %v", err)
	}
	return NewUserRepository(db), capture
}

// GET /users/search is open without a session and answers with usernames.
// Matching email or phone told anyone which account owns an email or a phone
// (Nov 12 2026).
func TestSearchUsersNeverMatchesEmailOrPhone(t *testing.T) {
	repo, capture := dryRunRepo(t)
	if _, err := repo.SearchUsers("@example.com", 20); err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(capture.sql) == 0 {
		t.Fatal("no SQL captured")
	}
	q := strings.ToLower(strings.Join(capture.sql, "\n"))
	for _, col := range []string{"email", "phone", "inmate", "date_of_birth"} {
		if strings.Contains(q, col) {
			t.Errorf("search matches %s: %s", col, q)
		}
	}
	if !strings.Contains(q, "username ilike") {
		t.Errorf("search lost the username match: %s", q)
	}
}
