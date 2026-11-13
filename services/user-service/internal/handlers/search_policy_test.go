package handlers

// GET /users/search could copy the directory (Nov 12 2026): q=_ matched every
// account, with or without a session, and limit went up to 100. Without a
// session the route now answers one exact username; with one, at most 20.

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
)

// searchSpy answers far more rows than allowed, to prove the handler caps them.
type searchSpy struct {
	*fakeProfiles
	listCalls  []int
	exactCalls []string
}

func (s *searchSpy) SearchUsers(_ context.Context, _ string, limit int) ([]*models.UserProfile, error) {
	s.listCalls = append(s.listCalls, limit)
	return manyProfiles(50), nil
}

func (s *searchSpy) SearchUsersExact(_ context.Context, q string) ([]*models.UserProfile, error) {
	s.exactCalls = append(s.exactCalls, q)
	return manyProfiles(3), nil
}

func manyProfiles(n int) []*models.UserProfile {
	out := make([]*models.UserProfile, 0, n)
	for i := 0; i < n; i++ {
		id := uint64(1000 + i)
		out = append(out, &models.UserProfile{ID: id, Username: "user" + strconv.Itoa(i), Role: "listener"})
	}
	return out
}

func searchApp(t *testing.T) (*fiber.App, *middleware.JWTManager, *searchSpy) {
	t.Helper()
	_, mgr := projectionApp(t)
	spy := &searchSpy{fakeProfiles: newFakeProfiles()}
	h := &UserHandler{profiles: spy}
	app := fiber.New()
	app.Get("/users/search", middleware.OptionalAuth(mgr), h.SearchUsers)
	return app, mgr, spy
}

func countRows(t *testing.T, app *fiber.App, target, token string) int {
	t.Helper()
	return len(rowsByID(t, call(t, app, target, token)))
}

func TestSearchWithoutSessionOnlyExactUsernameAndOneRow(t *testing.T) {
	app, _, spy := searchApp(t)
	for _, q := range []string{"_", "%25", "attosound", "ab"} {
		if n := countRows(t, app, "/users/search?limit=100&q="+q, ""); n > 1 {
			t.Errorf("q=%s without a session answered %d rows, want at most 1", q, n)
		}
	}
	if len(spy.listCalls) != 0 {
		t.Errorf("search without a session ran the list search %d times", len(spy.listCalls))
	}
	if strings.Join(spy.exactCalls, ",") != "_,%,attosound,ab" {
		t.Errorf("exact lookups: %v", spy.exactCalls)
	}
}

func TestSearchWithSessionAtMostTwenty(t *testing.T) {
	app, mgr, spy := searchApp(t)
	tok := tokenFor(t, mgr, strangerID)
	for target, wantLimit := range map[string]int{
		"/users/search?q=ab":           20,
		"/users/search?q=ab&limit=100": 20,
		"/users/search?q=ab&limit=21":  20,
		"/users/search?q=ab&limit=5":   5,
		"/users/search?q=ab&limit=-3":  20,
	} {
		spy.listCalls = nil
		n := countRows(t, app, target, tok)
		if n > wantLimit {
			t.Errorf("%s answered %d rows, want at most %d", target, n, wantLimit)
		}
		if len(spy.listCalls) != 1 || spy.listCalls[0] != wantLimit {
			t.Errorf("%s asked the service for %v, want [%d]", target, spy.listCalls, wantLimit)
		}
	}
	if len(spy.exactCalls) != 0 {
		t.Errorf("a signed in search used the exact lookup")
	}
}
