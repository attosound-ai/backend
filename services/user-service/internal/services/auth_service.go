package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"strconv"

	"github.com/atto-sound/user-service/internal/kafka"
	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
	"golang.org/x/crypto/bcrypt"
)

// strVal safely dereferences a string pointer, returning "" if nil.
func strVal(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// strPtr returns a pointer to the given string.
func strPtr(s string) *string {
	return &s
}

// AuthService encapsulates authentication business logic.
type AuthService struct {
	repo          *repositories.UserRepository
	jwtMgr        *middleware.JWTManager
	producer      *kafka.Producer
	otpServiceURL string
	httpClient    *http.Client
}

// NewAuthService creates a new AuthService instance.
func NewAuthService(repo *repositories.UserRepository, jwtMgr *middleware.JWTManager, producer *kafka.Producer, otpServiceURL string) *AuthService {
	return &AuthService{
		repo:          repo,
		jwtMgr:        jwtMgr,
		producer:      producer,
		otpServiceURL: otpServiceURL,
		httpClient:    &http.Client{Timeout: 10 * time.Second},
	}
}

// Register creates a new user account, hashes the password, stores both
// the user and credentials, publishes a user.created event, and returns tokens.
func (s *AuthService) Register(ctx context.Context, req *models.RegisterRequest) (*models.AuthResponse, error) {
	// Check if email is already taken (only if provided)
	if req.Email != nil && *req.Email != "" {
		existingEmail, err := s.repo.FindByEmail(strings.ToLower(*req.Email))
		if err != nil {
			return nil, errors.New("internal error checking email")
		}
		if existingEmail != nil {
			return nil, errors.New("email already registered")
		}
	}

	// Check if username is already taken
	existingUsername, err := s.repo.FindByUsername(req.Username)
	if err != nil {
		return nil, errors.New("internal error checking username")
	}
	if existingUsername != nil {
		return nil, errors.New("username already taken")
	}

	// Hash password
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		return nil, errors.New("failed to hash password")
	}

	var normalizedPhone *string
	if req.PhoneNumber != nil {
		n := normalizePhone(*req.PhoneNumber)
		normalizedPhone = &n
	}
	var emailPtr *string
	if req.Email != nil && *req.Email != "" {
		lower := strings.ToLower(*req.Email)
		emailPtr = &lower
	}
	user := &models.User{
		Username:         req.Username,
		Email:            emailPtr,
		PhoneCountryCode: req.PhoneCountryCode,
		PhoneNumber:      normalizedPhone,
		DisplayName:      req.DisplayName,
		Role:             models.Role(req.Role),
		InmateNumber:     req.InmateNumber,
	}

	creds := &models.UserCredentials{
		PasswordHash: string(hash),
	}

	if err := s.repo.CreateUserWithCredentials(user, creds); err != nil {
		log.Printf("[AUTH] Failed to create user: %v", err)
		return nil, errors.New("failed to create user")
	}

	// Publish user.created event (fire and forget, log errors). Legacy
	// register endpoint doesn't carry a locale, so default to "en" — the
	// new signup wizard captures and forwards the real value via the
	// signup_session path.
	userIDStr := strconv.FormatUint(user.ID, 10)
	go func() {
		eventData := map[string]interface{}{
			"id":          userIDStr,
			"username":    user.Username,
			"email":       strVal(user.Email),
			"displayName": user.DisplayName,
			"role":        string(user.Role),
			"locale":      "en",
		}
		if err := s.producer.Publish(context.Background(), "user.created", userIDStr, eventData); err != nil {
			log.Printf("[AUTH] Failed to publish user.created event: %v", err)
		}
	}()

	// Generate tokens
	tokens, err := s.jwtMgr.GenerateTokenPair(user)
	if err != nil {
		return nil, errors.New("failed to generate tokens")
	}

	return &models.AuthResponse{
		User:   user.ToProfile(),
		Tokens: tokens,
	}, nil
}

