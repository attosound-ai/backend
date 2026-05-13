package handlers

import (
	"errors"

	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/services"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

// SignupHandler exposes the in-progress signup state machine as HTTP endpoints.
// All draft-mutating endpoints require a signup_pending scoped JWT bound to
// the same session ID the client is targeting.
type SignupHandler struct {
	svc *services.SignupService
}

func NewSignupHandler(svc *services.SignupService) *SignupHandler {
	return &SignupHandler{svc: svc}
}

// ── DTOs ────────────────────────────────────────────────────────────────────

type startSignupRequest struct {
	Identifier     string `json:"identifier" validate:"required"`
	IdentifierType string `json:"identifierType" validate:"required,oneof=email phone"`
	Locale         string `json:"locale,omitempty"`
	DeviceID       string `json:"deviceId,omitempty"`
}

type signupVerifyOTPRequest struct {
	Code string `json:"code" validate:"required,len=6"`
}

type sessionView struct {
	ID                 string             `json:"id"`
	Identifier         string             `json:"identifier"`
	IdentifierType     string             `json:"identifierType"`
	IdentifierVerified bool               `json:"identifierVerified"`
	Status             string             `json:"status"`
	Draft              publicDraft        `json:"draft"`
	CompletedSteps     []string           `json:"completedSteps"`
	NextStep           string             `json:"nextStep"`
	ExpiresAt          string             `json:"expiresAt"`
}

// publicDraft is the client-visible draft — the password hash and creator
// password hash are intentionally omitted from responses.
type publicDraft struct {
	DisplayName             *string  `json:"displayName,omitempty"`
	Username                *string  `json:"username,omitempty"`
	DateOfBirth             *string  `json:"dateOfBirth,omitempty"`
	HasPassword             bool     `json:"hasPassword"`
	PhoneCountryCode        *string  `json:"phoneCountryCode,omitempty"`
	PhoneNumber             *string  `json:"phoneNumber,omitempty"`
	Email                   *string  `json:"email,omitempty"`
	Role                    *string  `json:"role,omitempty"`
	Avatar                  *string  `json:"avatar,omitempty"`
	InmateNumber            *string  `json:"inmateNumber,omitempty"`
	CreatorName             *string  `json:"creatorName,omitempty"`
	InmateState             *string  `json:"inmateState,omitempty"`
	Relationship            *string  `json:"relationship,omitempty"`
	ConsentToRecording      *bool    `json:"consentToRecording,omitempty"`
	SelectedPlan            *string  `json:"selectedPlan,omitempty"`
	BridgeNumber            *string  `json:"bridgeNumber,omitempty"`
	CreatorEmail            *string  `json:"creatorEmail,omitempty"`
	HasCreatorPassword      bool     `json:"hasCreatorPassword"`
	CreatorUsername         *string  `json:"creatorUsername,omitempty"`
	CreatorDisplayName      *string  `json:"creatorDisplayName,omitempty"`
	CreatorPhoneCountryCode *string  `json:"creatorPhoneCountryCode,omitempty"`
	CreatorPhoneNumber      *string  `json:"creatorPhoneNumber,omitempty"`
	CreatorAvatar           *string  `json:"creatorAvatar,omitempty"`
	CreatorTypes            []string `json:"creatorTypes,omitempty"`
	CreatorGenres           []string `json:"creatorGenres,omitempty"`
}

func toSessionView(s *models.SignupSession, nextStep string) sessionView {
	d := s.Draft
	return sessionView{
		ID:                 s.ID.String(),
		Identifier:         s.Identifier,
		IdentifierType:     string(s.IdentifierType),
		IdentifierVerified: s.IdentifierVerified,
		Status:             string(s.Status),
		Draft: publicDraft{
			DisplayName:             d.DisplayName,
			Username:                d.Username,
			DateOfBirth:             d.DateOfBirth,
			HasPassword:             d.PasswordHash != nil && *d.PasswordHash != "",
			PhoneCountryCode:        d.PhoneCountryCode,
			PhoneNumber:             d.PhoneNumber,
			Email:                   d.Email,
			Role:                    d.Role,
			Avatar:                  d.Avatar,
			InmateNumber:            d.InmateNumber,
			CreatorName:             d.CreatorName,
			InmateState:             d.InmateState,
			Relationship:            d.Relationship,
			ConsentToRecording:      d.ConsentToRecording,
			SelectedPlan:            d.SelectedPlan,
			BridgeNumber:            d.BridgeNumber,
			CreatorEmail:            d.CreatorEmail,
			HasCreatorPassword:      d.CreatorPasswordHash != nil && *d.CreatorPasswordHash != "",
			CreatorUsername:         d.CreatorUsername,
			CreatorDisplayName:      d.CreatorDisplayName,
			CreatorPhoneCountryCode: d.CreatorPhoneCountryCode,
			CreatorPhoneNumber:      d.CreatorPhoneNumber,
			CreatorAvatar:           d.CreatorAvatar,
			CreatorTypes:            d.CreatorTypes,
			CreatorGenres:           d.CreatorGenres,
		},
		CompletedSteps: []string(s.CompletedSteps),
		NextStep:       nextStep,
		ExpiresAt:      s.ExpiresAt.UTC().Format("2006-01-02T15:04:05Z"),
	}
}

// ── handlers ────────────────────────────────────────────────────────────────

// Start handles POST /signup/sessions.
// Public — no token required (this is the entry point).
func (h *SignupHandler) Start(c *fiber.Ctx) error {
	var req startSignupRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{Success: false, Error: "invalid request body"})
	}
	if req.Identifier == "" || req.IdentifierType == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{Success: false, Error: "identifier and identifierType are required"})
	}

	idType := models.IdentifierType(req.IdentifierType)
	result, err := h.svc.Start(c.Context(), req.Identifier, idType, req.Locale, c.IP(), req.DeviceID)
	if err != nil {
		return mapSignupErr(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(models.APIResponse{Success: true, Data: result})
}

// VerifyOTP handles POST /signup/sessions/:id/verify-otp.
// Public — the session ID is the credential here, paired with the OTP code.
func (h *SignupHandler) VerifyOTP(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{Success: false, Error: "invalid session id"})
	}
	var req signupVerifyOTPRequest
	if err := c.BodyParser(&req); err != nil || req.Code == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{Success: false, Error: "code is required"})
	}
	result, err := h.svc.VerifyOTP(c.Context(), id, req.Code)
	if err != nil {
		return mapSignupErr(c, err)
	}
	return c.JSON(models.APIResponse{Success: true, Data: fiber.Map{
		"sessionId": result.SessionID,
		"token":     result.Token,
		"expiresIn": result.ExpiresIn,
		"nextStep":  result.NextStep,
		"session":   toSessionView(result.DraftRecord, result.NextStep),
	}})
}

