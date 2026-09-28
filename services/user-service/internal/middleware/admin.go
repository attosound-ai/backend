package middleware

import (
	"crypto/subtle"

	"github.com/gofiber/fiber/v2"

	"github.com/atto-sound/user-service/internal/models"
)

// AdminTokenHeader carries the operator secret, the same header the payment
// and content services use for their admin routes.
const AdminTokenHeader = "X-Admin-Token"

// RequireAdminToken gates operator only routes on a shared secret.
//
// With no secret configured the route answers 503 instead of letting anyone
// through: a missing variable must never open an admin route. The comparison
// is constant time so the secret cannot be guessed byte by byte.
func RequireAdminToken(secret string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if secret == "" {
			return c.Status(fiber.StatusServiceUnavailable).JSON(models.APIResponse{
				Success: false,
				Error:   "admin API is not configured",
			})
		}
		got := c.Get(AdminTokenHeader)
		if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(secret)) != 1 {
			return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
				Success: false,
				Error:   "unauthorized",
			})
		}
		return c.Next()
	}
}
