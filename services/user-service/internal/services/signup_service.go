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

	"github.com/atto-sound/user-service/internal/kafka"
	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
	"github.com/atto-sound/user-service/internal/validation"
	"github.com/google/uuid"
	"github.com/lib/pq"
	"golang.org/x/crypto/bcrypt"
)

// Sentinel errors so handlers can map them to HTTP statuses without parsing
// strings. Anything not in this list maps to 500.
var (
	ErrSignupSessionNotFound  = errors.New("signup session not found")
	ErrSignupSessionExpired   = errors.New("signup session expired or abandoned")
	ErrSignupAlreadyExists    = errors.New("identifier already has an account")
	ErrInvalidOTP             = errors.New("invalid or expired code")
	ErrOTPNotVerified         = errors.New("otp not verified for this session")
	ErrMissingRequired        = errors.New("missing required fields")
	ErrUsernameTaken          = errors.New("username already taken")
	ErrPhoneAlreadyRegistered = errors.New("phone number already registered")
)

// SignupSessionTTL controls how long a started/verified session stays usable.
// Past this, the cron flips it to abandoned; the unique partial index then
// frees the identifier so the user can start fresh.
const SignupSessionTTL = 24 * time.Hour

// SignupService owns the in-progress signup state machine. It does NOT touch
// the users table directly — promotion happens atomically in Complete().
type SignupService struct {
	signupRepo    *repositories.SignupRepository
	userRepo      *repositories.UserRepository
	jwtMgr        *middleware.JWTManager
	producer      *kafka.Producer
	otpServiceURL string
	httpClient    *http.Client
}

func NewSignupService(
	signupRepo *repositories.SignupRepository,
	userRepo *repositories.UserRepository,
	jwtMgr *middleware.JWTManager,
	producer *kafka.Producer,
	otpServiceURL string,
) *SignupService {
	return &SignupService{
		signupRepo:    signupRepo,
		userRepo:      userRepo,
		jwtMgr:        jwtMgr,
		producer:      producer,
		otpServiceURL: otpServiceURL,
		httpClient:    &http.Client{Timeout: 10 * time.Second},
	}
}

// SignupStartResult is what the client gets back after starting a session.
// No token yet — the token is issued after OTP verification.
type SignupStartResult struct {
	SessionID string `json:"sessionId"`
	OTPSent   bool   `json:"otpSent"`
}

// Start creates a new signup session for the given identifier and triggers
// an OTP send via the OTP service. If an active session already exists for
// the identifier, it is reused (idempotent — safe to retry from the client).
// If a confirmed user already owns the identifier, returns ErrSignupAlreadyExists.
func (s *SignupService) Start(
	ctx context.Context,
	identifier string,
	identifierType models.IdentifierType,
	locale string,
	ip string,
	deviceID string,
) (*SignupStartResult, error) {
	identifier = strings.TrimSpace(identifier)
	if identifier == "" {
		return nil, ErrMissingRequired
	}
	if identifierType == models.IdentifierEmail {
		identifier = strings.ToLower(identifier)
	}

	// Refuse if a confirmed user already owns this identifier.
	switch identifierType {
	case models.IdentifierEmail:
		existing, err := s.userRepo.FindByEmail(identifier)
		if err != nil {
			return nil, fmt.Errorf("check existing email: %w", err)
		}
		if existing != nil {
			return nil, ErrSignupAlreadyExists
		}
	case models.IdentifierPhone:
		existing, err := s.userRepo.FindByFullPhone(identifier)
		if err != nil {
			return nil, fmt.Errorf("check existing phone: %w", err)
		}
		if existing != nil {
			return nil, ErrSignupAlreadyExists
		}
	default:
		return nil, errors.New("invalid identifier type")
	}

	// Reuse active session for idempotency.
	session, err := s.signupRepo.FindActiveByIdentifier(identifier)
	if err != nil {
		return nil, fmt.Errorf("find existing session: %w", err)
	}
	if session == nil {
		session = &models.SignupSession{
			Identifier:     identifier,
			IdentifierType: identifierType,
			Status:         models.SignupStatusStarted,
			ExpiresAt:      time.Now().Add(SignupSessionTTL),
		}
		if ip != "" {
			session.IPFirstSeen = &ip
		}
		if deviceID != "" {
			session.DeviceID = &deviceID
		}
		// Pre-fill draft with the identifier so the client doesn't have to re-send it.
		if identifierType == models.IdentifierEmail {
			session.Draft.Email = &identifier
		}
		if locale != "" {
			loc := locale
			session.Draft.Locale = &loc
		}
		if err := s.signupRepo.Create(session); err != nil {
			return nil, fmt.Errorf("create signup session: %w", err)
		}
	} else if locale != "" && (session.Draft.Locale == nil || *session.Draft.Locale == "") {
		// Existing session being reused — backfill locale if it wasn't set yet
		// (e.g. session created by an older client that didn't ship locale).
		loc := locale
		session.Draft.Locale = &loc
		_ = s.signupRepo.Update(session)
	}

	// Trigger OTP send (best-effort, but we surface failure — the user can't
	// proceed without a code).
	if err := s.sendOTP(identifier, identifierType, locale); err != nil {
		log.Printf("[SIGNUP] OTP send failed for session %s: %v", session.ID, err)
		return nil, err
	}

	return &SignupStartResult{SessionID: session.ID.String(), OTPSent: true}, nil
}

