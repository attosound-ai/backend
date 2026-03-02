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
	// Check if email is already taken
	existingEmail, err := s.repo.FindByEmail(req.Email)
	if err != nil {
		return nil, errors.New("internal error checking email")
	}
	if existingEmail != nil {
		return nil, errors.New("email already registered")
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

	user := &models.User{
		Username:         req.Username,
		Email:            req.Email,
		PhoneCountryCode: req.PhoneCountryCode,
		PhoneNumber:      req.PhoneNumber,
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

	// Publish user.created event (fire and forget, log errors)
	userIDStr := strconv.FormatUint(user.ID, 10)
	go func() {
		eventData := map[string]interface{}{
			"id":          userIDStr,
			"username":    user.Username,
			"email":       user.Email,
			"displayName": user.DisplayName,
			"role":        string(user.Role),
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

// Login authenticates a user by email and password, returning tokens on success.
func (s *AuthService) Login(ctx context.Context, req *models.LoginRequest) (*models.AuthResponse, error) {
	user, err := s.repo.FindByEmail(req.Email)
	if err != nil {
		return nil, errors.New("internal error")
	}
	if user == nil {
		return nil, errors.New("invalid email or password")
	}

	creds, err := s.repo.FindCredentialsByUserID(user.ID)
	if err != nil || creds == nil {
		return nil, errors.New("invalid email or password")
	}

	if err := bcrypt.CompareHashAndPassword([]byte(creds.PasswordHash), []byte(req.Password)); err != nil {
		return nil, errors.New("invalid email or password")
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

// PreRegister creates a minimal user account after OTP verification.
// The user is created with role "listener" and registration_status "pending".
// If an email already exists with status "pending", returns the existing tokens (idempotent).
func (s *AuthService) PreRegister(ctx context.Context, req *models.PreRegisterRequest) (*models.AuthResponse, error) {
	// Check if email already exists
	existing, err := s.repo.FindByEmail(req.Email)
	if err != nil {
		return nil, errors.New("internal error checking email")
	}

	// Idempotent: if user exists with pending status, return existing tokens
	if existing != nil {
		if existing.RegistrationStatus == "pending" {
			tokens, err := s.jwtMgr.GenerateTokenPair(existing)
			if err != nil {
				return nil, errors.New("failed to generate tokens")
			}
			return &models.AuthResponse{
				User:   existing.ToProfile(),
				Tokens: tokens,
			}, nil
		}
		return nil, errors.New("email already registered")
	}

	// Check if username is already taken
	existingUsername, err := s.repo.FindByUsername(req.Username)
	if err != nil {
		return nil, errors.New("internal error checking username")
	}
	if existingUsername != nil {
		return nil, errors.New("username already taken")
	}

	// Check if phone number is already registered
	if req.PhoneCountryCode != nil && req.PhoneNumber != nil && *req.PhoneCountryCode != "" && *req.PhoneNumber != "" {
		existingPhone, err := s.repo.FindByPhone(*req.PhoneCountryCode, *req.PhoneNumber)
		if err != nil {
			return nil, errors.New("internal error checking phone")
		}
		if existingPhone != nil {
			return nil, errors.New("phone number already registered")
		}
	}

	// Hash password
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		return nil, errors.New("failed to hash password")
	}

	user := &models.User{
		Username:           req.Username,
		Email:              req.Email,
		PhoneCountryCode:   req.PhoneCountryCode,
		PhoneNumber:        req.PhoneNumber,
		DisplayName:        req.DisplayName,
		Role:               models.RoleListener,
		RegistrationStatus: "pending",
	}

	creds := &models.UserCredentials{
		PasswordHash: string(hash),
	}

	if err := s.repo.CreateUserWithCredentials(user, creds); err != nil {
		log.Printf("[AUTH] Failed to pre-register user: %v", err)
		return nil, errors.New("failed to create user")
	}

	// Publish user.pre_registered event
	preRegIDStr := strconv.FormatUint(user.ID, 10)
	go func() {
		eventData := map[string]interface{}{
			"id":          preRegIDStr,
			"username":    user.Username,
			"email":       user.Email,
			"displayName": user.DisplayName,
		}
		if err := s.producer.Publish(context.Background(), "user.pre_registered", preRegIDStr, eventData); err != nil {
			log.Printf("[AUTH] Failed to publish user.pre_registered event: %v", err)
		}
	}()

	tokens, err := s.jwtMgr.GenerateTokenPair(user)
	if err != nil {
		return nil, errors.New("failed to generate tokens")
	}

	return &models.AuthResponse{
		User:   user.ToProfile(),
		Tokens: tokens,
	}, nil
}

// CompleteRegistration finalizes a pending registration by setting the role
// and optional representative fields, then returns updated tokens.
func (s *AuthService) CompleteRegistration(ctx context.Context, userID string, req *models.CompleteRegistrationRequest) (*models.AuthResponse, error) {
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

	log.Printf("[AUTH] CompleteRegistration user=%s current_role=%s requested_role=%s status=%s",
		userID, string(user.Role), req.Role, user.RegistrationStatus)

	// Always update role and registration status (even if already completed,
	// to fix cases where a previous attempt set the wrong role).
	updates := map[string]interface{}{
		"role":                models.Role(req.Role),
		"registration_status": "completed",
	}

	if req.InmateNumber != nil {
		updates["inmate_number"] = *req.InmateNumber
	}

	if req.RepresentativeFields != nil {
		updates["artist_name"] = req.RepresentativeFields.ArtistName
		updates["inmate_state"] = req.RepresentativeFields.InmateState
		updates["relationship"] = req.RepresentativeFields.Relationship
		updates["consent_to_recording"] = req.RepresentativeFields.ConsentToRecording
	}

	if err := s.repo.UpdateUserFields(uid, updates); err != nil {
		log.Printf("[AUTH] Failed to complete registration for user %s: %v", userID, err)
		return nil, errors.New("failed to complete registration")
	}

	// Reload user to get updated fields
	user, err = s.repo.FindByID(uid)
	if err != nil || user == nil {
		return nil, errors.New("internal error")
	}

	log.Printf("[AUTH] CompleteRegistration success user=%s role=%s", userID, string(user.Role))

	// Publish user.created event (full registration completed)
	completeIDStr := strconv.FormatUint(user.ID, 10)
	go func() {
		eventData := map[string]interface{}{
			"id":          completeIDStr,
			"username":    user.Username,
			"email":       user.Email,
			"displayName": user.DisplayName,
			"role":        string(user.Role),
		}
		if err := s.producer.Publish(context.Background(), "user.created", completeIDStr, eventData); err != nil {
			log.Printf("[AUTH] Failed to publish user.created event: %v", err)
		}
	}()

	// Re-generate tokens with updated role in claims
	tokens, err := s.jwtMgr.GenerateTokenPair(user)
	if err != nil {
		return nil, errors.New("failed to generate tokens")
	}

	return &models.AuthResponse{
		User:   user.ToProfile(),
		Tokens: tokens,
	}, nil
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

	return user.ToProfile(), nil
}
