package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Role represents the type of user on the platform.
type Role string

const (
	RoleArtist         Role = "artist"
	RoleRepresentative Role = "representative"
	RoleListener       Role = "listener"
)

// User is the primary user model stored in PostgreSQL.
type User struct {
	ID                 uint64         `gorm:"primaryKey;autoIncrement" json:"id"`
	Username           string         `gorm:"uniqueIndex;size:50;not null" json:"username"`
	Email              string         `gorm:"uniqueIndex;size:255;not null" json:"email"`
	PhoneCountryCode   *string        `gorm:"size:5;uniqueIndex:idx_phone_unique" json:"phoneCountryCode,omitempty"`
	PhoneNumber        *string        `gorm:"size:15;uniqueIndex:idx_phone_unique" json:"phoneNumber,omitempty"`
	DisplayName        string         `gorm:"size:100;not null" json:"displayName"`
	Avatar             *string        `gorm:"size:500" json:"avatar,omitempty"`
	Bio                *string        `gorm:"size:1000" json:"bio,omitempty"`
	Role               Role           `gorm:"type:varchar(20);not null;default:'listener'" json:"role"`
	InmateNumber       *string        `gorm:"size:50" json:"inmateNumber,omitempty"`
	ArtistName         *string        `gorm:"size:100" json:"artistName,omitempty"`
	InmateState        *string        `gorm:"size:50" json:"inmateState,omitempty"`
	Relationship       *string        `gorm:"size:50" json:"relationship,omitempty"`
	ConsentToRecording *bool          `gorm:"default:false" json:"consentToRecording,omitempty"`
	ArtistEmail        *string        `gorm:"size:255" json:"artistEmail,omitempty"`
	ArtistPhone        *string        `gorm:"size:20" json:"artistPhone,omitempty"`
	ProfileVerified    bool           `gorm:"default:false" json:"profileVerified"`
	RegistrationStatus string         `gorm:"type:varchar(20);not null;default:'completed'" json:"registrationStatus"`
	RepresentativeID   *uint64        `json:"representativeId,omitempty"`
	FollowersCount     int64          `gorm:"default:0" json:"followersCount"`
	FollowingCount     int64          `gorm:"default:0" json:"followingCount"`
	PostsCount         int64          `gorm:"default:0" json:"postsCount"`
	CreatedAt          time.Time      `json:"createdAt"`
	UpdatedAt          time.Time      `json:"updatedAt"`
	DeletedAt          gorm.DeletedAt `gorm:"index" json:"-"`

	Credentials *UserCredentials `gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE" json:"-"`
}

// UserCredentials stores authentication data separate from the user profile.
type UserCredentials struct {
	ID               uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()" json:"id"`
	UserID           uint64    `gorm:"uniqueIndex;not null" json:"userId"`
	PasswordHash     string    `gorm:"size:255;not null" json:"-"`
	TOTPSecret       *string   `gorm:"size:255" json:"-"`
	TwoFactorEnabled bool      `gorm:"default:false" json:"twoFactorEnabled"`
	TwoFactorMethod  string    `gorm:"size:10;default:''" json:"twoFactorMethod"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

// BeforeCreate sets the UUID before inserting new UserCredentials.
func (uc *UserCredentials) BeforeCreate(tx *gorm.DB) error {
	if uc.ID == uuid.Nil {
		uc.ID = uuid.New()
	}
	return nil
}