// LoginWithOTP authenticates a user by verifying an OTP code via the OTP service.
// Identifier can be an email (contains @) or a phone number (starts with +).
func (s *AuthService) LoginWithOTP(ctx context.Context, req *models.LoginOTPRequest) (*models.AuthResponse, error) {
	identifier := strings.TrimSpace(req.Identifier)
	isPhone := strings.HasPrefix(identifier, "+")

	// Verify OTP via the OTP microservice — always send as "phone"
	// because the OTP service now only accepts phone numbers.
	otpBody, _ := json.Marshal(map[string]string{
		"phone": identifier,
		"code":  req.OTP,
	})

	otpURL := fmt.Sprintf("%s/otp/verify", s.otpServiceURL)
	resp, err := s.httpClient.Post(otpURL, "application/json", bytes.NewReader(otpBody))
	if err != nil {
		log.Printf("[AUTH] Failed to reach OTP service: %v", err)
		return nil, errors.New("failed to verify code")
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var otpResp struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&otpResp)
		if otpResp.Error != "" {
			return nil, errors.New(otpResp.Error)
		}
		return nil, errors.New("invalid or expired code")
	}

	// OTP verified — look up user by phone or email
	var user *models.User
	if isPhone {
		user, err = s.repo.FindByFullPhone(identifier)
	} else {
		user, err = s.repo.FindByEmail(identifier)
	}
	if err != nil {
		return nil, errors.New("internal error")
	}
	if user == nil {
		return nil, errors.New("no account found for this identifier")
	}

	tokens, err := s.jwtMgr.GenerateTokenPair(user)
	if err != nil {
		return nil, errors.New("failed to generate tokens")
	}

	return &models.AuthResponse{
		User:   user.ToProfile(),
		Tokens: tokens,
	}, nil
}

// isDigitsOnly returns true if s contains only ASCII digits and is non-empty.
func isDigitsOnly(s string) bool {
	if len(s) == 0 {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// normalizePhone strips all non-digit characters from a phone number.
func normalizePhone(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] >= '0' && s[i] <= '9' {
			out = append(out, s[i])
		}
	}
	return string(out)
}

// Login authenticates a user by identifier (email, username, or phone) and password.
// Returns *models.AuthResponse if no 2FA, or *models.Login2FAResponse if 2FA is required.
func (s *AuthService) Login(ctx context.Context, req *models.LoginRequest) (interface{}, error) {
	identifier := strings.TrimSpace(req.Identifier)

	var user *models.User
	var err error

	switch {
	case strings.Contains(identifier, "@"):
		user, err = s.repo.FindByEmail(strings.ToLower(identifier))
	case isDigitsOnly(identifier):
		user, err = s.repo.FindByPhoneNumber(identifier)
	default:
		user, err = s.repo.FindByUsername(strings.ToLower(identifier))
	}

	if err != nil {
		return nil, errors.New("internal error")
	}
	if user == nil {
		return nil, errors.New("invalid credentials")
	}

	creds, err := s.repo.FindCredentialsByUserID(user.ID)
	if err != nil || creds == nil {
		return nil, errors.New("invalid credentials")
	}

	if err := bcrypt.CompareHashAndPassword([]byte(creds.PasswordHash), []byte(req.Password)); err != nil {
		return nil, errors.New("invalid credentials")
	}

	// Check if 2FA is enabled
	if creds.TwoFactorEnabled && creds.TwoFactorMethod != "" {
		tempToken, err := s.jwtMgr.Generate2FAToken(user.ID)
		if err != nil {
			return nil, errors.New("internal error")
		}

		// Send OTP to user's chosen channel
		var target string
		if creds.TwoFactorMethod == "email" {
			if user.Email == nil || *user.Email == "" {
				return nil, errors.New("no email on file for 2FA")
			}
			target = *user.Email
		} else {
			if user.PhoneCountryCode == nil || user.PhoneNumber == nil {
				return nil, errors.New("no phone number on file for 2FA")
			}
			target = *user.PhoneCountryCode + *user.PhoneNumber
		}
		s.sendOTPViaService(target, creds.TwoFactorMethod)

		return &models.Login2FAResponse{
			Requires2FA:  true,
			Method:       creds.TwoFactorMethod,
			TempToken:    tempToken,
			MaskedTarget: maskTarget(target, creds.TwoFactorMethod),
		}, nil
	}

	tokens, err := s.jwtMgr.GenerateTokenPair(user)
	if err != nil {
		return nil, errors.New("failed to generate tokens")
	}

	return &models.AuthResponse{
		User:   user.ToProfile(),
		Tokens: tokens,
	}, nil
}

