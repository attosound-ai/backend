package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
	"github.com/atto-sound/user-service/internal/services"
	"github.com/gofiber/fiber/v2"
)

// UserHandler handles HTTP requests related to user profiles.
type UserHandler struct {
	userService *services.UserService
	// profiles serves the routes that show one account to another (by id,
	// search, discover). It is the same UserService; the interface lets the
	// tests check what a stranger receives without a database.
	profiles      profileSource
	otpServiceURL string
}

// profileSource is what the profile routes read.
type profileSource interface {
	GetUserByID(ctx context.Context, id string) (*models.UserProfile, error)
	SearchUsers(ctx context.Context, query string, limit int) ([]*models.UserProfile, error)
	SearchUsersExact(ctx context.Context, query string) ([]*models.UserProfile, error)
	DiscoverUsers(ctx context.Context, excludeID uint64, limit int) ([]*models.UserProfile, error)
	GetLinkedAccountIDsForUser(userID uint64) ([]uint64, error)
	GetActivePushTokensForUser(userID uint64) ([]models.PushToken, error)
}

// MountInternalRoutes registers the server to server routes under /users
// behind guard (middleware.RequireInternalCallerOrOwner in production). Kept
// here so cmd/server/main.go and the tests mount them the same way: a route
// added without the guard would fail the tests.
func (h *UserHandler) MountInternalRoutes(users fiber.Router, guard fiber.Handler) {
	// telephony-service: TwiML fan out across a device's linked accounts.
	users.Get("/:id/linked-account-ids", guard, h.GetLinkedAccountIDs)
	// telephony-service: missed call push when the Voice SDK invite fails.
	users.Get("/:id/push-tokens", guard, h.GetPushTokens)
}

// NewUserHandler creates a new UserHandler.
func NewUserHandler(userService *services.UserService, otpServiceURL ...string) *UserHandler {
	url := "http://otp-service:8000"
	if len(otpServiceURL) > 0 && otpServiceURL[0] != "" {
		url = otpServiceURL[0]
	}
	return &UserHandler{userService: userService, profiles: userService, otpServiceURL: url}
}

// GetPushTokens handles GET /users/:id/push-tokens.
//
// Returns the active Expo push tokens registered for the user, so
// telephony-service can fall back to a regular APNS/FCM push when an
// incoming-call invite fails to reach the Voice SDK (no answer / unreachable
// device). Only a sibling service token or the owner's session reaches it
// (see MountInternalRoutes); until Nov 12 2026 it answered anyone.
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

	tokens, err := h.profiles.GetActivePushTokensForUser(id)
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

	ids, err := h.profiles.GetLinkedAccountIDsForUser(id)
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

	profile, err := h.profiles.GetUserByID(c.Context(), id)
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

	var data interface{} = profile.Public()
	if h.canSeePrivate(c, profile.ID) {
		data = profile
	}
	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    data,
	})
}

// viewerID is the signed in caller, or "" (set by RequireAuth or OptionalAuth).
func viewerID(c *fiber.Ctx) string {
	v, _ := c.Locals("userID").(string)
	return v
}

// canSeePrivate: the caller is the owner of the profile or one of its linked
// accounts (a representative and the creators it manages).
func (h *UserHandler) canSeePrivate(c *fiber.Ctx, profileID uint64) bool {
	viewer := viewerID(c)
	if viewer == "" {
		return false
	}
	if viewer == strconv.FormatUint(profileID, 10) {
		return true
	}
	ids, err := h.profiles.GetLinkedAccountIDsForUser(profileID)
	if err != nil {
		return false
	}
	for _, id := range ids {
		if strconv.FormatUint(id, 10) == viewer {
			return true
		}
	}
	return false
}

// publicList shows every profile as models.PublicProfile except the caller's
// own. Lists never carry another account's private fields, linked or not.
func publicList(c *fiber.Ctx, profiles []*models.UserProfile) []interface{} {
	viewer := viewerID(c)
	out := make([]interface{}, 0, len(profiles))
	for _, p := range profiles {
		if p == nil {
			continue
		}
		if viewer != "" && strconv.FormatUint(p.ID, 10) == viewer {
			out = append(out, p)
			continue
		}
		out = append(out, p.Public())
	}
	return out
}

// SearchUsers handles GET /users/search?q=term&limit=20
//
// Nov 12 2026, the directory could be copied through here (q=_ matched every
// account, with or without a session). Now:
//   - signed in: literal match on username or display name, at least 2
//     characters, at most 20 rows (limit above 20 is cut to 20);
//   - no session: only the account whose username is exactly q (ignoring
//     case), at most 1 row. TestNumberNotice looks up the official account
//     this way during signup, before there is a session.
func (h *UserHandler) SearchUsers(c *fiber.Ctx) error {
	// Copied: fiber's value points into a buffer reused by the next request.
	query := strings.Clone(c.Query("q"))
	if query == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "query parameter 'q' is required",
		})
	}

	var (
		profiles []*models.UserProfile
		err      error
	)
	if viewerID(c) == "" {
		profiles, err = h.profiles.SearchUsersExact(c.Context(), query)
		if len(profiles) > 1 {
			profiles = profiles[:1]
		}
	} else {
		limit := repositories.SearchLimit
		if l := c.Query("limit"); l != "" {
			if parsed, perr := strconv.Atoi(l); perr == nil && parsed > 0 && parsed < limit {
				limit = parsed
			}
		}
		profiles, err = h.profiles.SearchUsers(c.Context(), query, limit)
		if len(profiles) > limit {
			profiles = profiles[:limit]
		}
	}
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    publicList(c, profiles),
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
		if errors.Is(err, services.ErrInmateNumberTaken) {
			return c.Status(fiber.StatusConflict).JSON(models.APIResponse{
				Success: false,
				Error:   err.Error(),
				Code:    services.InmateNumberTakenCode,
			})
		}
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

	profiles, err := h.profiles.DiscoverUsers(c.Context(), uid, limit)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.Status(fiber.StatusOK).JSON(models.APIResponse{
		Success: true,
		Data:    publicList(c, profiles),
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
	// Reason is optional: the app may send what the person picked.
	Reason string `json:"reason"`
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

	// Purge all data, with the record of who did it.
	who := "account " + claims.UserID
	if profile, perr := h.userService.GetUserByID(c.Context(), claims.UserID); perr == nil && profile != nil {
		who = profile.Username + " (" + claims.UserID + ")"
	}
	meta := services.DeletionMeta{
		Via:         models.DeletionViaSelfService,
		RequestedBy: who + ", from the app with an OTP",
		PerformedBy: who,
		Reason:      req.Reason,
		ActorUserID: &uid,
		ClientIP:    clientIP(c),
		UserAgent:   string(c.Request().Header.UserAgent()),
	}
	if err := h.userService.DeleteAccount(c.Context(), uid, req.DeleteLinkedAccounts, meta); err != nil {
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

// clientIP prefers the first X-Forwarded-For hop (the gateway adds it).
func clientIP(c *fiber.Ctx) string {
	if xff := c.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	return c.IP()
}
