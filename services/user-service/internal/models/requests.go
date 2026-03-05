package models

// RepresentativeFields holds info about the artist a representative manages.
type RepresentativeFields struct {
	ArtistName         string `json:"artistName"`
	InmateState        string `json:"inmateState"`
	Relationship       string `json:"relationship"`
	ConsentToRecording bool   `json:"consentToRecording"`
}

// RegisterRequest is the DTO for user registration.
type RegisterRequest struct {
	Username             string                `json:"username" validate:"required,min=3,max=50"`
	Email                string                `json:"email" validate:"required,email"`
	Password             string                `json:"password" validate:"required,min=8"`
	DisplayName          string                `json:"displayName" validate:"required,min=1,max=100"`
	Role                 string                `json:"role" validate:"required,oneof=artist representative listener"`
	PhoneCountryCode     *string               `json:"phoneCountryCode,omitempty"`
	PhoneNumber          *string               `json:"phoneNumber,omitempty"`
	InmateNumber         *string               `json:"inmateNumber,omitempty"`
	RepresentativeFields *RepresentativeFields `json:"representativeFields,omitempty"`
}

// PreRegisterRequest is the DTO for early user creation (after OTP verification).
type PreRegisterRequest struct {
	Email       string  `json:"email" validate:"required,email"`
	Password    string  `json:"password" validate:"required,min=8"`
	DisplayName string  `json:"displayName" validate:"required,min=1,max=100"`
	Username         string  `json:"username" validate:"required,min=3,max=50"`
	PhoneCountryCode *string `json:"phoneCountryCode,omitempty"`
	PhoneNumber      *string `json:"phoneNumber,omitempty"`
}

// CompleteRegistrationRequest finalizes registration with role and optional representative fields.
type CompleteRegistrationRequest struct {
	Role                 string                `json:"role" validate:"required,oneof=artist representative listener"`
	InmateNumber         *string               `json:"inmateNumber,omitempty"`
	RepresentativeFields *RepresentativeFields `json:"representativeFields,omitempty"`
}

// UpdateProfileRequest is the DTO for updating user profile fields.
type UpdateProfileRequest struct {
	DisplayName *string `json:"displayName,omitempty"`
	Avatar      *string `json:"avatar,omitempty"`
	Bio         *string `json:"bio,omitempty"`
	Username    *string `json:"username,omitempty"`
	// Representative fields (editable from Edit Artist Contact screen)
	ArtistName   *string `json:"artistName,omitempty"`
	InmateNumber *string `json:"inmateNumber,omitempty"`
	InmateState  *string `json:"inmateState,omitempty"`
	Relationship *string `json:"relationship,omitempty"`
	ArtistEmail  *string `json:"artistEmail,omitempty"`
	ArtistPhone  *string `json:"artistPhone,omitempty"`
}

// LoginRequest is the DTO for user login.
// Identifier can be an email, username, or phone number (without country code).
type LoginRequest struct {
	Identifier string `json:"identifier" validate:"required"`
	Password   string `json:"password" validate:"required"`
}

// LoginOTPRequest is the DTO for OTP-based login (passwordless).
// Identifier can be an email or a phone number (E.164 format).
type LoginOTPRequest struct {
	Identifier string `json:"identifier" validate:"required"`
	OTP        string `json:"otp" validate:"required"`
}

// RefreshRequest is the DTO for token refresh.
type RefreshRequest struct {
	RefreshToken string `json:"refreshToken" validate:"required"`
}

// TokenPair holds both access and refresh tokens.
type TokenPair struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresIn    int64  `json:"expiresIn"`
}

// APIResponse is the standard JSON response envelope.
type APIResponse struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
}

// AuthResponse combines user profile with tokens.
type AuthResponse struct {
	User   *UserProfile `json:"user"`
	Tokens *TokenPair   `json:"tokens"`
}