// Login2FA completes the second step of 2FA login.
func (s *AuthService) Login2FA(ctx context.Context, req *models.Login2FARequest) (*models.AuthResponse, error) {
	claims, err := s.jwtMgr.Validate2FAToken(req.TempToken)
	if err != nil {
		return nil, errors.New("invalid or expired 2FA token")
	}

	userID, err := strconv.ParseUint(claims.UserID, 10, 64)
	if err != nil {
		return nil, errors.New("invalid token")
	}

	user, err := s.repo.FindByID(userID)
	if err != nil || user == nil {
		return nil, errors.New("user not found")
	}

	creds, err := s.repo.FindCredentialsByUserID(userID)
	if err != nil || creds == nil {
		return nil, errors.New("internal error")
	}

	// Determine OTP identifier
	var otpIdentifier string
	if creds.TwoFactorMethod == "email" {
		if user.Email == nil || *user.Email == "" {
			return nil, errors.New("no email on file for 2FA")
		}
		otpIdentifier = *user.Email
	} else {
		if user.PhoneCountryCode == nil || user.PhoneNumber == nil {
			return nil, errors.New("no phone on file")
		}
		otpIdentifier = *user.PhoneCountryCode + *user.PhoneNumber
	}

	// Verify OTP via OTP service
	if err := s.verifyOTPViaService(otpIdentifier, req.Code, creds.TwoFactorMethod); err != nil {
		return nil, err
	}

	tokens, err := s.jwtMgr.GenerateTokenPair(user)
	if err != nil {
		return nil, errors.New("failed to generate tokens")
	}

	return &models.AuthResponse{
		User:   user.ToProfile(),
		Tokens: tokens,
	}, nil
}

// Enable2FAInit sends a verification OTP to confirm the user controls the channel.
func (s *AuthService) Enable2FAInit(ctx context.Context, userID string, req *models.Enable2FARequest) (string, error) {
	uid, err := strconv.ParseUint(userID, 10, 64)
	if err != nil {
		return "", errors.New("invalid user ID")
	}

	user, err := s.repo.FindByID(uid)
	if err != nil || user == nil {
		return "", errors.New("user not found")
	}

	var target string
	if req.Method == "email" {
		if user.Email == nil || *user.Email == "" {
			return "", errors.New("no email on file — add an email first")
		}
		target = *user.Email
	} else {
		if user.PhoneCountryCode == nil || user.PhoneNumber == nil {
			return "", errors.New("no phone number on file — add a phone number first")
		}
		target = *user.PhoneCountryCode + *user.PhoneNumber
	}

	s.sendOTPViaService(target, req.Method)
	return maskTarget(target, req.Method), nil
}

// Enable2FAConfirm verifies the OTP and enables 2FA.
func (s *AuthService) Enable2FAConfirm(ctx context.Context, userID string, req *models.Verify2FASetupRequest) error {
	uid, err := strconv.ParseUint(userID, 10, 64)
	if err != nil {
		return errors.New("invalid user ID")
	}

	user, err := s.repo.FindByID(uid)
	if err != nil || user == nil {
		return errors.New("user not found")
	}

	var otpIdentifier string
	if req.Method == "email" {
		if user.Email == nil || *user.Email == "" {
			return errors.New("no email on file")
		}
		otpIdentifier = *user.Email
	} else {
		if user.PhoneCountryCode == nil || user.PhoneNumber == nil {
			return errors.New("no phone number on file")
		}
		otpIdentifier = *user.PhoneCountryCode + *user.PhoneNumber
	}

	if err := s.verifyOTPViaService(otpIdentifier, req.Code, req.Method); err != nil {
		return err
	}

	return s.repo.UpdateCredentials2FA(uid, true, req.Method)
}

