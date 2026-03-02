package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/services"
	"github.com/gofiber/fiber/v2"
)

// VerificationHandler handles representative verification via OTP.
type VerificationHandler struct {
	userService   *services.UserService
	otpServiceURL string
	httpClient    *http.Client
}

// NewVerificationHandler creates a new VerificationHandler.
func NewVerificationHandler(userService *services.UserService, otpServiceURL string) *VerificationHandler {
	return &VerificationHandler{
		userService:   userService,
		otpServiceURL: otpServiceURL,
		httpClient:    &http.Client{Timeout: 10 * time.Second},
	}
}

// sendVerificationOTPRequest is the expected JSON body for POST /users/me/verification/send-otp.
type sendVerificationOTPRequest struct {
	BridgePhone string `json:"bridgePhone"`
}

// verifyOTPRequest is the expected JSON body for POST /users/me/verification/verify.
type verifyOTPRequest struct {
	BridgePhone string `json:"bridgePhone"`
	Code        string `json:"code"`
}

// SendVerificationOTP handles POST /users/me/verification/send-otp.
// It forwards the OTP send request to the OTP microservice.
func (h *VerificationHandler) SendVerificationOTP(c *fiber.Ctx) error {
	claims, ok := c.Locals("claims").(*middleware.JWTClaims)
	if !ok || claims == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "unauthorized",
		})
	}

	var req sendVerificationOTPRequest
	if err := c.BodyParser(&req); err != nil || req.BridgePhone == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "bridgePhone is required",
		})
	}

	if err := h.callOTPService("/otp/send", map[string]string{"phone": req.BridgePhone}); err != nil {
		log.Printf("[VERIFICATION] Failed to send OTP for user %s: %v", claims.UserID, err)
		return c.Status(fiber.StatusBadGateway).JSON(models.APIResponse{
			Success: false,
			Error:   "failed to send verification code",
		})
	}

	log.Printf("[VERIFICATION] OTP sent to %s for user %s", req.BridgePhone, claims.UserID)
	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    map[string]string{"message": "Verification code sent"},
	})
}

// VerifyOTP handles POST /users/me/verification/verify.
// It verifies the OTP code and marks the user as profile-verified.
func (h *VerificationHandler) VerifyOTP(c *fiber.Ctx) error {
	claims, ok := c.Locals("claims").(*middleware.JWTClaims)
	if !ok || claims == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "unauthorized",
		})
	}

	var req verifyOTPRequest
	if err := c.BodyParser(&req); err != nil || req.BridgePhone == "" || req.Code == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "bridgePhone and code are required",
		})
	}

	// Verify OTP via the OTP microservice
	if err := h.callOTPService("/otp/verify", map[string]string{
		"phone": req.BridgePhone,
		"code":  req.Code,
	}); err != nil {
		log.Printf("[VERIFICATION] OTP verification failed for user %s: %v", claims.UserID, err)
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid verification code",
		})
	}

	// Mark user as verified
	profile, err := h.userService.GetUserByID(c.Context(), claims.UserID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   "failed to retrieve user",
		})
	}

	inmateNumber := ""
	if profile.InmateNumber != nil {
		inmateNumber = *profile.InmateNumber
	}

	_, _, err = h.userService.VerifyUser(c.Context(), claims.UserID, inmateNumber)
	if err != nil {
		log.Printf("[VERIFICATION] Failed to verify user %s: %v", claims.UserID, err)
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   "failed to verify user",
		})
	}

	// Return the updated user profile
	updatedProfile, err := h.userService.GetUserByID(c.Context(), claims.UserID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   "failed to retrieve updated profile",
		})
	}

	log.Printf("[VERIFICATION] User %s verified successfully", claims.UserID)
	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    updatedProfile,
	})
}

// callOTPService makes an HTTP POST to the OTP microservice.
func (h *VerificationHandler) callOTPService(path string, payload map[string]string) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	resp, err := h.httpClient.Post(
		h.otpServiceURL+path,
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("OTP service request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("OTP service returned status %d", resp.StatusCode)
	}

	return nil
}
