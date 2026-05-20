package handlers

import (
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
	"github.com/gofiber/fiber/v2"
)

// AppIconHandler exposes the user's app-icon preference (the slot selected
// in the mobile app's icon picker). The catalog of available icons lives
// in content-service; this handler only persists the per-user choice so it
// can be restored across devices.
type AppIconHandler struct {
	repo *repositories.UserRepository
}

func NewAppIconHandler(repo *repositories.UserRepository) *AppIconHandler {
	return &AppIconHandler{repo: repo}
}

type appIconPreferenceResponse struct {
	SlotName string `json:"slotName"`
}

type setAppIconRequest struct {
	// Empty string / null is allowed — it means "revert to the primary icon"
	// and deletes the user's preference row.
	SlotName *string `json:"slotName"`
}

// GetAppIcon handles GET /users/me/app-icon. Returns the user's stored
// slot name (empty string when no preference has been set).
func (h *AppIconHandler) GetAppIcon(c *fiber.Ctx) error {
	userID, err := getUserID(c)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "unauthorized",
		})
	}
	slotName, err := h.repo.GetAppIconPreference(userID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   "failed to load app icon preference",
		})
	}
	return c.JSON(models.APIResponse{
		Success: true,
		Data:    appIconPreferenceResponse{SlotName: slotName},
	})
}

// UpdateAppIcon handles PUT /users/me/app-icon. Body: { "slotName": "noir" }
// or { "slotName": null } to revert to the primary icon.
//
// We deliberately accept any non-empty slot string without validating
// against content-service's catalog: the binary is the ultimate authority
// on which slot exists, the OS will reject a missing slot at swap time,
// and the mobile client only sends slot names it just rendered from the
// public catalogue. Validating here would require a synchronous call out
// to content-service on every preference update.
func (h *AppIconHandler) UpdateAppIcon(c *fiber.Ctx) error {
	userID, err := getUserID(c)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "unauthorized",
		})
	}

	var body setAppIconRequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	slotName := ""
	if body.SlotName != nil {
		slotName = *body.SlotName
	}

	if err := h.repo.SetAppIconPreference(userID, slotName); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   "failed to save app icon preference",
		})
	}

	return c.JSON(models.APIResponse{
		Success: true,
		Data:    appIconPreferenceResponse{SlotName: slotName},
	})
}