// Disable2FA turns off 2FA after password verification.
func (s *AuthService) Disable2FA(ctx context.Context, userID string, req *models.Disable2FARequest) error {
	uid, err := strconv.ParseUint(userID, 10, 64)
	if err != nil {
		return errors.New("invalid user ID")
	}

	creds, err := s.repo.FindCredentialsByUserID(uid)
	if err != nil || creds == nil {
		return errors.New("internal error")
	}

	if err := bcrypt.CompareHashAndPassword([]byte(creds.PasswordHash), []byte(req.Password)); err != nil {
		return errors.New("incorrect password")
	}

	return s.repo.UpdateCredentials2FA(uid, false, "")
}

// sendOTPViaService sends an OTP via the OTP microservice.
func (s *AuthService) sendOTPViaService(target, channel string) {
	body := map[string]string{"channel": channel}
	if channel == "email" {
		body["email"] = target
	} else {
		body["phone"] = target
	}
	jsonBody, _ := json.Marshal(body)
	otpURL := fmt.Sprintf("%s/otp/send", s.otpServiceURL)
	resp, err := s.httpClient.Post(otpURL, "application/json", bytes.NewReader(jsonBody))
	if err != nil {
		log.Printf("[AUTH] Failed to send 2FA OTP: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("[AUTH] OTP service returned %d for 2FA send", resp.StatusCode)
	}
}

// verifyOTPViaService verifies an OTP code via the OTP microservice.
func (s *AuthService) verifyOTPViaService(identifier, code, channel string) error {
	body := map[string]string{"code": code, "channel": channel}
	if channel == "email" {
		body["email"] = identifier
	} else {
		body["phone"] = identifier
	}
	jsonBody, _ := json.Marshal(body)
	otpURL := fmt.Sprintf("%s/otp/verify", s.otpServiceURL)
	resp, err := s.httpClient.Post(otpURL, "application/json", bytes.NewReader(jsonBody))
	if err != nil {
		return errors.New("failed to verify code")
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var otpResp struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&otpResp)
		if otpResp.Error != "" {
			return errors.New(otpResp.Error)
		}
		return errors.New("invalid or expired code")
	}
	return nil
}

// maskTarget masks an email or phone for display (e.g. "d***@gmail.com", "***1234").
func maskTarget(target, method string) string {
	if method == "email" {
		parts := strings.SplitN(target, "@", 2)
		if len(parts) == 2 {
			name := parts[0]
			if len(name) > 2 {
				return name[:1] + strings.Repeat("*", len(name)-2) + name[len(name)-1:] + "@" + parts[1]
			}
			return name[:1] + "***@" + parts[1]
		}
		return "***"
	}
	if len(target) > 4 {
		return strings.Repeat("*", len(target)-4) + target[len(target)-4:]
	}
	return "***"
}

// RefreshToken validates a refresh token and issues a new access token.
func (s *AuthService) RefreshToken(ctx context.Context, refreshToken string) (*models.TokenPair, error) {
	claims, err := s.jwtMgr.ValidateToken(refreshToken)
	if err != nil {
		return nil, errors.New("invalid or expired refresh token")
	}

	userID, err := strconv.ParseUint(claims.UserID, 10, 64)
	if err != nil {
		return nil, errors.New("invalid token claims")
	}

	user, err := s.repo.FindByID(userID)
	if err != nil || user == nil {
		return nil, errors.New("user not found")
	}

	tokens, err := s.jwtMgr.GenerateTokenPair(user)
	if err != nil {
		return nil, errors.New("failed to generate tokens")
	}

	return tokens, nil
}

// CheckPhoneAvailability returns true if the phone is not yet registered.
func (s *AuthService) CheckPhoneAvailability(phone string) (bool, error) {
	existing, err := s.repo.FindByFullPhone(phone)
	if err != nil {
		return false, errors.New("internal error")
	}
	return existing == nil, nil
}

// CheckUsernameAvailability returns true if the username is not taken.
// If excludeUserID is non-empty, that user's own username is not considered taken.
func (s *AuthService) CheckUsernameAvailability(username string, excludeUserID string) (bool, error) {
	existing, err := s.repo.FindByUsername(strings.ToLower(username))
	if err != nil {
		return false, errors.New("internal error")
	}
	if existing == nil {
		return true, nil
	}
	// If the found user is the caller themselves, treat as available
	if excludeUserID != "" && strconv.FormatUint(existing.ID, 10) == excludeUserID {
		return true, nil
	}
	return false, nil
}

