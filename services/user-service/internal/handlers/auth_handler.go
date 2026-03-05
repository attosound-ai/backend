package handlers

import (
	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/services"
	"github.com/gofiber/fiber/v2"
)

// AuthHandler handles HTTP requests related to authentication.
type AuthHandler struct {
	authService *services.AuthService
}

// NewAuthHandler creates a new AuthHandler.
func NewAuthHandler(authService *services.AuthService) *AuthHandler {
	return &AuthHandler{authService: authService}
}

// Register handles POST /auth/register
func (h *AuthHandler) Register(c *fiber.Ctx) error {
	var req models.RegisterRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	// Basic validation
	if req.Username == "" || req.Email == "" || req.Password == "" || req.DisplayName == "" || req.Role == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "username, email, password, displayName, and role are required",
		})
	}
	if len(req.Username) < 3 || len(req.Username) > 50 {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "username must be between 3 and 50 characters",
		})
	}
	if len(req.Password) < 8 {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "password must be at least 8 characters",
		})
	}
	if req.Role != "artist" && req.Role != "representative" && req.Role != "listener" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "role must be one of: artist, representative, listener",
		})
	}

	result, err := h.authService.Register(c.Context(), &req)
	if err != nil {
		status := fiber.StatusInternalServerError
		if err.Error() == "email already registered" || err.Error() == "username already taken" {
			status = fiber.StatusConflict
		}
		return c.Status(status).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.Status(fiber.StatusCreated).JSON(models.APIResponse{
		Success: true,
		Data:    result,
	})
}

// Login handles POST /auth/login
func (h *AuthHandler) Login(c *fiber.Ctx) error {
	var req models.LoginRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	if req.Identifier == "" || req.Password == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "identifier and password are required",
		})
	}

	result, err := h.authService.Login(c.Context(), &req)
	if err != nil {
		status := fiber.StatusUnauthorized
		if err.Error() == "internal error" {
			status = fiber.StatusInternalServerError
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

// LoginOTP handles POST /auth/login/otp — passwordless login via OTP.
func (h *AuthHandler) LoginOTP(c *fiber.Ctx) error {
	var req models.LoginOTPRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	if req.Identifier == "" || req.OTP == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "identifier and otp are required",
		})
	}

	result, err := h.authService.LoginWithOTP(c.Context(), &req)
	if err != nil {
		status := fiber.StatusUnauthorized
		if err.Error() == "internal error" || err.Error() == "failed to verify code" {
			status = fiber.StatusInternalServerError
		}
		if err.Error() == "no account found for this identifier" {
			status = fiber.StatusNotFound
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

// Logout handles POST /auth/logout
func (h *AuthHandler) Logout(c *fiber.Ctx) error {
	// For now, just return success. Token invalidation can be implemented
	// with a Redis blacklist in a future iteration.
	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data: map[string]string{
			"message": "logged out successfully",
		},
	})
}

// Refresh handles POST /auth/refresh
func (h *AuthHandler) Refresh(c *fiber.Ctx) error {
	var req models.RefreshRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	if req.RefreshToken == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "refreshToken is required",
		})
	}

	tokens, err := h.authService.RefreshToken(c.Context(), req.RefreshToken)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    tokens,
	})
}

// CheckPhone handles GET /auth/check-phone?phone=+1...
// Returns 200 if available, 409 if already registered.
func (h *AuthHandler) CheckPhone(c *fiber.Ctx) error {
	phone := c.Query("phone")
	if phone == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "phone is required",
		})
	}

	available, err := h.authService.CheckPhoneAvailability(phone)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	if !available {
		return c.Status(fiber.StatusConflict).JSON(models.APIResponse{
			Success: false,
			Error:   "phone number already registered",
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{Success: true})
}

// PreRegister handles POST /auth/pre-register
func (h *AuthHandler) PreRegister(c *fiber.Ctx) error {
	var req models.PreRegisterRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	if req.Email == "" || req.Password == "" || req.DisplayName == "" || req.Username == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "email, password, displayName, and username are required",
		})
	}
	if len(req.Username) < 3 || len(req.Username) > 50 {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "username must be between 3 and 50 characters",
		})
	}
	if len(req.Password) < 8 {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "password must be at least 8 characters",
		})
	}

	result, err := h.authService.PreRegister(c.Context(), &req)
	if err != nil {
		status := fiber.StatusInternalServerError
		if err.Error() == "email already registered" || err.Error() == "username already taken" || err.Error() == "phone number already registered" {
			status = fiber.StatusConflict
		}
		return c.Status(status).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.Status(fiber.StatusCreated).JSON(models.APIResponse{
		Success: true,
		Data:    result,
	})
}

