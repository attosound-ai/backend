package handlers

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
)

type fakeAccounts struct {
	profiles    map[string]*models.UserProfile
	deleteErr   error
	deletedID   uint64
	deletedLink bool
	deleteCalls int
}

func (f *fakeAccounts) GetUserByID(_ context.Context, id string) (*models.UserProfile, error) {
	p, ok := f.profiles[id]
	if !ok {
		return nil, errors.New("user not found")
	}
	return p, nil
}

func (f *fakeAccounts) DeleteAccount(_ context.Context, userID uint64, deleteLinked bool) error {
	f.deleteCalls++
	f.deletedID = userID
	f.deletedLink = deleteLinked
	return f.deleteErr
}

const testSecret = "s3cret-operator-token"

func newAdminApp(f *fakeAccounts, secret string) *fiber.App {
	app := fiber.New()
	h := NewAdminHandler(f)
	app.Delete("/users/admin/:id", middleware.RequireAdminToken(secret), h.DeleteUser)
	return app
}

func accounts() *fakeAccounts {
	return &fakeAccounts{profiles: map[string]*models.UserProfile{
		"266": {ID: 266, Username: "arami"},
		"267": {ID: 267, Username: "aramis"},
	}}
}

func do(t *testing.T, app *fiber.App, target, token string) int {
	t.Helper()
	req := httptest.NewRequest("DELETE", target, nil)
	if token != "" {
		req.Header.Set(middleware.AdminTokenHeader, token)
	}
	res, err := app.Test(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	return res.StatusCode
}

func TestAdminDelete_UnconfiguredSecretIsClosed(t *testing.T) {
	f := accounts()
	app := newAdminApp(f, "")
	if got := do(t, app, "/users/admin/266?username=arami", "anything"); got != 503 {
		t.Fatalf("status = %d, want 503", got)
	}
	if got := do(t, app, "/users/admin/266?username=arami", ""); got != 503 {
		t.Fatalf("status without token = %d, want 503", got)
	}
	if f.deleteCalls != 0 {
		t.Fatal("deleted with no secret configured")
	}
}

func TestAdminDelete_RejectsMissingOrWrongToken(t *testing.T) {
	f := accounts()
	app := newAdminApp(f, testSecret)
	for _, tok := range []string{"", "wrong", testSecret + "x", testSecret[:len(testSecret)-1]} {
		if got := do(t, app, "/users/admin/266?username=arami", tok); got != 401 {
			t.Fatalf("token %q: status = %d, want 401", tok, got)
		}
	}
	if f.deleteCalls != 0 {
		t.Fatal("deleted without a valid token")
	}
}

func TestAdminDelete_DeletesOnlyTheNamedAccountByDefault(t *testing.T) {
	f := accounts()
	app := newAdminApp(f, testSecret)
	if got := do(t, app, "/users/admin/266?username=arami", testSecret); got != 200 {
		t.Fatalf("status = %d, want 200", got)
	}
	if f.deleteCalls != 1 || f.deletedID != 266 {
		t.Fatalf("deleted id = %d calls = %d, want 266 once", f.deletedID, f.deleteCalls)
	}
	if f.deletedLink {
		t.Fatal("linked accounts were included without being asked for")
	}
}

func TestAdminDelete_LinkedOnlyWhenAsked(t *testing.T) {
	f := accounts()
	app := newAdminApp(f, testSecret)
	if got := do(t, app, "/users/admin/266?username=ARAMI&deleteLinked=true", testSecret); got != 200 {
		t.Fatalf("status = %d, want 200", got)
	}
	if !f.deletedLink {
		t.Fatal("deleteLinked=true was ignored")
	}
}

// The near miss this guard exists for: arami (266) and aramis (267) differ by
// one letter and one digit.
func TestAdminDelete_UsernameMustMatchTheID(t *testing.T) {
	f := accounts()
	app := newAdminApp(f, testSecret)
	if got := do(t, app, "/users/admin/267?username=arami", testSecret); got != 409 {
		t.Fatalf("status = %d, want 409", got)
	}
	if got := do(t, app, "/users/admin/266", testSecret); got != 400 {
		t.Fatalf("missing username: status = %d, want 400", got)
	}
	if f.deleteCalls != 0 {
		t.Fatal("deleted despite a username mismatch")
	}
}

func TestAdminDelete_BadInput(t *testing.T) {
	f := accounts()
	app := newAdminApp(f, testSecret)
	cases := map[string]int{
		"/users/admin/abc?username=arami":                   400,
		"/users/admin/0?username=arami":                     400,
		"/users/admin/999?username=ghost":                   404,
		"/users/admin/266?username=arami&deleteLinked=yes!": 400,
	}
	for target, want := range cases {
		if got := do(t, app, target, testSecret); got != want {
			t.Fatalf("%s: status = %d, want %d", target, got, want)
		}
	}
	if f.deleteCalls != 0 {
		t.Fatal("deleted on bad input")
	}
}

func TestAdminDelete_SurfacesServiceFailure(t *testing.T) {
	f := accounts()
	f.deleteErr = errors.New("delete account failed: boom")
	app := newAdminApp(f, testSecret)
	if got := do(t, app, "/users/admin/266?username=arami", testSecret); got != 500 {
		t.Fatalf("status = %d, want 500", got)
	}
}
