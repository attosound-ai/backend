package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/services"
	"github.com/gofiber/fiber/v2"
)

// What a client receives for each kind of signup failure. A mistyped code
// answered 500 until Oct 7 2026 and set off the server error alarm.
func TestMapSignupErr_Statuses(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"wrong code", services.ErrInvalidOTP, fiber.StatusUnauthorized},
		{"wrong code in the words of the OTP service", fmt.Errorf("invalid code, 4 attempts remaining%w", wrapped{services.ErrInvalidOTP}), fiber.StatusUnauthorized},
		{"OTP service down", services.ErrOTPUnavailable, fiber.StatusServiceUnavailable},
		{"session not found", services.ErrSignupSessionNotFound, fiber.StatusNotFound},
		{"session expired", services.ErrSignupSessionExpired, fiber.StatusGone},
		{"username taken", services.ErrUsernameTaken, fiber.StatusConflict},
		{"inmate number taken", services.ErrInmateNumberTaken, fiber.StatusConflict},
		{"inmate number taken, wrapped", fmt.Errorf("patch: %w", services.ErrInmateNumberTaken), fiber.StatusConflict},
		{"missing fields", services.ErrMissingRequired, fiber.StatusBadRequest},
		{"anything unknown is a server error", errors.New("pq: connection reset"), fiber.StatusInternalServerError},
	}
	for _, tc := range cases {
		app := fiber.New()
		app.Get("/", func(c *fiber.Ctx) error { return mapSignupErr(c, tc.err) })
		resp, err := app.Test(httptest.NewRequest("GET", "/", nil))
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if resp.StatusCode != tc.want {
			t.Errorf("%s: got %d, want %d", tc.name, resp.StatusCode, tc.want)
		}
	}
}

// wrapped lets an error carry other words and still be the sentinel inside.
type wrapped struct{ inner error }

func (w wrapped) Error() string { return "" }
func (w wrapped) Unwrap() error { return w.inner }

// The app keys its message and its sign in button on the code, not on the
// words, so the code must be in the body (Nov 2026, one creator per number).
func TestMapSignupErr_InmateNumberTakenCarriesItsCode(t *testing.T) {
	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error { return mapSignupErr(c, services.ErrInmateNumberTaken) })
	resp, err := app.Test(httptest.NewRequest("GET", "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	var body models.APIResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "INMATE_NUMBER_TAKEN" || body.Success || body.Error == "" {
		t.Fatalf("unexpected body %+v", body)
	}

	// Any other error carries no code.
	app2 := fiber.New()
	app2.Get("/", func(c *fiber.Ctx) error { return mapSignupErr(c, services.ErrUsernameTaken) })
	resp2, _ := app2.Test(httptest.NewRequest("GET", "/", nil))
	var body2 models.APIResponse
	_ = json.NewDecoder(resp2.Body).Decode(&body2)
	if body2.Code != "" {
		t.Fatalf("username taken must not carry a code, got %q", body2.Code)
	}
}
