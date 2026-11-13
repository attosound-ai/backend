package handlers

// What one account receives about another (Nov 12 2026). Until then search and
// discover sent, for every user, "email", "twoFactorEnabled",
// "twoFactorMethod" and the real "isManagedAccount", and the 5 nov blanking
// left those keys in every response. Each route here gets a stranger, who must
// see only models.PublicProfile, and the owner, who must still see everything.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/atto-sound/user-service/internal/config"
	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
)

const (
	ownerID    uint64 = 153 // a managed creator
	repID      uint64 = 152 // its representative, linked
	strangerID uint64 = 300 // someone else
)

// Keys a stranger must never receive, not even empty.
var forbiddenKeys = []string{
	"email", "phoneNumber", "phoneCountryCode", "dateOfBirth",
	"inmateNumber", "inmateState", "consentToRecording",
	"twoFactorEnabled", "twoFactorMethod", "isManagedAccount",
	"representativeId", "creatorName", "relationship", "creatorEmail", "creatorPhone",
}

func sp(s string) *string { return &s }

func fullProfile(id uint64, name string) *models.UserProfile {
	consent := true
	rep := repID
	return &models.UserProfile{
		ID: id, Username: name, DisplayName: name, Role: "creator",
		Email: name + "@example.com", PhoneCountryCode: sp("+1"), PhoneNumber: sp("8605550100"),
		DateOfBirth: sp("1990-01-01"), InmateNumber: sp("123456"), InmateState: sp("CT"),
		ConsentToRecording: &consent, TwoFactorEnabled: true, TwoFactorMethod: "sms",
		IsManagedAccount: true, RepresentativeID: &rep, CreatorName: sp("Real Name"),
		Relationship: sp("brother"), CreatorEmail: sp("c@example.com"), CreatorPhone: sp("5550101"),
		Avatar: sp("https://img/a.jpg"), Bio: sp("bio"), CreatorTypes: []string{"rapper"},
		CreatorGenres: []string{"rap"}, ProfileVerified: true, SocialInstagram: sp("insta"),
		BookingEmail: sp("booking@example.com"), FollowersCount: 20, FollowingCount: 3,
		PostsCount: 7, CreatedAt: "2026-09-10T00:00:00Z",
	}
}

type fakeProfiles struct {
	byID map[uint64]*models.UserProfile
}

func newFakeProfiles() *fakeProfiles {
	return &fakeProfiles{byID: map[uint64]*models.UserProfile{
		ownerID:    fullProfile(ownerID, "suicideking"),
		repID:      fullProfile(repID, "larry"),
		strangerID: fullProfile(strangerID, "stranger"),
	}}
}

// copy so a handler can never change the stored profile between requests.
func (f *fakeProfiles) get(id uint64) *models.UserProfile {
	p := *f.byID[id]
	return &p
}

func (f *fakeProfiles) GetUserByID(_ context.Context, id string) (*models.UserProfile, error) {
	n, err := strconv.ParseUint(id, 10, 64)
	if err != nil {
		return nil, errors.New("invalid user ID format")
	}
	if _, ok := f.byID[n]; !ok {
		return nil, errors.New("user not found")
	}
	return f.get(n), nil
}

func (f *fakeProfiles) SearchUsers(context.Context, string, int) ([]*models.UserProfile, error) {
	return []*models.UserProfile{f.get(ownerID), f.get(repID), f.get(strangerID)}, nil
}

// Without a session search answers one exact username.
func (f *fakeProfiles) SearchUsersExact(_ context.Context, q string) ([]*models.UserProfile, error) {
	for id, p := range f.byID {
		if strings.EqualFold(p.Username, q) {
			return []*models.UserProfile{f.get(id)}, nil
		}
	}
	return []*models.UserProfile{}, nil
}

// The real query leaves the caller out; the fake does not, so the test also
// covers a caller that shows up in its own list.
func (f *fakeProfiles) DiscoverUsers(context.Context, uint64, int) ([]*models.UserProfile, error) {
	return []*models.UserProfile{f.get(ownerID), f.get(repID), f.get(strangerID)}, nil
}

func (f *fakeProfiles) GetLinkedAccountIDsForUser(id uint64) ([]uint64, error) {
	if id == ownerID || id == repID {
		return []uint64{repID, ownerID}, nil
	}
	return []uint64{id}, nil
}

func (f *fakeProfiles) GetActivePushTokensForUser(id uint64) ([]models.PushToken, error) {
	return []models.PushToken{{UserID: id, Token: "ExponentPushToken[fake]", Platform: "ios", DeviceID: "dev-1"}}, nil
}

func projectionApp(t *testing.T) (*fiber.App, *middleware.JWTManager) {
	t.Helper()
	mgr := middleware.NewJWTManager(&config.Config{
		JWTSecret: "test-secret-please-ignore", JWTAccessExpiry: 15 * time.Minute, JWTRefreshExpiry: time.Hour,
	})
	h := &UserHandler{profiles: newFakeProfiles()}
	app := fiber.New()
	// Same middleware as cmd/server/main.go.
	app.Get("/users/search", middleware.OptionalAuth(mgr), h.SearchUsers)
	app.Get("/users/discover", middleware.RequireAuth(mgr), h.DiscoverUsers)
	app.Get("/users/:id", middleware.OptionalAuth(mgr), h.GetUser)
	return app, mgr
}

