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
type SendRequest struct {
	Phone   string `json:"phone"`
	Channel string `json:"channel"` // "sms" (default) or "email"
	Email   string `json:"email"`   // required when channel="email"
}

// VerifyRequest is the DTO for OTP verify requests.
type VerifyRequest struct {
	Phone   string `json:"phone"`
	Code    string `json:"code"`
	Channel string `json:"channel"` // "sms" (default) or "email"
	Email   string `json:"email"`   // required when channel="email"
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

// Send handles POST /send — generates and sends an OTP via SMS or email.
func (h *OTPHandler) Send(c *fiber.Ctx) error {
	var req SendRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	channel := req.Channel
	if channel == "" {
		channel = "sms"
	}

	var identifier string
	if channel == "email" {
		email := strings.TrimSpace(req.Email)
		if email == "" {
			return c.Status(fiber.StatusBadRequest).JSON(APIResponse{
				Success: false,
				Error:   "email is required for email channel",
			})
		}
		identifier = email
	} else {
		phone, err := normalizePhone(req.Phone)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(APIResponse{
				Success: false,
				Error:   "a valid phone number is required (e.g. +12025551234)",
			})
		}
		identifier = phone
	}

	clientIP := c.IP()

	if err := h.otpService.SendOTP(c.Context(), identifier, clientIP, channel); err != nil {
		return mapServiceError(c, err)
	}

	return c.Status(fiber.StatusOK).JSON(APIResponse{
		Success: true,
		Data: map[string]string{
			"message": "verification code sent",
		},
	})
}

// Verify handles POST /verify — verifies the OTP code for the given phone or email.
func (h *OTPHandler) Verify(c *fiber.Ctx) error {
	var req VerifyRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(APIResponse{
			Success: false,
			Error:   "invalid request body",
		})
	}

	channel := req.Channel
	if channel == "" {
		channel = "sms"
	}

	var identifier string
	if channel == "email" {
		email := strings.TrimSpace(req.Email)
		if email == "" {
			return c.Status(fiber.StatusBadRequest).JSON(APIResponse{
				Success: false,
				Error:   "email is required for email channel",
			})
		}
		identifier = email
	} else {
		phone, err := normalizePhone(req.Phone)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(APIResponse{
				Success: false,
				Error:   "a valid phone number is required",
			})
		}
		identifier = phone
	}

	req.Code = strings.TrimSpace(req.Code)
	if req.Code == "" {
		return c.Status(fiber.StatusBadRequest).JSON(APIResponse{
			Success: false,
			Error:   "verification code is required",
		})
	}

	if err := h.otpService.VerifyCode(c.Context(), identifier, req.Code); err != nil {
		return mapServiceError(c, err)
	}

	return c.Status(fiber.StatusOK).JSON(APIResponse{
		Success: true,
		Data: map[string]string{
			"message": "verified successfully",
		},
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
