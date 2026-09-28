package handlers

import (
	"context"
	"log"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/atto-sound/user-service/internal/models"
)

// accountAdmin is the slice of UserService the operator routes need. An
// interface so the guard rails below can be tested without a database.
type accountAdmin interface {
	GetUserByID(ctx context.Context, id string) (*models.UserProfile, error)
	DeleteAccount(ctx context.Context, userID uint64, deleteLinked bool) error
}

// AdminHandler serves operator only routes. Every route is mounted behind
// middleware.RequireAdminToken.
type AdminHandler struct {
	accounts accountAdmin
}

// NewAdminHandler creates an AdminHandler.
func NewAdminHandler(accounts accountAdmin) *AdminHandler {
	return &AdminHandler{accounts: accounts}
}

// DeleteUser handles DELETE /users/admin/:id?username=<name>&deleteLinked=<bool>.
//
// The self service deletion needs an OTP sent to the owner, so support had no
// way to honour a removal request. This runs the SAME deletion (user-service
// rows plus the user.deleted event every other service purges on), never a
// hand written subset.
//
// Guard rails: the numeric id must be paired with the account's username, so
// a mistyped id cannot delete a stranger; and linked accounts (a
// representative's managed creators) are only included when asked for.
func (h *AdminHandler) DeleteUser(c *fiber.Ctx) error {
	id := c.Params("id")
	uid, err := strconv.ParseUint(id, 10, 64)
	if err != nil || uid == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid user ID",
		})
	}

	expected := strings.TrimSpace(c.Query("username"))
	if expected == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "username is required to confirm the account",
		})
	}

	deleteLinked := false
	if raw := c.Query("deleteLinked"); raw != "" {
		parsed, perr := strconv.ParseBool(raw)
		if perr != nil {
			return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
				Success: false,
				Error:   "deleteLinked must be true or false",
			})
		}
		deleteLinked = parsed
	}

	profile, err := h.accounts.GetUserByID(c.Context(), id)
	if err != nil || profile == nil {
		return c.Status(fiber.StatusNotFound).JSON(models.APIResponse{
			Success: false,
			Error:   "user not found",
		})
	}
	if !strings.EqualFold(profile.Username, expected) {
		return c.Status(fiber.StatusConflict).JSON(models.APIResponse{
			Success: false,
			Error:   "username does not match this user ID",
		})
	}

	if err := h.accounts.DeleteAccount(c.Context(), uid, deleteLinked); err != nil {
		log.Printf("[ADMIN] delete user %d (%s) failed: %v", uid, profile.Username, err)
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	log.Printf("[ADMIN] deleted user %d (%s) deleteLinked=%t", uid, profile.Username, deleteLinked)
	return c.JSON(models.APIResponse{
		Success: true,
		Data: fiber.Map{
			"deletedUserId": uid,
			"username":      profile.Username,
			"deleteLinked":  deleteLinked,
		},
	})
}