// CheckEmailAvailability returns true if the email is not yet registered.
func (s *AuthService) CheckEmailAvailability(email string) (bool, error) {
	existing, err := s.repo.FindByEmail(strings.ToLower(email))
	if err != nil {
		return false, errors.New("internal error")
	}
	return existing == nil, nil
}

// Note: the previous PreRegister / CompleteRegistration two-step flow was
// replaced by the signup_sessions architecture (see signup_service.go).
// The legacy HTTP routes still exist but respond 426 Upgrade Required.

// SwitchAccount generates fresh tokens for a linked account without requiring a password.
// Caller must be the representative of the target, or the target must be the caller's representative.
func (s *AuthService) SwitchAccount(ctx context.Context, callerID string, targetUserID uint64) (*models.AuthResponse, error) {
	uid, err := strconv.ParseUint(callerID, 10, 64)
	if err != nil {
		return nil, errors.New("invalid user ID")
	}

	caller, err := s.repo.FindByID(uid)
	if err != nil || caller == nil {
		return nil, errors.New("user not found")
	}

	target, err := s.repo.FindByID(targetUserID)
	if err != nil || target == nil {
		return nil, errors.New("target user not found")
	}

	// Authorization: accounts must be linked. Self-switch (target == caller)
	// is allowed and idempotent: it just re-issues tokens for the account
	// the caller already is. A client whose UI identity drifted from its
	// token converges on retry instead of dead-ending on a 403 (Aug 1 2026:
	// a desynced client self-switched, got "accounts are not linked", and
	// the user was stuck unable to switch profiles).
	authorized := target.ID == uid
	if target.RepresentativeID != nil && *target.RepresentativeID == uid {
		authorized = true // rep → their managed creator
	}
	if caller.RepresentativeID != nil && *caller.RepresentativeID == target.ID {
		authorized = true // managed creator → their rep
	}
	if !authorized {
		return nil, errors.New("forbidden: accounts are not linked")
	}

	tokens, err := s.jwtMgr.GenerateTokenPair(target)
	if err != nil {
		return nil, errors.New("failed to generate tokens")
	}

	return &models.AuthResponse{
		User:   target.ToProfile(),
		Tokens: tokens,
	}, nil
}

// GetLinkedAccounts returns the accounts linked to the given caller.
func (s *AuthService) GetLinkedAccounts(ctx context.Context, callerID string) ([]*models.UserProfile, error) {
	uid, err := strconv.ParseUint(callerID, 10, 64)
	if err != nil {
		return nil, errors.New("invalid user ID")
	}

	caller, err := s.repo.FindByID(uid)
	if err != nil || caller == nil {
		return nil, errors.New("user not found")
	}

	linked, err := s.repo.GetLinkedAccounts(uid, caller.IsManagedAccount, caller.RepresentativeID)
	if err != nil {
		return nil, fmt.Errorf("failed to get linked accounts: %w", err)
	}

	profiles := make([]*models.UserProfile, len(linked))
	for i, u := range linked {
		profiles[i] = u.ToProfile()
	}
	return profiles, nil
}

// resolvePasswordResetUser maps an inbound identifier (email or username)
// to the user account we will reset, plus the email address the OTP should
// be sent to / verified against. For managed creators (no email of their
// own) the OTP recipient is the linked representative's email — this is
// the only recovery channel available since the creator account has no
// contact info.
//
// Returns (target user, OTP recipient email, error). When the identifier
// doesn't match anything, returns (nil, "", nil) so the caller can short-
// circuit to a generic success response and avoid enumerating accounts.
func (s *AuthService) resolvePasswordResetUser(identifier string) (*models.User, string, error) {
	identifier = strings.TrimSpace(identifier)
	if identifier == "" {
		return nil, "", nil
	}

	var user *models.User
	var err error

	if strings.Contains(identifier, "@") {
		// Treat as an email — covers reps, listeners, and anyone else with
		// a registered email.
		user, err = s.repo.FindByEmail(strings.ToLower(identifier))
	} else {
		// Treat as a username — covers managed creators (no email) and
		// anyone who prefers their handle for recovery.
		user, err = s.repo.FindByUsername(identifier)
	}
	if err != nil || user == nil {
		return nil, "", err
	}

	// If the user has their own email, use it.
	if user.Email != nil && strVal(user.Email) != "" {
		return user, strVal(user.Email), nil
	}

	// Managed creator with no email of their own — fall back to the
	// linked representative's email. Without this, the account is
	// unrecoverable through any self-service path.
	if user.RepresentativeID != nil {
		rep, repErr := s.repo.FindByID(*user.RepresentativeID)
		if repErr == nil && rep != nil && rep.Email != nil && strVal(rep.Email) != "" {
			return user, strVal(rep.Email), nil
		}
	}

	// No usable contact channel — caller will treat as "user not found".
	return nil, "", nil
}

