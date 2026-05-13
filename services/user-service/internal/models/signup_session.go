package models

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"
)

// SignupStatus tracks where a signup is in its lifecycle.
type SignupStatus string

const (
	SignupStatusStarted   SignupStatus = "started"   // session created, OTP sent, not yet verified
	SignupStatusVerified  SignupStatus = "verified"  // OTP verified, user filling profile
	SignupStatusCompleted SignupStatus = "completed" // promoted to users table
	SignupStatusAbandoned SignupStatus = "abandoned" // expired without completing
)

// IdentifierType is either email or phone.
type IdentifierType string

const (
	IdentifierEmail IdentifierType = "email"
	IdentifierPhone IdentifierType = "phone"
)

// SignupDraft holds the partially-filled wizard data. JSONB in Postgres.
// Pointers everywhere because every field is optional until the user fills it.
// Schema evolves without DB migrations.
type SignupDraft struct {
	DisplayName        *string `json:"displayName,omitempty"`
	Username           *string `json:"username,omitempty"`
	DateOfBirth        *string `json:"dateOfBirth,omitempty"` // YYYY-MM-DD
	PasswordHash       *string `json:"passwordHash,omitempty"`
	PhoneCountryCode   *string `json:"phoneCountryCode,omitempty"`
	PhoneNumber        *string `json:"phoneNumber,omitempty"`
	Email              *string `json:"email,omitempty"`
	Role               *string `json:"role,omitempty"` // listener | creator | representative
	Avatar             *string `json:"avatar,omitempty"`
	InmateNumber       *string `json:"inmateNumber,omitempty"`
	CreatorName        *string `json:"creatorName,omitempty"`
	InmateState        *string `json:"inmateState,omitempty"`
	Relationship       *string `json:"relationship,omitempty"`
	ConsentToRecording *bool   `json:"consentToRecording,omitempty"`
	SelectedPlan       *string `json:"selectedPlan,omitempty"`
	BridgeNumber       *string `json:"bridgeNumber,omitempty"`

	// Managed creator fields (representative path only)
	CreatorEmail            *string  `json:"creatorEmail,omitempty"`
	CreatorPasswordHash     *string  `json:"creatorPasswordHash,omitempty"`
	CreatorUsername         *string  `json:"creatorUsername,omitempty"`
	CreatorDisplayName      *string  `json:"creatorDisplayName,omitempty"`
	CreatorPhoneCountryCode *string  `json:"creatorPhoneCountryCode,omitempty"`
	CreatorPhoneNumber      *string  `json:"creatorPhoneNumber,omitempty"`
	CreatorAvatar           *string  `json:"creatorAvatar,omitempty"`
	CreatorTypes            []string `json:"creatorTypes,omitempty"`
	CreatorGenres           []string `json:"creatorGenres,omitempty"`
}

// Value implements driver.Valuer so GORM can store the draft as JSONB.
func (d SignupDraft) Value() (driver.Value, error) {
	return json.Marshal(d)
}

// Scan implements sql.Scanner so GORM can load the draft from JSONB.
func (d *SignupDraft) Scan(value interface{}) error {
	if value == nil {
		*d = SignupDraft{}
		return nil
	}
	bytes, ok := value.([]byte)
	if !ok {
		return errors.New("SignupDraft.Scan: expected []byte")
	}
	return json.Unmarshal(bytes, d)
}

// SignupSession is the canonical record for an in-progress registration.
// It lives separately from `users` so that abandoned attempts don't pollute
// the production user table, and so security-sensitive flows (login,
// profile actions, posts) never have to special-case "pending" users.
type SignupSession struct {
	ID                 uuid.UUID      `gorm:"type:uuid;primaryKey;default:gen_random_uuid()" json:"id"`
	Identifier         string         `gorm:"size:255;not null;index" json:"identifier"`
	IdentifierType     IdentifierType `gorm:"type:varchar(10);not null" json:"identifierType"`
	IdentifierVerified bool           `gorm:"default:false" json:"identifierVerified"`
	Draft              SignupDraft    `gorm:"type:jsonb;not null;default:'{}'::jsonb" json:"draft"`
	CompletedSteps     pq.StringArray `gorm:"type:text[];not null;default:'{}'::text[]" json:"completedSteps"`
	Status             SignupStatus   `gorm:"type:varchar(20);not null;default:'started'" json:"status"`
	IPFirstSeen        *string        `gorm:"type:inet;column:ip_first_seen" json:"ipFirstSeen,omitempty"`
	DeviceID           *string        `gorm:"size:100;column:device_id" json:"deviceId,omitempty"`
	OTPAttempts        int            `gorm:"default:0;column:otp_attempts" json:"otpAttempts"`
	CreatedAt          time.Time      `json:"createdAt"`
	UpdatedAt          time.Time      `json:"updatedAt"`
	ExpiresAt          time.Time      `gorm:"not null;index" json:"expiresAt"`
}

// IsActive returns true if the session can still be used.
func (s *SignupSession) IsActive() bool {
	if s.Status != SignupStatusStarted && s.Status != SignupStatusVerified {
		return false
	}
	return time.Now().Before(s.ExpiresAt)
}