// CompleteRegistration handles POST /auth/complete-registration (requires JWT)
func (h *AuthHandler) CompleteRegistration(c *fiber.Ctx) error {
	claims, ok := c.Locals("claims").(*middleware.JWTClaims)
	if !ok || claims == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "unauthorized",
		})
	}

	var req models.CompleteRegistrationRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	if req.Role == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "role is required",
		})
	}
	if req.Role != "artist" && req.Role != "representative" && req.Role != "listener" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "role must be one of: artist, representative, listener",
		})
	}

	result, err := h.authService.CompleteRegistration(c.Context(), claims.UserID, &req)
	if err != nil {
		status := fiber.StatusInternalServerError
		if err.Error() == "user not found" {
			status = fiber.StatusNotFound
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

// ForgotPassword handles POST /auth/forgot-password
func (h *AuthHandler) ForgotPassword(c *fiber.Ctx) error {
	var req models.ForgotPasswordRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	if req.Email == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "email is required",
		})
	}

	// Always return 200 regardless of whether email exists (prevents enumeration)
	_ = h.authService.ForgotPassword(c.Context(), &req)
	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data: map[string]string{
			"message": "if this email is registered, a code has been sent to the associated phone number",
		},
	})
}

// ResetPassword handles POST /auth/reset-password
func (h *AuthHandler) ResetPassword(c *fiber.Ctx) error {
	var req models.ResetPasswordRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	if req.Email == "" || req.OTP == "" || req.Password == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "email, otp, and password are required",
		})
	}
	if len(req.Password) < 8 {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "password must be at least 8 characters",
		})
	}

	if err := h.authService.ResetPassword(c.Context(), &req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    map[string]string{"message": "password updated successfully"},
	})
}

// Login2FA handles POST /auth/login/2fa — completes 2FA verification.
func (h *AuthHandler) Login2FA(c *fiber.Ctx) error {
	var req models.Login2FARequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}
	if req.TempToken == "" || req.Code == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "tempToken and code are required",
		})
	}

	result, err := h.authService.Login2FA(c.Context(), &req)
	if err != nil {
		status := fiber.StatusUnauthorized
		if err.Error() == "internal error" || err.Error() == "failed to verify code" {
			status = fiber.StatusInternalServerError
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

// Enable2FAInit handles POST /auth/2fa/enable (requires JWT)
func (h *AuthHandler) Enable2FAInit(c *fiber.Ctx) error {
	claims, ok := c.Locals("claims").(*middleware.JWTClaims)
	if !ok || claims == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "unauthorized",
		})
	}

	var req models.Enable2FARequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}
	if req.Method != "sms" && req.Method != "email" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "method must be 'sms' or 'email'",
		})
	}

	maskedTarget, err := h.authService.Enable2FAInit(c.Context(), claims.UserID, &req)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data: map[string]string{
			"message":      "verification code sent",
			"maskedTarget": maskedTarget,
		},
	})
}

// Enable2FAConfirm handles POST /auth/2fa/confirm (requires JWT)
func (h *AuthHandler) Enable2FAConfirm(c *fiber.Ctx) error {
	claims, ok := c.Locals("claims").(*middleware.JWTClaims)
	if !ok || claims == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "unauthorized",
		})
	}

	var req models.Verify2FASetupRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}
	if req.Code == "" || req.Method == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "code and method are required",
		})
	}

	if err := h.authService.Enable2FAConfirm(c.Context(), claims.UserID, &req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    map[string]string{"message": "2FA enabled successfully"},
	})
}

// Disable2FA handles POST /auth/2fa/disable (requires JWT)
func (h *AuthHandler) Disable2FA(c *fiber.Ctx) error {
	claims, ok := c.Locals("claims").(*middleware.JWTClaims)
	if !ok || claims == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "unauthorized",
		})
	}

	var req models.Disable2FARequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}
	if req.Password == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "password is required",
		})
	}

	if err := h.authService.Disable2FA(c.Context(), claims.UserID, &req); err != nil {
		status := fiber.StatusBadRequest
		if err.Error() == "incorrect password" {
			status = fiber.StatusUnauthorized
		}
		return c.Status(status).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    map[string]string{"message": "2FA disabled successfully"},
	})
}

// Me handles GET /auth/me (requires JWT)
func (h *AuthHandler) Me(c *fiber.Ctx) error {
	claims, ok := c.Locals("claims").(*middleware.JWTClaims)
	if !ok || claims == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "unauthorized",
		})
	}

	profile, err := h.authService.GetCurrentUser(c.Context(), claims.UserID)
	if err != nil {
		status := fiber.StatusInternalServerError
		if err.Error() == "user not found" {
			status = fiber.StatusNotFound
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