// VerifyOTPResult is returned after a successful OTP verification — the client
// now has a signup_pending token bound to the session.
type VerifyOTPResult struct {
	SessionID   string `json:"sessionId"`
	Token       string `json:"token"`
	ExpiresIn   int64  `json:"expiresIn"`
	NextStep    string `json:"nextStep"`
	DraftRecord *models.SignupSession `json:"session"`
}

// VerifyOTP confirms the OTP code with the OTP service. On success the session
// transitions to "verified" and a signup_pending token is issued.
//
// Two robustness properties matter here:
//
//  1. **Optional draft merge.** Callers may include partial draft fields
//     (displayName, dateOfBirth, password, …) which are merged into the
//     session *before* the OTP is verified. If the request reaches the
//     server but the response is lost mid-flight, the draft is persisted
//     regardless — so when the client retries (with a new code, after
//     resend), name/dob/password are already on the server.
//  2. **Idempotent re-verify for verified sessions.** If the session is
//     already in `verified` status, this call skips the OTP roundtrip and
//     just re-issues a fresh signup_pending token. The session_id is a
//     capability — possessing it after a successful verify is sufficient to
//     reclaim the token (e.g. recovering from a lost-response retry). The
//     OTP is single-use, so the alternative would brick the user.
func (s *SignupService) VerifyOTP(
	ctx context.Context,
	sessionID uuid.UUID,
	code string,
	draft *models.SignupDraft,
) (*VerifyOTPResult, error) {
	session, err := s.signupRepo.FindByID(sessionID)
	if err != nil {
		return nil, fmt.Errorf("load session: %w", err)
	}
	if session == nil {
		return nil, ErrSignupSessionNotFound
	}
	if !session.IsActive() {
		return nil, ErrSignupSessionExpired
	}

	// Apply draft FIRST so it persists even on subsequent failure paths.
	// Idempotent: re-sending the same draft on retry is a no-op. Use the
	// shared helper that mirrors PatchDraft (bcrypts the raw password,
	// validates DOB, recomputes completedSteps) — a bare `mergeDraft` was
	// silently dropping `password` because the merger intentionally skips
	// PasswordHash (the hashing lives in the caller).
	if draft != nil {
		if err := s.applyDraftPatch(session, draft); err != nil {
			return nil, fmt.Errorf("apply draft on verify-otp: %w", err)
		}
		if err := s.signupRepo.Update(session); err != nil {
			return nil, fmt.Errorf("merge draft into session: %w", err)
		}
	}

	// Idempotent path: session already verified → just re-issue the token.
	// Skip the OTP roundtrip (the code is single-use and may already be
	// burned; we don't want to fail a recovery retry on that).
	if session.Status == models.SignupStatusVerified {
		token, ttl, err := s.jwtMgr.GenerateSignupToken(session.ID.String(), time.Until(session.ExpiresAt))
		if err != nil {
			return nil, fmt.Errorf("re-issue signup token: %w", err)
		}
		return &VerifyOTPResult{
			SessionID:   session.ID.String(),
			Token:       token,
			ExpiresIn:   ttl,
			NextStep:    NextStepFor(session),
			DraftRecord: session,
		}, nil
	}

	// Forward to OTP service.
	if err := s.verifyOTP(session.Identifier, session.IdentifierType, code); err != nil {
		// Bump attempt count for observability; the OTP service does the actual rate limit.
		_, _ = s.signupRepo.IncrementOTPAttempts(session.ID)
		return nil, err
	}

	session.IdentifierVerified = true
	session.Status = models.SignupStatusVerified
	session.CompletedSteps = appendUnique(session.CompletedSteps, stepIdentifier, stepOTP)
	if err := s.signupRepo.Update(session); err != nil {
		return nil, fmt.Errorf("update session post-OTP: %w", err)
	}

	token, ttl, err := s.jwtMgr.GenerateSignupToken(session.ID.String(), time.Until(session.ExpiresAt))
	if err != nil {
		return nil, fmt.Errorf("issue signup token: %w", err)
	}

	return &VerifyOTPResult{
		SessionID:   session.ID.String(),
		Token:       token,
		ExpiresIn:   ttl,
		NextStep:    NextStepFor(session),
		DraftRecord: session,
	}, nil
}

