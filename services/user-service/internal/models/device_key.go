package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// DeviceKey is a "remembered account" on one phone (Nov 12 2026): the public
// half of an ECDSA P-256 key pair whose private half never leaves the phone
// (Secure Enclave on iOS, Android Keystore with StrongBox when there is one).
// Signing a one time challenge from this server with it is how "Continue as
// <user>" opens a new session without the password.
//
// Nothing stored here can open a session on its own: a database leak gives
// public keys only. The server revokes a key by setting RevokedAt; a phone
// that removes the account deletes its private key, which ends it for good.
//
// New table, additive only: AutoMigrate creates it and touches nothing else.
type DeviceKey struct {
	// ID is the credential id the phone sends back. Random (UUID v4).
	ID     uuid.UUID `gorm:"type:uuid;primaryKey" json:"id"`
	UserID uint64    `gorm:"index:idx_device_keys_user;not null" json:"-"`
	// PublicKey is the SubjectPublicKeyInfo (DER) of the P-256 key.
	PublicKey []byte `gorm:"type:bytea;not null" json:"-"`
	// KeyHash is the hex sha256 of PublicKey; one key is enrolled once.
	KeyHash string `gorm:"size:64;uniqueIndex;not null" json:"-"`
	// InstallationID is a random id the app keeps per install. A new key for
	// the same account and installation replaces the previous one.
	InstallationID string `gorm:"size:64;index:idx_device_keys_user;not null" json:"-"`
	Platform       string `gorm:"size:10;not null" json:"platform"` // "ios" or "android"
	DeviceName     string `gorm:"size:100;not null;default:''" json:"deviceName"`
	// Biometric: the private key only signs after Face ID, Touch ID or a
	// strong fingerprint or face check, and dies if the enrolled set changes.
	Biometric bool `gorm:"not null;default:false" json:"biometric"`
	// Hardware the phone reported: secure_enclave, strongbox, tee, software.
	Hardware string `gorm:"size:20;not null;default:''" json:"hardware"`

	// The one live challenge (sha256 hex); a new one replaces it, using it
	// clears it, so each challenge works once.
	ChallengeHash      string     `gorm:"size:64;not null;default:''" json:"-"`
	ChallengeExpiresAt *time.Time `json:"-"`
	// BadSignatures counts wrong signatures in a row; too many revokes the key.
	BadSignatures int `gorm:"not null;default:0" json:"-"`

	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	UpdatedAt  time.Time  `json:"-"`
	RevokedAt  *time.Time `gorm:"index" json:"-"`
	// RevokedReason is one of the DeviceKeyRevoked* codes.
	RevokedReason string `gorm:"size:32;not null;default:''" json:"-"`
}

// TableName keeps the table name explicit.
func (DeviceKey) TableName() string { return "device_keys" }

// BeforeCreate assigns the credential id.
func (k *DeviceKey) BeforeCreate(tx *gorm.DB) error {
	if k.ID == uuid.Nil {
		k.ID = uuid.New()
	}
	return nil
}

// Why a device key stopped working. The phone shows a sentence for each one.
const (
	DeviceKeyRevokedByUser        = "removed_by_user"    // from Settings, or the phone forgot it
	DeviceKeyRevokedPassword      = "password_changed"   // the password was reset
	DeviceKeyRevokedTwoFactor     = "two_factor_enabled" // 2FA turned on after the key was made
	DeviceKeyRevokedReplaced      = "replaced"           // a newer key for the same install
	DeviceKeyRevokedTooMany       = "too_many_devices"   // the oldest beyond the cap
	DeviceKeyRevokedBadSignatures = "too_many_bad_signatures"
	DeviceKeyRevokedAccount       = "account_deleted"
	// DeviceKeyRevokedDeactivated: the person asked to delete the account
	// (30 day grace). Recovering the account does not bring the key back.
	DeviceKeyRevokedDeactivated = "account_deactivated"
)

// DeviceKeyView is what the device list in Settings shows.
type DeviceKeyView struct {
	ID         string     `json:"id"`
	Platform   string     `json:"platform"`
	DeviceName string     `json:"deviceName"`
	Biometric  bool       `json:"biometric"`
	Hardware   string     `json:"hardware"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	// Current is true for the key of the installation that asks.
	Current bool `json:"current"`
}

// EnrollDeviceKeyRequest is POST /auth/devices.
type EnrollDeviceKeyRequest struct {
	// PublicKey: base64 (standard) of the SubjectPublicKeyInfo DER.
	PublicKey      string `json:"publicKey"`
	InstallationID string `json:"installationId"`
	Platform       string `json:"platform"`
	DeviceName     string `json:"deviceName"`
	Biometric      bool   `json:"biometric"`
	Hardware       string `json:"hardware"`
}

// EnrollDeviceKeyResponse carries the credential id the phone keeps.
type EnrollDeviceKeyResponse struct {
	CredentialID string    `json:"credentialId"`
	ExpiresAt    time.Time `json:"expiresAt"`
}

// DeviceChallengeRequest is POST /auth/login/device/challenge.
type DeviceChallengeRequest struct {
	CredentialID string `json:"credentialId"`
}

// DeviceChallengeResponse is the challenge the phone signs.
type DeviceChallengeResponse struct {
	Challenge string    `json:"challenge"` // base64url, no padding
	ExpiresAt time.Time `json:"expiresAt"`
}

// DeviceLoginRequest is POST /auth/login/device.
type DeviceLoginRequest struct {
	CredentialID string `json:"credentialId"`
	Challenge    string `json:"challenge"`
	// Signature: base64 (standard) of the DER ECDSA signature.
	Signature string `json:"signature"`
}
