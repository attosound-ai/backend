package handlers

import (
	"strconv"

	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
	"github.com/gofiber/fiber/v2"
)

// PushTokenHandler handles push token registration/removal.
type PushTokenHandler struct {
	repo *repositories.UserRepository
}

// NewPushTokenHandler creates a new PushTokenHandler.
func NewPushTokenHandler(repo *repositories.UserRepository) *PushTokenHandler {
	return &PushTokenHandler{repo: repo}
}

type registerTokenRequest struct {
	Token    string `json:"token"`
	DeviceID string `json:"deviceId"`
	Platform string `json:"platform"`
}

type removeTokenRequest struct {
	Token string `json:"token"`
}

func getUserID(c *fiber.Ctx) (uint64, error) {
	idStr, _ := c.Locals("userID").(string)
	return strconv.ParseUint(idStr, 10, 64)
}

// RegisterToken handles POST /users/me/push-token
func (h *PushTokenHandler) RegisterToken(c *fiber.Ctx) error {
	userID, err := getUserID(c)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "unauthorized",
		})
	}

	var body registerTokenRequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	if body.Token == "" || body.Platform == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "token and platform are required",
		})
	}

	if err := h.repo.UpsertPushToken(userID, body.Token, body.DeviceID, body.Platform); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   "failed to register push token",
		})
	}

	return c.Status(fiber.StatusCreated).JSON(models.APIResponse{
		Success: true,
		Data:    map[string]string{"message": "push token registered"},
	})
}

// UnregisterToken handles DELETE /users/me/push-token
func (h *PushTokenHandler) UnregisterToken(c *fiber.Ctx) error {
	userID, err := getUserID(c)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "unauthorized",
		})
	}

	var body removeTokenRequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	if body.Token == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "token is required",
		})
	}

	if err := h.repo.DeletePushToken(userID, body.Token); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   "failed to remove push token",
		})
	}

	return c.JSON(models.APIResponse{
		Success: true,
		Data:    map[string]string{"message": "push token removed"},
	})
}