// Get returns the current session state. The handler is responsible for
// authorizing — only the token bound to this session ID should reach here.
func (s *SignupService) Get(ctx context.Context, sessionID uuid.UUID) (*models.SignupSession, string, error) {
	session, err := s.signupRepo.FindByID(sessionID)
	if err != nil {
		return nil, "", err
	}
	if session == nil {
		return nil, "", ErrSignupSessionNotFound
	}
	if !session.IsActive() {
		return nil, "", ErrSignupSessionExpired
	}
	return session, NextStepFor(session), nil
}

// PatchDraft merges the given partial draft into the session and recomputes
// completedSteps. The server is authoritative on which steps are "done";
// the client can't lie by sending completed_steps directly.
func (s *SignupService) PatchDraft(
	ctx context.Context,
	sessionID uuid.UUID,
	patch *models.SignupDraft,
) (*models.SignupSession, string, error) {
	session, err := s.signupRepo.FindByID(sessionID)
	if err != nil {
		return nil, "", err
	}
	if session == nil {
		return nil, "", ErrSignupSessionNotFound
	}
	if !session.IsActive() {
		return nil, "", ErrSignupSessionExpired
	}
	if session.Status != models.SignupStatusVerified {
		return nil, "", ErrOTPNotVerified
	}

	if err := s.applyDraftPatch(session, patch); err != nil {
		return nil, "", err
	}

	if err := s.signupRepo.Update(session); err != nil {
		return nil, "", fmt.Errorf("update session draft: %w", err)
	}
	return session, NextStepFor(session), nil
}

// CompleteResult is what's returned after promoting a session to a real user.
type CompleteResult struct {
	User          *models.UserProfile           `json:"user"`
	Tokens        *models.TokenPair             `json:"tokens"`
	LinkedAccount *models.LinkedAccountPayload  `json:"linkedAccount,omitempty"`
}

