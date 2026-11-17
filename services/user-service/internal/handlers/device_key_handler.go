package handlers

import (
	"log"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/services"
)

// DeviceKeyHandler serves remembered accounts (device keys).
//
//	POST   /auth/devices                  enroll a key (signed in)
//	GET    /auth/devices                  the account's remembered devices
//	DELETE /auth/devices/:id              forget one of them
//	POST   /auth/login/device/challenge   one time challenge (public)
//	POST   /auth/login/device             signature in, session out (public)
//
// The two public routes live under /auth/login so the app treats them like
// the password login (no bearer token, no refresh on a 401).
type DeviceKeyHandler struct {
	svc *services.DeviceKeyService
}

// NewDeviceKeyHandler creates the handler.
func NewDeviceKeyHandler(svc *services.DeviceKeyService) *DeviceKeyHandler {
	return &DeviceKeyHandler{svc: svc}
}

// sessionClaims returns the caller's user id when the bearer is a real
// session: issued by this service at the end of a full login (password, and
// the 2FA code when the account has it). A 2FA temporary token is signed
// with the same secret, and enrolling a key with it would skip the second
// factor for good. middleware.IsSessionToken (the rule RequireAuth and the
// refresh already use since b5015df) refuses it; on top of that a key, which
// lives 180 days, also needs the scope written in the token, not the default
// that pre scope tokens get.
func sessionClaims(c *fiber.Ctx) (uint64, bool) {
	uid, _, ok := sessionClaimsAt(c)
	return uid, ok
}

// sessionClaimsAt also returns when the session token was issued.
func sessionClaimsAt(c *fiber.Ctx) (uint64, time.Time, bool) {
	claims, ok := c.Locals("claims").(*middleware.JWTClaims)
	if !ok || !middleware.IsSessionToken(claims) || claims.Scope != middleware.ScopeUser {
		return 0, time.Time{}, false
	}
	uid, err := strconv.ParseUint(claims.UserID, 10, 64)
	if err != nil || uid == 0 {
		return 0, time.Time{}, false
	}
	var iat time.Time
	if claims.IssuedAt != nil {
		iat = claims.IssuedAt.Time
	}
	return uid, iat, true
}

func deviceError(c *fiber.Ctx, err error) error {
	if de, ok := services.AsDeviceKeyError(err); ok {
		data := map[string]string{"code": de.Code}
		if de.Reason != "" {
			data["reason"] = de.Reason
		}
		return c.Status(de.Status).JSON(fiber.Map{
			"success": false,
			"error":   de.Code,
			"data":    data,
		})
	}
	log.Printf("[DEVICE-KEY] internal error on %s %s: %v", c.Method(), c.Path(), err)
	return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
		Success: false,
		Error:   "internal error",
	})
}

func unauthorized(c *fiber.Ctx) error {
	return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
		Success: false,
		Error:   "unauthorized",
	})
}

// Enroll handles POST /auth/devices.
func (h *DeviceKeyHandler) Enroll(c *fiber.Ctx) error {
	uid, iat, ok := sessionClaimsAt(c)
	if !ok {
		return unauthorized(c)
	}
	var req models.EnrollDeviceKeyRequest
	if err := c.BodyParser(&req); err != nil {
		return deviceError(c, &services.DeviceKeyError{Status: 400, Code: services.DeviceErrInvalidRequest})
	}
	res, err := h.svc.Enroll(c.Context(), uid, iat, &req)
	if err != nil {
		return deviceError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(models.APIResponse{Success: true, Data: res})
}

// List handles GET /auth/devices?installationId=...
func (h *DeviceKeyHandler) List(c *fiber.Ctx) error {
	uid, ok := sessionClaims(c)
	if !ok {
		return unauthorized(c)
	}
	views, err := h.svc.List(c.Context(), uid, c.Query("installationId"))
	if err != nil {
		return deviceError(c, err)
	}
	return c.JSON(models.APIResponse{Success: true, Data: fiber.Map{"devices": views}})
}

// Revoke handles DELETE /auth/devices/:id.
func (h *DeviceKeyHandler) Revoke(c *fiber.Ctx) error {
	uid, ok := sessionClaims(c)
	if !ok {
		return unauthorized(c)
	}
	if err := h.svc.Revoke(c.Context(), uid, c.Params("id")); err != nil {
		return deviceError(c, err)
	}
	return c.JSON(models.APIResponse{Success: true, Data: fiber.Map{"revoked": true}})
}

// Challenge handles POST /auth/login/device/challenge.
func (h *DeviceKeyHandler) Challenge(c *fiber.Ctx) error {
	var req models.DeviceChallengeRequest
	if err := c.BodyParser(&req); err != nil {
		return deviceError(c, &services.DeviceKeyError{Status: 400, Code: services.DeviceErrInvalidRequest})
	}
	res, err := h.svc.Challenge(c.Context(), req.CredentialID)
	if err != nil {
		return deviceError(c, err)
	}
	return c.JSON(models.APIResponse{Success: true, Data: res})
}

// Login handles POST /auth/login/device.
func (h *DeviceKeyHandler) Login(c *fiber.Ctx) error {
	var req models.DeviceLoginRequest
	if err := c.BodyParser(&req); err != nil {
		return deviceError(c, &services.DeviceKeyError{Status: 400, Code: services.DeviceErrInvalidRequest})
	}
	res, err := h.svc.Login(c.Context(), &req)
	if err != nil {
		// An account in its deletion grace: the same 403 and recovery token
		// the password login answers, so the app opens the recover screen.
		if handled, werr := writePendingDeletion(c, err); handled {
			return werr
		}
		return deviceError(c, err)
	}
	return c.JSON(models.APIResponse{Success: true, Data: res})
}
