package handlers

import (
	"fmt"
	"log"
	"strings"

	"github.com/atto-sound/otp-service/services"
	"github.com/gofiber/fiber/v2"
	"github.com/nyaruka/phonenumbers"
)

// SendRequest is the DTO for OTP send requests.
// Routing is inferred from which fields are populated:
//   - phone only → SMS
//   - email only → email
//   - both       → SMS + email simultaneously (fan-out)
//
// The `channel` field is deprecated; kept for backwards compatibility.
type SendRequest struct {
	Phone         string `json:"phone"`
	Email         string `json:"email"`
	Locale        string `json:"locale"`
	EmailTemplate string `json:"email_template,omitempty"`
	Channel       string `json:"channel,omitempty"` // deprecated — ignored
}

// VerifyRequest is the DTO for OTP verify requests.
// When both phone and email were used for send, verify with email (primary identifier).
// The `channel` field is deprecated; kept for backwards compatibility.
type VerifyRequest struct {
	Phone   string `json:"phone,omitempty"`
	Email   string `json:"email,omitempty"`
	Code    string `json:"code"`
	Channel string `json:"channel,omitempty"` // deprecated — ignored
}

// APIResponse is the standard JSON response envelope.
type APIResponse struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
}

// OTPHandler handles HTTP requests for OTP operations.
type OTPHandler struct {
	otpService *services.OTPService
}

// NewOTPHandler creates a new OTPHandler.
func NewOTPHandler(otpService *services.OTPService) *OTPHandler {
	return &OTPHandler{otpService: otpService}
}

// Send handles POST /send — generates and sends an OTP to all available channels.
func (h *OTPHandler) Send(c *fiber.Ctx) error {
	var req SendRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	// Normalize phone if provided.
	var phone string
	if req.Phone != "" {
		var err error
		phone, err = normalizePhone(req.Phone)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(APIResponse{
				Success: false,
				Error:   "invalid phone number (e.g. +12025551234)",
			})
		}
	}

	email := strings.TrimSpace(req.Email)

	if phone == "" && email == "" {
		return c.Status(fiber.StatusBadRequest).JSON(APIResponse{
			Success: false,
			Error:   "phone or email is required",
		})
	}

	if err := h.otpService.SendOTP(c.Context(), phone, email, req.Locale, req.EmailTemplate, c.IP()); err != nil {
		return mapServiceError(c, err)
	}

	return c.Status(fiber.StatusOK).JSON(APIResponse{
		Success: true,
		Data:    map[string]string{"message": "verification code sent"},
	})
}

// Verify handles POST /verify — verifies the OTP code.
// Identifier priority: email (primary when both present) → phone.
func (h *OTPHandler) Verify(c *fiber.Ctx) error {
	var req VerifyRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	req.Code = strings.TrimSpace(req.Code)
	if req.Code == "" {
		return c.Status(fiber.StatusBadRequest).JSON(APIResponse{
			Success: false,
			Error:   "verification code is required",
		})
	}

	// Resolve identifier: email takes priority (it is the primary Redis key when both channels used).
	var identifier string
	if email := strings.TrimSpace(req.Email); email != "" {
		identifier = email
	} else {
		phone, err := normalizePhone(req.Phone)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(APIResponse{
				Success: false,
				Error:   "phone or email is required",
			})
		}
		identifier = phone
	}

	if err := h.otpService.VerifyCode(c.Context(), identifier, req.Code); err != nil {
		return mapServiceError(c, err)
	}

	return c.Status(fiber.StatusOK).JSON(APIResponse{
		Success: true,
		Data:    map[string]string{"message": "verified successfully"},
	})
}

// HealthHandler handles health check requests.
type HealthHandler struct{}

// NewHealthHandler creates a new HealthHandler.
func NewHealthHandler() *HealthHandler {
	return &HealthHandler{}
}

// Health handles GET /health
func (h *HealthHandler) Health(c *fiber.Ctx) error {
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"status":  "ok",
		"service": "otp-service",
	})
}

// normalizePhone validates and converts a phone number to E.164 format.
func normalizePhone(phone string) (string, error) {
	phone = strings.TrimSpace(phone)
	if phone == "" {
		return "", fmt.Errorf("phone number is required")
	}

	parsed, err := phonenumbers.Parse(phone, "")
	if err != nil {
		return "", fmt.Errorf("invalid phone number: %w", err)
	}
	if !phonenumbers.IsValidNumber(parsed) {
		return "", fmt.Errorf("invalid phone number")
	}
	return phonenumbers.Format(parsed, phonenumbers.E164), nil
}

// mapServiceError translates OTP service errors into appropriate HTTP responses.
func mapServiceError(c *fiber.Ctx, err error) error {
	msg := err.Error()

	switch {
	case strings.Contains(msg, "rate limited"),
		strings.Contains(msg, "hourly limit"),
		strings.Contains(msg, "daily limit"),
		strings.Contains(msg, "ip limit"),
		strings.Contains(msg, "temporarily blocked"),
		strings.Contains(msg, "maximum verification attempts"):
		return c.Status(fiber.StatusTooManyRequests).JSON(APIResponse{
			Success: false,
			Error:   msg,
		})

	case strings.Contains(msg, "invalid") || strings.Contains(msg, "expired"):
		return c.Status(fiber.StatusUnauthorized).JSON(APIResponse{
			Success: false,
			Error:   msg,
		})

	default:
		log.Printf("[ERROR] OTP service error: %v", err)
		return c.Status(fiber.StatusInternalServerError).JSON(APIResponse{
			Success: false,
			Error:   "verification failed",
		})
	}
}