// Complete promotes the session to a confirmed `users` row in one transaction.
// All required fields must be present; otherwise returns ErrMissingRequired.
// Username uniqueness is enforced atomically at this moment — never reserved earlier.
func (s *SignupService) Complete(ctx context.Context, sessionID uuid.UUID) (*CompleteResult, error) {
	session, err := s.signupRepo.FindByID(sessionID)
	if err != nil {
		return nil, fmt.Errorf("load session: %w", err)
	}
	if session == nil {
		return nil, ErrSignupSessionNotFound
	}
	if !session.IsActive() {
		return nil, ErrSignupSessionExpired
	}
	if session.Status != models.SignupStatusVerified {
		return nil, ErrOTPNotVerified
	}

	d := session.Draft
	if d.DisplayName == nil || *d.DisplayName == "" ||
		d.Username == nil || *d.Username == "" ||
		d.PasswordHash == nil || *d.PasswordHash == "" ||
		d.Role == nil || *d.Role == "" {
		return nil, ErrMissingRequired
	}

	// Atomic username check is enforced by the DB unique index; we do a
	// pre-flight to surface a clean 409 instead of a generic DB error.
	if existing, err := s.userRepo.FindByUsername(strings.ToLower(*d.Username)); err != nil {
		return nil, err
	} else if existing != nil {
		return nil, ErrUsernameTaken
	}
	if d.PhoneCountryCode != nil && d.PhoneNumber != nil && *d.PhoneCountryCode != "" && *d.PhoneNumber != "" {
		if existing, err := s.userRepo.FindByPhone(*d.PhoneCountryCode, *d.PhoneNumber); err != nil {
			return nil, err
		} else if existing != nil {
			return nil, ErrPhoneAlreadyRegistered
		}
	}

	user := &models.User{
		Username:         strings.ToLower(*d.Username),
		DisplayName:      *d.DisplayName,
		Role:             models.Role(*d.Role),
		PhoneCountryCode: d.PhoneCountryCode,
		PhoneNumber:      d.PhoneNumber,
		ProfileVerified:  true,
	}
	if d.Email != nil && *d.Email != "" {
		em := strings.ToLower(*d.Email)
		user.Email = &em
	}
	if d.Avatar != nil && *d.Avatar != "" {
		user.Avatar = d.Avatar
	}
	if d.DateOfBirth != nil && *d.DateOfBirth != "" {
		if dob, err := validation.ParseAndValidateDOB(*d.DateOfBirth); err == nil {
			user.DateOfBirth = &dob
		}
	}
	if d.InmateNumber != nil {
		user.InmateNumber = d.InmateNumber
	}
	if d.CreatorName != nil {
		user.CreatorName = d.CreatorName
	}
	if d.InmateState != nil {
		user.InmateState = d.InmateState
	}
	if d.Relationship != nil {
		user.Relationship = d.Relationship
	}
	if d.ConsentToRecording != nil {
		user.ConsentToRecording = d.ConsentToRecording
	}
	if len(d.CreatorTypes) > 0 {
		user.CreatorTypes = pq.StringArray(d.CreatorTypes)
	}
	if len(d.CreatorGenres) > 0 {
		user.CreatorGenres = pq.StringArray(d.CreatorGenres)
	}

	creds := &models.UserCredentials{PasswordHash: *d.PasswordHash}

	if err := s.userRepo.CreateUserWithCredentials(user, creds); err != nil {
		// Most likely cause: unique constraint race on username or phone.
		if strings.Contains(err.Error(), "users_username") || strings.Contains(err.Error(), "duplicate key") {
			return nil, ErrUsernameTaken
		}
		return nil, fmt.Errorf("create user from session: %w", err)
	}

	result := &CompleteResult{User: user.ToProfile()}

	// Issue full-scope tokens.
	tokens, err := s.jwtMgr.GenerateTokenPair(user)
	if err != nil {
		return nil, fmt.Errorf("generate tokens: %w", err)
	}
	result.Tokens = tokens

	// Optional managed creator account (representative path).
	if user.Role == models.RoleRepresentative && d.InmateNumber != nil {
		if linked, err := s.createManagedCreatorFromDraft(user, &d); err == nil && linked != nil {
			result.LinkedAccount = linked
		} else if err != nil {
			log.Printf("[SIGNUP] Managed creator creation failed for rep %d: %v", user.ID, err)
		}
	}

	// Publish event and clean up the session. Pass through the wizard's
	// captured locale so downstream consumers (welcome email, push
	// notifications, …) render in the user's language instead of falling
	// back to whatever default they hard-code.
	locale := ""
	if session.Draft.Locale != nil {
		locale = *session.Draft.Locale
	}
	go s.publishUserCreated(user, locale)
	if err := s.signupRepo.Delete(session.ID); err != nil {
		log.Printf("[SIGNUP] Failed to delete completed session %s: %v", session.ID, err)
	}

	return result, nil
}

// Abandon explicitly drops a session, e.g. when the user taps "exit signup".
func (s *SignupService) Abandon(ctx context.Context, sessionID uuid.UUID) error {
	session, err := s.signupRepo.FindByID(sessionID)
	if err != nil {
		return err
	}
	if session == nil {
		return ErrSignupSessionNotFound
	}
	session.Status = models.SignupStatusAbandoned
	return s.signupRepo.Update(session)
}