func tokenFor(t *testing.T, mgr *middleware.JWTManager, id uint64) string {
	t.Helper()
	pair, err := mgr.GenerateTokenPair(&models.User{ID: id, Username: "u", Role: models.RoleCreator})
	if err != nil {
		t.Fatal(err)
	}
	return pair.AccessToken
}

// call returns the decoded "data" of the response.
func call(t *testing.T, app *fiber.App, target, token string) json.RawMessage {
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
	if resp.StatusCode != 200 {
		t.Fatalf("%s answered %d: %s", target, resp.StatusCode, body)
	}
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("%s: %v (%s)", target, err, body)
	}
	return env.Data
}

func rowsByID(t *testing.T, raw json.RawMessage) map[uint64]map[string]any {
	t.Helper()
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("not a list: %v (%s)", err, raw)
	}
	out := map[uint64]map[string]any{}
	for _, r := range rows {
		out[uint64(r["id"].(float64))] = r
	}
	return out
}

func object(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("not an object: %v (%s)", err, raw)
	}
	return m
}

func assertPublic(t *testing.T, where string, row map[string]any) {
	t.Helper()
	for _, k := range forbiddenKeys {
		if v, ok := row[k]; ok {
			t.Errorf("%s: a stranger receives %q = %v", where, k, v)
		}
	}
	// What the app needs from someone else's row stays.
	for _, k := range []string{"id", "username", "displayName", "avatar", "bio", "role",
		"creatorTypes", "creatorGenres", "profileVerified", "socialInstagram", "bookingEmail",
		"followersCount", "followingCount", "postsCount", "createdAt"} {
		if _, ok := row[k]; !ok {
			t.Errorf("%s: the public row lost %q", where, k)
		}
	}
}

func assertFull(t *testing.T, where string, row map[string]any) {
	t.Helper()
	for _, k := range []string{"email", "phoneNumber", "dateOfBirth", "inmateNumber", "inmateState",
		"consentToRecording", "twoFactorEnabled", "twoFactorMethod", "isManagedAccount", "representativeId"} {
		if _, ok := row[k]; !ok {
			t.Errorf("%s: the owner lost its own %q", where, k)
		}
	}
	if row["email"] != "suicideking@example.com" || row["inmateNumber"] != "123456" || row["isManagedAccount"] != true {
		t.Errorf("%s: the owner's own data changed: %v", where, row)
	}
}

func TestGetUserByIDShowsStrangersOnlyThePublicProfile(t *testing.T) {
	app, mgr := projectionApp(t)
	target := "/users/" + strconv.FormatUint(ownerID, 10)

	assertPublic(t, "GET /users/:id without a session", object(t, call(t, app, target, "")))
	assertPublic(t, "GET /users/:id by a stranger", object(t, call(t, app, target, tokenFor(t, mgr, strangerID))))
	assertFull(t, "GET /users/:id by the owner", object(t, call(t, app, target, tokenFor(t, mgr, ownerID))))
	// The linked representative keeps the full profile: a managed creator with
	// no contact reads its representative's email to delete its account.
	assertFull(t, "GET /users/:id by the linked representative", object(t, call(t, app, target, tokenFor(t, mgr, repID))))
}

func TestSearchShowsStrangersOnlyThePublicProfile(t *testing.T) {
	app, mgr := projectionApp(t)

	anon := rowsByID(t, call(t, app, "/users/search?q=stranger", ""))
	if len(anon) != 1 {
		t.Fatalf("search without a session: %d rows, want the 1 exact match", len(anon))
	}
	for id, row := range anon {
		assertPublic(t, "search without a session, row "+strconv.FormatUint(id, 10), row)
	}

	mine := rowsByID(t, call(t, app, "/users/search?q=st", tokenFor(t, mgr, ownerID)))
	assertFull(t, "search, the caller's own row", mine[ownerID])
	// Linked or not, another account in a list is public.
	assertPublic(t, "search, the linked representative's row", mine[repID])
	assertPublic(t, "search, a stranger's row", mine[strangerID])
}

func TestDiscoverShowsStrangersOnlyThePublicProfile(t *testing.T) {
	app, mgr := projectionApp(t)

	rows := rowsByID(t, call(t, app, "/users/discover", tokenFor(t, mgr, ownerID)))
	if len(rows) != 3 {
		t.Fatalf("discover rows: %d", len(rows))
	}
	assertFull(t, "discover, the caller's own row", rows[ownerID])
	assertPublic(t, "discover, the linked representative's row", rows[repID])
	assertPublic(t, "discover, a stranger's row", rows[strangerID])

	other := rowsByID(t, call(t, app, "/users/discover", tokenFor(t, mgr, strangerID)))
	assertPublic(t, "discover seen by a stranger", other[ownerID])
}
