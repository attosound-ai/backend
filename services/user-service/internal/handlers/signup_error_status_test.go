package handlers

import (
	"errors"
	"fmt"
	"net/http/httptest"
	"testing"

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