// CleanupExpired marks active-but-expired sessions as abandoned and purges
// abandoned ones whose updated_at is past the grace period.
func (s *SignupService) CleanupExpired(ctx context.Context, purgeGrace time.Duration) (int64, int64, error) {
	now := time.Now()
	marked, err := s.signupRepo.MarkAbandoned(now)
	if err != nil {
		return 0, 0, err
	}
	purged, err := s.signupRepo.PurgeAbandoned(now.Add(-purgeGrace))
	if err != nil {
		return marked, 0, err
	}
	return marked, purged, nil
}

// ── helpers ─────────────────────────────────────────────────────────────────

const (
	stepIdentifier   = "identifier"
	stepOTP          = "otp"
	stepName         = "name"
	stepDOB          = "dob"
	stepPassword     = "password"
	stepProfile      = "profile"
	stepRoleChoice   = "role"
	stepCreatorInfo  = "creator_info"
	stepHowItWorks   = "how_it_works"
	stepConsent      = "consent"
	stepSubscription = "subscription"
	stepBridge       = "bridge_number"
)

// NextStepFor decides which step the wizard should show next based on what's
// already on the draft. This is the single source of truth for step ordering —
// the client never computes step numbers locally.
func NextStepFor(s *models.SignupSession) string {
	d := &s.Draft
	if !s.IdentifierVerified {
		return stepOTP
	}
	if d.DisplayName == nil || *d.DisplayName == "" {
		return stepName
	}
	if d.DateOfBirth == nil || *d.DateOfBirth == "" {
		return stepDOB
	}
	if d.PasswordHash == nil || *d.PasswordHash == "" {
		return stepPassword
	}
	if d.Username == nil || *d.Username == "" {
		return stepProfile
	}
	if d.Role == nil || *d.Role == "" {
		return stepRoleChoice
	}
	if *d.Role == string(models.RoleRepresentative) {
		if d.InmateNumber == nil || *d.InmateNumber == "" {
			return stepCreatorInfo
		}
		if d.ConsentToRecording == nil || !*d.ConsentToRecording {
			return stepConsent
		}
		if d.SelectedPlan == nil || *d.SelectedPlan == "" {
			return stepSubscription
		}
		if d.BridgeNumber == nil || *d.BridgeNumber == "" {
			return stepBridge
		}
	}
	return "complete"
}

func recomputeCompletedSteps(s *models.SignupSession) pq.StringArray {
	out := pq.StringArray{}
	add := func(step string) { out = appendUnique(out, step) }
	if s.IdentifierVerified {
		add(stepIdentifier)
		add(stepOTP)
	}
	d := &s.Draft
	if d.DisplayName != nil && *d.DisplayName != "" {
		add(stepName)
	}
	if d.DateOfBirth != nil && *d.DateOfBirth != "" {
		add(stepDOB)
	}
	if d.PasswordHash != nil && *d.PasswordHash != "" {
		add(stepPassword)
	}
	if d.Username != nil && *d.Username != "" {
		add(stepProfile)
	}
	if d.Role != nil && *d.Role != "" {
		add(stepRoleChoice)
	}
	if d.InmateNumber != nil && *d.InmateNumber != "" {
		add(stepCreatorInfo)
	}
	if d.ConsentToRecording != nil && *d.ConsentToRecording {
		add(stepConsent)
	}
	if d.SelectedPlan != nil && *d.SelectedPlan != "" {
		add(stepSubscription)
	}
	if d.BridgeNumber != nil && *d.BridgeNumber != "" {
		add(stepBridge)
	}
	return out
}

func appendUnique(arr pq.StringArray, vals ...string) pq.StringArray {
	seen := make(map[string]bool, len(arr))
	for _, v := range arr {
		seen[v] = true
	}
	for _, v := range vals {
		if !seen[v] {
			arr = append(arr, v)
			seen[v] = true
		}
	}
	return arr
}