// pickRecoveryIdentifier returns the field we should look up against.
// New clients send `Identifier`; older clients still send `Email`. Prefer
// `Identifier` so a client that knows about the unified field always wins.
func pickRecoveryIdentifier(email, identifier string) string {
	if strings.TrimSpace(identifier) != "" {
		return identifier
	}
	return email
}

// ForgotPassword sends an OTP for password reset. The OTP goes to the
// account's own email when one exists; for managed creators (no email)
// it goes to the linked representative's email.
//
// Always returns nil to prevent account enumeration via the response.
func (s *AuthService) ForgotPassword(ctx context.Context, req *models.ForgotPasswordRequest) error {
	identifier := pickRecoveryIdentifier(req.Email, req.Identifier)
	user, otpEmail, err := s.resolvePasswordResetUser(identifier)
	if err != nil || user == nil || otpEmail == "" {
		return nil
	}

	otpBody, _ := json.Marshal(map[string]string{
		"email":          otpEmail,
		"locale":         req.Locale,
		"email_template": "password-reset",
	})
	otpURL := fmt.Sprintf("%s/otp/send", s.otpServiceURL)
	resp, err := s.httpClient.Post(otpURL, "application/json", bytes.NewReader(otpBody))
	if err != nil {
		log.Printf("[AUTH] Failed to send password reset OTP for %s: %v", identifier, err)
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("[AUTH] OTP service returned %d for password reset: %s", resp.StatusCode, identifier)
	}
	return nil
}

// ResetPassword verifies the OTP (sent to the resolved email) and updates
// the target user's password — even when the OTP went to a different
// address (managed creator → linked representative).
func (s *AuthService) ResetPassword(ctx context.Context, req *models.ResetPasswordRequest) error {
	identifier := pickRecoveryIdentifier(req.Email, req.Identifier)
	user, otpEmail, err := s.resolvePasswordResetUser(identifier)
	if err != nil || user == nil || otpEmail == "" {
		return errors.New("invalid request")
	}

	// Verify OTP via OTP service (email channel)
	otpBody, _ := json.Marshal(map[string]string{
		"channel": "email",
		"email":   otpEmail,
		"code":    req.OTP,
	})
	otpURL := fmt.Sprintf("%s/otp/verify", s.otpServiceURL)
	resp, err := s.httpClient.Post(otpURL, "application/json", bytes.NewReader(otpBody))
	if err != nil {
		log.Printf("[AUTH] Failed to reach OTP service for password reset: %v", err)
		return errors.New("failed to verify code")
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return errors.New("invalid or expired code")
	}

	// Hash and store new password ON THE TARGET USER, not the rep —
	// even when the OTP went to the rep, we are resetting the creator's
	// credentials (that's the whole point of the recovery flow).
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		return errors.New("failed to process new password")
	}

	return s.repo.UpdateCredentialsPassword(user.ID, string(hash))
}

// GetCurrentUser retrieves the user profile for the given user ID (from JWT claims).
func (s *AuthService) GetCurrentUser(ctx context.Context, userID string) (*models.UserProfile, error) {
	uid, err := strconv.ParseUint(userID, 10, 64)
	if err != nil {
		return nil, errors.New("invalid user ID")
	}

	user, err := s.repo.FindByID(uid)
	if err != nil {
		return nil, errors.New("internal error")
	}
	if user == nil {
		return nil, errors.New("user not found")
	}

	creds, _ := s.repo.FindCredentialsByUserID(uid)
	return user.ToProfileWith2FA(creds), nil
}
