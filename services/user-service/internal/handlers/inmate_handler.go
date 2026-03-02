package handlers

import (
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/services"
	"github.com/gofiber/fiber/v2"
)

// InmateHandler handles HTTP requests for inmate lookups.
type InmateHandler struct {
	inmateService *services.InmateService
}

// NewInmateHandler creates a new InmateHandler.
func NewInmateHandler(inmateService *services.InmateService) *InmateHandler {
	return &InmateHandler{inmateService: inmateService}
}

// LookupInmate handles GET /users/inmates/lookup?state=CT&number=383124
func (h *InmateHandler) LookupInmate(c *fiber.Ctx) error {
	state := c.Query("state")
	number := c.Query("number")

	if state == "" || number == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "both 'state' and 'number' query parameters are required",
		})
	}

	result, err := h.inmateService.LookupInmate(c.Context(), state, number)
	if err != nil {
		status := fiber.StatusNotFound
		if err.Error() == "request blocked by DOC website" {
			status = fiber.StatusBadGateway
		}
		return c.Status(status).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    result,
	})
}