// applyDraftPatch is the full client-draft application: shallow merge of
// non-password fields via mergeDraft, bcrypt of raw passwords, DOB
// validation, and a recompute of completedSteps. Both PatchDraft and
// VerifyOTP go through this so the wire contracts stay equivalent — a
// previous version of VerifyOTP called only mergeDraft, which silently
// dropped `password` (the merger intentionally skips PasswordHash because
// hashing must happen on the server) and left signupComplete failing
// with "missing required fields" whenever the password rode in on the
// verify-otp atomic body.
func (s *SignupService) applyDraftPatch(session *models.SignupSession, patch *models.SignupDraft) error {
	mergeDraft(&session.Draft, patch)

	// Hash password server-side. We treat presence of a non-bcrypt-looking
	// PasswordHash field as a raw password the client just submitted.
	if patch.PasswordHash != nil && *patch.PasswordHash != "" && !looksLikeBcrypt(*patch.PasswordHash) {
		hash, hashErr := bcrypt.GenerateFromPassword([]byte(*patch.PasswordHash), bcrypt.DefaultCost)
		if hashErr != nil {
			return fmt.Errorf("hash password: %w", hashErr)
		}
		hashStr := string(hash)
		session.Draft.PasswordHash = &hashStr
	}
	if patch.CreatorPasswordHash != nil && *patch.CreatorPasswordHash != "" && !looksLikeBcrypt(*patch.CreatorPasswordHash) {
		hash, hashErr := bcrypt.GenerateFromPassword([]byte(*patch.CreatorPasswordHash), bcrypt.DefaultCost)
		if hashErr != nil {
			return fmt.Errorf("hash creator password: %w", hashErr)
		}
		hashStr := string(hash)
		session.Draft.CreatorPasswordHash = &hashStr
	}

	// Validate DOB format if present.
	if session.Draft.DateOfBirth != nil && *session.Draft.DateOfBirth != "" {
		if _, err := validation.ParseAndValidateDOB(*session.Draft.DateOfBirth); err != nil {
			return err
		}
	}

	session.CompletedSteps = recomputeCompletedSteps(session)
	return nil
}

// mergeDraft applies patch onto base, copying only non-nil fields. Slices
// are replaced wholesale (not appended) so the client can clear them by
// sending an empty array.
//
// PasswordHash is deliberately skipped — callers must bcrypt the raw
// password (see `applyDraftPatch` for the proper full-merge entry point).
func mergeDraft(base, patch *models.SignupDraft) {
	if patch.DisplayName != nil {
		base.DisplayName = patch.DisplayName
	}
	if patch.Username != nil {
		s := strings.ToLower(strings.TrimSpace(*patch.Username))
		base.Username = &s
	}
	if patch.DateOfBirth != nil {
		base.DateOfBirth = patch.DateOfBirth
	}
	// PasswordHash is hashed by caller, not assigned directly here.
	if patch.PhoneCountryCode != nil {
		base.PhoneCountryCode = patch.PhoneCountryCode
	}
	if patch.PhoneNumber != nil {
		base.PhoneNumber = patch.PhoneNumber
	}
	if patch.Email != nil {
		e := strings.ToLower(strings.TrimSpace(*patch.Email))
		base.Email = &e
	}
	if patch.Role != nil {
		base.Role = patch.Role
	}
	if patch.Avatar != nil {
		base.Avatar = patch.Avatar
	}
	if patch.InmateNumber != nil {
		base.InmateNumber = patch.InmateNumber
	}
	if patch.CreatorName != nil {
		base.CreatorName = patch.CreatorName
	}
	if patch.InmateState != nil {
		base.InmateState = patch.InmateState
	}
	if patch.Relationship != nil {
		base.Relationship = patch.Relationship
	}
	if patch.ConsentToRecording != nil {
		base.ConsentToRecording = patch.ConsentToRecording
	}
	if patch.SelectedPlan != nil {
		base.SelectedPlan = patch.SelectedPlan
	}
	if patch.BridgeNumber != nil {
		base.BridgeNumber = patch.BridgeNumber
	}
	if patch.CreatorEmail != nil {
		base.CreatorEmail = patch.CreatorEmail
	}
	if patch.CreatorUsername != nil {
		base.CreatorUsername = patch.CreatorUsername
	}
	if patch.CreatorDisplayName != nil {
		base.CreatorDisplayName = patch.CreatorDisplayName
	}
	if patch.CreatorPhoneCountryCode != nil {
		base.CreatorPhoneCountryCode = patch.CreatorPhoneCountryCode
	}
	if patch.CreatorPhoneNumber != nil {
		base.CreatorPhoneNumber = patch.CreatorPhoneNumber
	}
	if patch.CreatorAvatar != nil {
		base.CreatorAvatar = patch.CreatorAvatar
	}
	if patch.CreatorTypes != nil {
		base.CreatorTypes = patch.CreatorTypes
	}
	if patch.CreatorGenres != nil {
		base.CreatorGenres = patch.CreatorGenres
	}
}