// UserProfile is the public-facing user data returned in API responses.
type UserProfile struct {
	ID                 uint64  `json:"id"`
	Username           string  `json:"username"`
	Email              string  `json:"email"`
	PhoneCountryCode   *string `json:"phoneCountryCode,omitempty"`
	PhoneNumber        *string `json:"phoneNumber,omitempty"`
	DisplayName        string  `json:"displayName"`
	Avatar             *string `json:"avatar,omitempty"`
	Bio                *string `json:"bio,omitempty"`
	Role               string  `json:"role"`
	InmateNumber       *string `json:"inmateNumber,omitempty"`
	ArtistName         *string `json:"artistName,omitempty"`
	InmateState        *string `json:"inmateState,omitempty"`
	Relationship       *string `json:"relationship,omitempty"`
	ConsentToRecording *bool   `json:"consentToRecording,omitempty"`
	ArtistEmail        *string `json:"artistEmail,omitempty"`
	ArtistPhone        *string `json:"artistPhone,omitempty"`
	ProfileVerified    bool    `json:"profileVerified"`
	TwoFactorEnabled   bool   `json:"twoFactorEnabled"`
	TwoFactorMethod    string `json:"twoFactorMethod"`
	RegistrationStatus string  `json:"registrationStatus"`
	RepresentativeID   *uint64 `json:"representativeId,omitempty"`
	FollowersCount     int64   `json:"followersCount"`
	FollowingCount     int64   `json:"followingCount"`
	PostsCount         int64   `json:"postsCount"`
	CreatedAt          string  `json:"createdAt"`
}

// ForgotPasswordRequest initiates the password reset flow.
type ForgotPasswordRequest struct {
	Email string `json:"email" validate:"required,email"`
}

// ResetPasswordRequest sets a new password after OTP verification.
type ResetPasswordRequest struct {
	Email    string `json:"email" validate:"required,email"`
	OTP      string `json:"otp" validate:"required,len=6"`
	Password string `json:"password" validate:"required,min=8"`
}

// InmateLookupResponse holds parsed inmate data from a state DOC website.
type InmateLookupResponse struct {
	InmateNumber    string `json:"inmateNumber"`
	InmateName      string `json:"inmateName"`
	DateOfBirth     string `json:"dateOfBirth"`
	AdmissionDate   string `json:"admissionDate"`
	CurrentLocation string `json:"currentLocation"`
	Status          string `json:"status"`
	Offense         string `json:"offense"`
	SentenceDate    string `json:"sentenceDate"`
	MaxSentence     string `json:"maxSentence"`
	MaxReleaseDate  string `json:"maxReleaseDate"`
	EstReleaseDate  string `json:"estReleaseDate"`
}

// ToProfile converts a User model to a UserProfile DTO.
func (u *User) ToProfile() *UserProfile {
	p := &UserProfile{
		ID:                 u.ID,
		Username:           u.Username,
		Email:              u.Email,
		PhoneCountryCode:   u.PhoneCountryCode,
		PhoneNumber:        u.PhoneNumber,
		DisplayName:        u.DisplayName,
		Avatar:             u.Avatar,
		Bio:                u.Bio,
		Role:               string(u.Role),
		InmateNumber:       u.InmateNumber,
		ArtistName:         u.ArtistName,
		InmateState:        u.InmateState,
		Relationship:       u.Relationship,
		ConsentToRecording: u.ConsentToRecording,
		ArtistEmail:        u.ArtistEmail,
		ArtistPhone:        u.ArtistPhone,
		ProfileVerified:    u.ProfileVerified,
		RegistrationStatus: u.RegistrationStatus,
		FollowersCount:     u.FollowersCount,
		FollowingCount:     u.FollowingCount,
		PostsCount:         u.PostsCount,
		CreatedAt:          u.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
	}
	if u.RepresentativeID != nil {
		p.RepresentativeID = u.RepresentativeID
	}
	return p
}

// ToProfileWith2FA converts a User model to a UserProfile DTO including 2FA status.
func (u *User) ToProfileWith2FA(creds *UserCredentials) *UserProfile {
	p := u.ToProfile()
	if creds != nil {
		p.TwoFactorEnabled = creds.TwoFactorEnabled
		p.TwoFactorMethod = creds.TwoFactorMethod
	}
	return p
}

// Enable2FARequest initiates 2FA setup — sends a verification OTP.
type Enable2FARequest struct {
	Method string `json:"method"` // "sms" or "email"
}

// Verify2FASetupRequest confirms the OTP to finalize 2FA enablement.
type Verify2FASetupRequest struct {
	Code   string `json:"code"`
	Method string `json:"method"` // "sms" or "email"
}

// Disable2FARequest disables 2FA (requires password confirmation).
type Disable2FARequest struct {
	Password string `json:"password"`
}

// Login2FARequest completes login when 2FA is required.
type Login2FARequest struct {
	TempToken string `json:"tempToken"`
	Code      string `json:"code"`
}

// Login2FAResponse is returned when login requires a second factor.
type Login2FAResponse struct {
	Requires2FA  bool   `json:"requires2FA"`
	Method       string `json:"method"`
	TempToken    string `json:"tempToken"`
	MaskedTarget string `json:"maskedTarget"`
}