// Me handles GET /signup/sessions/me.
// Requires signup_pending scope. Returns the session bound to the token.
func (h *SignupHandler) Me(c *fiber.Ctx) error {
	sessionID, err := sessionIDFromClaims(c)
	if err != nil {
		return err
	}
	session, nextStep, err := h.svc.Get(c.Context(), sessionID)
	if err != nil {
		return mapSignupErr(c, err)
	}
	return c.JSON(models.APIResponse{Success: true, Data: toSessionView(session, nextStep)})
}

// Patch handles PATCH /signup/sessions/me with {draft: SignupDraft}.
// Server merges the patch and recomputes nextStep.
func (h *SignupHandler) Patch(c *fiber.Ctx) error {
	sessionID, err := sessionIDFromClaims(c)
	if err != nil {
		return err
	}
	var body struct {
		Draft models.SignupDraft `json:"draft"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{Success: false, Error: "invalid request body"})
	}
	// Map raw password from body so the service hashes it server-side.
	// The client sends `password` (plain) which we forward via PasswordHash;
	// the service detects raw vs hashed and bcrypts as needed.
	var rawBody struct {
		Draft struct {
			Password        *string `json:"password,omitempty"`
			CreatorPassword *string `json:"creatorPassword,omitempty"`
		} `json:"draft"`
	}
	_ = c.BodyParser(&rawBody)
	if rawBody.Draft.Password != nil {
		body.Draft.PasswordHash = rawBody.Draft.Password
	}
	if rawBody.Draft.CreatorPassword != nil {
		body.Draft.CreatorPasswordHash = rawBody.Draft.CreatorPassword
	}

	session, nextStep, err := h.svc.PatchDraft(c.Context(), sessionID, &body.Draft)
	if err != nil {
		return mapSignupErr(c, err)
	}
	return c.JSON(models.APIResponse{Success: true, Data: toSessionView(session, nextStep)})
}

// Complete handles POST /signup/sessions/me/complete.
// Promotes the session to a real users row and returns full-scope tokens.
func (h *SignupHandler) Complete(c *fiber.Ctx) error {
	sessionID, err := sessionIDFromClaims(c)
	if err != nil {
		return err
	}
	result, err := h.svc.Complete(c.Context(), sessionID)
	if err != nil {
		return mapSignupErr(c, err)
	}
	return c.JSON(models.APIResponse{Success: true, Data: result})
}

// Abandon handles DELETE /signup/sessions/me. The client calls this on "exit
// signup" so the identifier is freed immediately instead of waiting for TTL.
func (h *SignupHandler) Abandon(c *fiber.Ctx) error {
	sessionID, err := sessionIDFromClaims(c)
	if err != nil {
		return err
	}
	if err := h.svc.Abandon(c.Context(), sessionID); err != nil {
		return mapSignupErr(c, err)
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// ── helpers ─────────────────────────────────────────────────────────────────

// sessionIDFromClaims pulls the UUID out of the signup_pending claim's subject.
// Returns a Fiber error response (already sent) if the token is malformed.
func sessionIDFromClaims(c *fiber.Ctx) (uuid.UUID, error) {
	claims, ok := c.Locals("claims").(*middleware.JWTClaims)
	if !ok || claims == nil {
		return uuid.Nil, c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{Success: false, Error: "missing claims"})
	}
	idStr := middleware.SignupSessionID(claims)
	if idStr == "" {
		return uuid.Nil, c.Status(fiber.StatusForbidden).JSON(models.APIResponse{Success: false, Error: "token is not a signup token"})
	}
	id, err := uuid.Parse(idStr)
	if err != nil {
		return uuid.Nil, c.Status(fiber.StatusForbidden).JSON(models.APIResponse{Success: false, Error: "malformed session id in token"})
	}
	return id, nil
}

// mapSignupErr maps service-layer sentinel errors to HTTP statuses.
func mapSignupErr(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, services.ErrSignupSessionNotFound):
		return c.Status(fiber.StatusNotFound).JSON(models.APIResponse{Success: false, Error: err.Error()})
	case errors.Is(err, services.ErrSignupSessionExpired):
		return c.Status(fiber.StatusGone).JSON(models.APIResponse{Success: false, Error: err.Error()})
	case errors.Is(err, services.ErrSignupAlreadyExists), errors.Is(err, services.ErrUsernameTaken), errors.Is(err, services.ErrPhoneAlreadyRegistered):
		return c.Status(fiber.StatusConflict).JSON(models.APIResponse{Success: false, Error: err.Error()})
	case errors.Is(err, services.ErrInvalidOTP):
		return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{Success: false, Error: err.Error()})
	case errors.Is(err, services.ErrOTPNotVerified), errors.Is(err, services.ErrMissingRequired):
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{Success: false, Error: err.Error()})
	default:
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{Success: false, Error: err.Error()})
	}
}