// looksLikeBcrypt is a cheap shape check — bcrypt outputs start with $2a$/$2b$/$2y$
// and are 60 chars. Avoids re-hashing an already-hashed value if PatchDraft is
// called twice with the same input.
func looksLikeBcrypt(s string) bool {
	if len(s) != 60 {
		return false
	}
	return strings.HasPrefix(s, "$2a$") || strings.HasPrefix(s, "$2b$") || strings.HasPrefix(s, "$2y$")
}

func (s *SignupService) createManagedCreatorFromDraft(rep *models.User, d *models.SignupDraft) (*models.LinkedAccountPayload, error) {
	if d.CreatorUsername == nil || d.CreatorDisplayName == nil || d.CreatorPasswordHash == nil ||
		d.InmateNumber == nil || d.InmateState == nil {
		return nil, nil
	}
	fields := &models.ManagedCreatorFields{
		Username:         *d.CreatorUsername,
		DisplayName:      *d.CreatorDisplayName,
		Email:            strVal(d.CreatorEmail),
		PhoneCountryCode: d.CreatorPhoneCountryCode,
		PhoneNumber:      d.CreatorPhoneNumber,
		Avatar:           d.CreatorAvatar,
		CreatorTypes:     d.CreatorTypes,
		CreatorGenres:    d.CreatorGenres,
	}
	consent := false
	if d.ConsentToRecording != nil {
		consent = *d.ConsentToRecording
	}
	managed, err := s.userRepo.CreateManagedCreator(rep, fields, *d.CreatorPasswordHash, *d.InmateNumber, *d.InmateState, consent)
	if err != nil {
		return nil, err
	}
	tokens, err := s.jwtMgr.GenerateTokenPair(managed)
	if err != nil {
		return nil, err
	}

	// Managed creators are real accounts, but unlike the representative they
	// don't pass through the normal signup publish path — so emit user.created
	// for them here too. social-service handles this event to give the account
	// its welcome notification AND auto-follow the official ATTO SOUND account;
	// email-service safely skips the welcome email when there is no email.
	locale := "en"
	if d.Locale != nil {
		locale = *d.Locale
	}
	go s.publishUserCreated(managed, locale)

	return &models.LinkedAccountPayload{
		User:   managed.ToProfile(),
		Tokens: tokens,
	}, nil
}

func (s *SignupService) sendOTP(identifier string, idType models.IdentifierType, locale string) error {
	body := map[string]string{"locale": locale}
	switch idType {
	case models.IdentifierEmail:
		body["channel"] = "email"
		body["email"] = identifier
	case models.IdentifierPhone:
		body["channel"] = "sms"
		body["phone"] = identifier
	}
	jsonBody, _ := json.Marshal(body)
	resp, err := s.httpClient.Post(s.otpServiceURL+"/otp/send", "application/json", bytes.NewReader(jsonBody))
	if err != nil {
		return errors.New("failed to send code")
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
		return errors.New("failed to send code")
	}
	return nil
}

func (s *SignupService) verifyOTP(identifier string, idType models.IdentifierType, code string) error {
	body := map[string]string{"code": code}
	switch idType {
	case models.IdentifierEmail:
		body["channel"] = "email"
		body["email"] = identifier
	case models.IdentifierPhone:
		body["channel"] = "sms"
		body["phone"] = identifier
	}
	jsonBody, _ := json.Marshal(body)
	resp, err := s.httpClient.Post(s.otpServiceURL+"/otp/verify", "application/json", bytes.NewReader(jsonBody))
	if err != nil {
		return ErrInvalidOTP
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
		return ErrInvalidOTP
	}
	return nil
}

func (s *SignupService) publishUserCreated(user *models.User, locale string) {
	idStr := fmt.Sprintf("%d", user.ID)
	if locale == "" {
		locale = "en"
	}
	eventData := map[string]interface{}{
		"id":          idStr,
		"username":    user.Username,
		"email":       strVal(user.Email),
		"displayName": user.DisplayName,
		"role":        string(user.Role),
		"locale":      locale,
	}
	if err := s.producer.Publish(context.Background(), "user.created", idStr, eventData); err != nil {
		log.Printf("[SIGNUP] Failed to publish user.created: %v", err)
	}
}
