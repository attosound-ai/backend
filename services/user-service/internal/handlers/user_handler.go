package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/services"
	"github.com/gofiber/fiber/v2"
)

// UserHandler handles HTTP requests related to user profiles.
type UserHandler struct {
	userService   *services.UserService
	otpServiceURL string
}

// NewUserHandler creates a new UserHandler.
func NewUserHandler(userService *services.UserService, otpServiceURL ...string) *UserHandler {
	url := "http://otp-service:8000"
	if len(otpServiceURL) > 0 && otpServiceURL[0] != "" {
		url = otpServiceURL[0]
	}
	return &UserHandler{userService: userService, otpServiceURL: url}
}

// GetPushTokens handles GET /users/:id/push-tokens.
//
// Returns the active Expo push tokens registered for the user, so
// telephony-service can fall back to a regular APNS/FCM push when an
// incoming-call invite fails to reach the Voice SDK (no answer / unreachable
// device). Same trust posture as GET /users/:id/linked-account-ids —
// consumed only on the private network, no JWT required.
//
// Response shape: { success: true, data: { tokens: [{token, platform,
// deviceId}, ...] } }.
func (h *UserHandler) GetPushTokens(c *fiber.Ctx) error {
	idStr := c.Params("id")
	if idStr == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "user ID is required",
		})
	}
	id, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid user ID format",
		})
	}

	tokens, err := h.userService.GetActivePushTokensForUser(id)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	// Project to a minimal, stable shape so internal callers don't depend on
	// the GORM model.
	type pushTokenResp struct {
		Token    string `json:"token"`
		Platform string `json:"platform"`
		DeviceID string `json:"deviceId"`
	}
	resp := make([]pushTokenResp, 0, len(tokens))
	for _, t := range tokens {
		resp = append(resp, pushTokenResp{
			Token:    t.Token,
			Platform: t.Platform,
			DeviceID: t.DeviceID,
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    fiber.Map{"tokens": resp},
	})
}

// GetLinkedAccountIDs handles GET /users/:id/linked-account-ids.
//
// Returns the full set of user IDs in the linked account group
// (representative + all managed creators) for a given user. Used by
// telephony-service to fan out TwiML across every reachable Voice SDK
// identity on a device, so a PSTN call to one bridge can ring every
// linked account.
//
// Response shape: { success: true, data: { userIds: [int, ...] } }.
// Standalone users (no representative_id, not managed) get a single-element
// array. The requested userId is always included in the result.
func (h *UserHandler) GetLinkedAccountIDs(c *fiber.Ctx) error {
	idStr := c.Params("id")
	if idStr == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "user ID is required",
		})
	}
	id, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid user ID format",
		})
	}

	ids, err := h.userService.GetLinkedAccountIDsForUser(id)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}
	if ids == nil {
		return c.Status(fiber.StatusNotFound).JSON(models.APIResponse{
			Success: false,
			Error:   "user not found",
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    fiber.Map{"userIds": ids},
	})
}

// GetUser handles GET /users/:id
func (h *UserHandler) GetUser(c *fiber.Ctx) error {
	id := c.Params("id")
	if id == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "user ID is required",
		})
	}

	profile, err := h.userService.GetUserByID(c.Context(), id)
	if err != nil {
		status := fiber.StatusInternalServerError
		if err.Error() == "user not found" {
			status = fiber.StatusNotFound
		} else if err.Error() == "invalid user ID format" {
			status = fiber.StatusBadRequest
		}
		return c.Status(status).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    profile,
	})
}

// SearchUsers handles GET /users/search?q=term&limit=20
func (h *UserHandler) SearchUsers(c *fiber.Ctx) error {
	query := c.Query("q")
	if query == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "query parameter 'q' is required",
		})
	}

	limit := 20
	if l := c.Query("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	profiles, err := h.userService.SearchUsers(c.Context(), query, limit)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    profiles,
	})
}

// UpdateProfile handles PATCH /users/me/profile (requires JWT)
func (h *UserHandler) UpdateProfile(c *fiber.Ctx) error {
	claims, ok := c.Locals("claims").(*middleware.JWTClaims)
	if !ok || claims == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "unauthorized",
		})
	}

	var req models.UpdateProfileRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	profile, err := h.userService.UpdateProfile(c.Context(), claims.UserID, &req)
	if err != nil {
		status := fiber.StatusInternalServerError
		if err.Error() == "user not found" {
			status = fiber.StatusNotFound
		} else if err.Error() == "username already taken" {
			status = fiber.StatusConflict
		}
		return c.Status(status).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    profile,
	})
}

// DiscoverUsers handles GET /users/discover (protected)
func (h *UserHandler) DiscoverUsers(c *fiber.Ctx) error {
	claims, ok := c.Locals("claims").(*middleware.JWTClaims)
	if !ok || claims == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "unauthorized",
		})
	}

	uid, err := strconv.ParseUint(claims.UserID, 10, 64)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid user ID",
		})
	}

	limit := 20
	if l := c.Query("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	profiles, err := h.userService.DiscoverUsers(c.Context(), uid, limit)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    profiles,
	})
}

// GetFollowers handles GET /users/:id/followers (placeholder)
func (h *UserHandler) GetFollowers(c *fiber.Ctx) error {
	id := c.Params("id")
	if id == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "user ID is required",
		})
	}

	// Placeholder: will delegate to Social Service via gRPC in a future iteration
	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"userId":    id,
			"followers": []interface{}{},
			"total":     0,
			"message":   "followers will be fetched from Social Service via gRPC",
		},
	})
}

// GetFollowing handles GET /users/:id/following (placeholder)
func (h *UserHandler) GetFollowing(c *fiber.Ctx) error {
	id := c.Params("id")
	if id == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "user ID is required",
		})
	}

	// Placeholder: will delegate to Social Service via gRPC in a future iteration
	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"userId":    id,
			"following": []interface{}{},
			"total":     0,
			"message":   "following will be fetched from Social Service via gRPC",
		},
	})
}

// deleteAccountRequest is the expected JSON body for DELETE /users/me/account.
type deleteAccountRequest struct {
	OTPCode              string `json:"otpCode"`
	OTPIdentifier        string `json:"otpIdentifier"`
	DeleteLinkedAccounts bool   `json:"deleteLinkedAccounts"`
}

// DeleteAccount handles DELETE /users/me/account.
// Verifies the user's identity via OTP, then permanently deletes all data.
func (h *UserHandler) DeleteAccount(c *fiber.Ctx) error {
	claims, ok := c.Locals("claims").(*middleware.JWTClaims)
	if !ok || claims == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "unauthorized",
		})
	}

	uid, err := strconv.ParseUint(claims.UserID, 10, 64)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid user ID",
		})
	}

	var req deleteAccountRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	if req.OTPCode == "" || req.OTPIdentifier == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "otpCode and otpIdentifier are required",
		})
	}

	// Verify OTP against otp-service
	if err := h.verifyOTP(req.OTPIdentifier, req.OTPCode); err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid or expired verification code",
		})
	}

	// Purge all data
	if err := h.userService.DeleteAccount(c.Context(), uid, req.DeleteLinkedAccounts); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    map[string]string{"message": "account deleted successfully"},
	})
}

// verifyOTP calls the otp-service to verify a code.
func (h *UserHandler) verifyOTP(identifier, code string) error {
	body, _ := json.Marshal(map[string]string{
		"email": identifier,
		"phone": identifier,
		"code":  code,
	})
	resp, err := http.Post(
		fmt.Sprintf("%s/otp/verify", h.otpServiceURL),
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("otp service unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("otp verification failed: %s", string(respBody))
	}
	return nil
}
