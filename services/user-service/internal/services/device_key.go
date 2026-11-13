package services

// Remembered accounts with a device key (Nov 12 2026).
//
// David asked for Instagram's "log out but stay remembered, come back with
// one tap", plus Face ID. The phone keeps an ECDSA P-256 key pair per
// account: the private half lives in the Secure Enclave (iOS) or the Android
// Keystore and cannot be read out, not even by the app. To come back, the
// phone asks for a one time challenge, signs it (behind Face ID or the
// fingerprint when the person turned that on) and gets a new session.
//
// Why a key pair and not a long lived refresh token kept on the phone:
//   - nothing secret is stored on the server (only public keys) or travels
//     over the wire, and the phone's copy cannot be copied off the phone;
//   - nothing rotates, so a response lost to a dead network cannot burn the
//     credential (FUTTEM lost sessions that way on Oct 5 2026);
//   - the key does not depend on the session being alive: a session that
//     died (7 days idle, a refused refresh) still comes back with one tap.
//
// This file is the pure part: formats, limits and checks, no database.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/atto-sound/user-service/internal/models"
)

const (
	// DeviceKeyIdleLifetime: a key unused this long stops working (sliding,
	// counted from the last use, or from the enrollment if never used).
	DeviceKeyIdleLifetime = 180 * 24 * time.Hour
	// DeviceChallengeTTL: how long a challenge waits for its signature. It
	// covers the Face ID prompt and a slow network, not much more.
	DeviceChallengeTTL = 2 * time.Minute
	// MaxLiveDeviceKeys per account; enrolling one more revokes the oldest.
	MaxLiveDeviceKeys = 10
	// MaxBadSignatures in a row revoke the key (someone is trying).
	MaxBadSignatures = 5
	// DeviceLoginMessagePrefix versions what the phone signs.
	DeviceLoginMessagePrefix = "atto.device-login.v1"
)

// DeviceKeyError is a refusal the phone acts on: Code says what happened,
// Reason (for revoked keys) says why, Status is the HTTP status to answer.
type DeviceKeyError struct {
	Status int
	Code   string
	Reason string
}

func (e *DeviceKeyError) Error() string {
	if e.Reason != "" {
		return e.Code + ": " + e.Reason
	}
	return e.Code
}

// Error codes the app reads.
const (
	DeviceErrNotFound         = "device_key_not_found"
	DeviceErrRevoked          = "device_key_revoked"
	DeviceErrExpired          = "device_key_expired"
	DeviceErrChallengeInvalid = "device_challenge_invalid"
	DeviceErrSignatureInvalid = "device_signature_invalid"
	DeviceErrInvalidKey       = "device_public_key_invalid"
	DeviceErrInvalidRequest   = "device_request_invalid"
	DeviceErrKeyInUse         = "device_public_key_in_use"
	DeviceErrSessionClosed    = "device_session_closed"
)

func deviceErr(status int, code, reason string) *DeviceKeyError {
	return &DeviceKeyError{Status: status, Code: code, Reason: reason}
}

// AsDeviceKeyError unwraps a DeviceKeyError.
func AsDeviceKeyError(err error) (*DeviceKeyError, bool) {
	var de *DeviceKeyError
	if errors.As(err, &de) {
		return de, true
	}
	return nil, false
}

// ParseDevicePublicKey accepts the base64 (standard or URL, padded or not)
// SubjectPublicKeyInfo of a P-256 key and returns the key and its DER.
func ParseDevicePublicKey(b64 string) (*ecdsa.PublicKey, []byte, error) {
	der, err := decodeBase64Any(strings.TrimSpace(b64))
	if err != nil || len(der) == 0 || len(der) > 512 {
		return nil, nil, deviceErr(400, DeviceErrInvalidKey, "")
	}
	pub, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, nil, deviceErr(400, DeviceErrInvalidKey, "")
	}
	ec, ok := pub.(*ecdsa.PublicKey)
	if !ok || ec.Curve != elliptic.P256() {
		return nil, nil, deviceErr(400, DeviceErrInvalidKey, "")
	}
	return ec, der, nil
}

// DeviceKeyHash is the hex sha256 of the key's DER.
func DeviceKeyHash(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}

// DeviceLoginMessage is exactly what the phone signs. The credential id is
// in it so a signature for one key never verifies for another.
func DeviceLoginMessage(credentialID, challenge string) []byte {
	return []byte(DeviceLoginMessagePrefix + "|" + credentialID + "|" + challenge)
}

// VerifyDeviceSignature checks a DER ECDSA signature (SHA-256) over
// DeviceLoginMessage with the stored key.
func VerifyDeviceSignature(keyDER []byte, credentialID, challenge, signatureB64 string) error {
	pubAny, err := x509.ParsePKIXPublicKey(keyDER)
	if err != nil {
		return fmt.Errorf("stored key unreadable: %w", err)
	}
	pub, ok := pubAny.(*ecdsa.PublicKey)
	if !ok {
		return errors.New("stored key is not ECDSA")
	}
	sig, err := decodeBase64Any(strings.TrimSpace(signatureB64))
	if err != nil || len(sig) == 0 || len(sig) > 128 {
		return errors.New("signature not base64")
	}
	digest := sha256.Sum256(DeviceLoginMessage(credentialID, challenge))
	if !ecdsa.VerifyASN1(pub, digest[:], sig) {
		return errors.New("signature does not verify")
	}
	return nil
}

// NewDeviceChallenge returns a random challenge (base64url, 32 bytes) and
// the hash the server keeps.
func NewDeviceChallenge() (string, string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	c := base64.RawURLEncoding.EncodeToString(buf)
	return c, HashDeviceChallenge(c), nil
}

// HashDeviceChallenge is the hex sha256 of a challenge.
func HashDeviceChallenge(challenge string) string {
	sum := sha256.Sum256([]byte(challenge))
	return hex.EncodeToString(sum[:])
}

// DeviceKeyExpiresAt is when an unused key stops working.
func DeviceKeyExpiresAt(k *models.DeviceKey) time.Time {
	from := k.CreatedAt
	if k.LastUsedAt != nil && k.LastUsedAt.After(from) {
		from = *k.LastUsedAt
	}
	return from.Add(DeviceKeyIdleLifetime)
}

// CheckDeviceKeyUsable says whether a key can still open a session.
func CheckDeviceKeyUsable(k *models.DeviceKey, now time.Time) error {
	if k == nil {
		return deviceErr(404, DeviceErrNotFound, "")
	}
	if k.RevokedAt != nil {
		reason := k.RevokedReason
		if reason == "" {
			reason = models.DeviceKeyRevokedByUser
		}
		return deviceErr(410, DeviceErrRevoked, reason)
	}
	if !now.Before(DeviceKeyExpiresAt(k)) {
		return deviceErr(410, DeviceErrExpired, "expired")
	}
	return nil
}

// Allowed values from the phone.
var (
	devicePlatforms = map[string]bool{"ios": true, "android": true}
	deviceHardware  = map[string]bool{"": true, "secure_enclave": true, "strongbox": true, "tee": true, "software": true}
)

// ValidateEnrollRequest checks and normalises an enrollment.
func ValidateEnrollRequest(req *models.EnrollDeviceKeyRequest) error {
	req.Platform = strings.ToLower(strings.TrimSpace(req.Platform))
	req.InstallationID = strings.TrimSpace(req.InstallationID)
	req.Hardware = strings.ToLower(strings.TrimSpace(req.Hardware))
	req.DeviceName = strings.TrimSpace(req.DeviceName)
	if r := []rune(req.DeviceName); len(r) > 100 {
		req.DeviceName = string(r[:100])
	}
	if !devicePlatforms[req.Platform] {
		return deviceErr(400, DeviceErrInvalidRequest, "platform")
	}
	if n := len(req.InstallationID); n < 8 || n > 64 {
		return deviceErr(400, DeviceErrInvalidRequest, "installationId")
	}
	if !deviceHardware[req.Hardware] {
		req.Hardware = ""
	}
	return nil
}

// KeysBeyondCap returns the live keys to revoke so that at most max stay,
// dropping the least recently used first. live is not modified.
func KeysBeyondCap(live []models.DeviceKey, max int) []models.DeviceKey {
	if len(live) <= max {
		return nil
	}
	sorted := make([]models.DeviceKey, len(live))
	copy(sorted, live)
	lastSeen := func(k models.DeviceKey) time.Time {
		if k.LastUsedAt != nil && k.LastUsedAt.After(k.CreatedAt) {
			return *k.LastUsedAt
		}
		return k.CreatedAt
	}
	// Small n: insertion sort, newest first.
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && lastSeen(sorted[j]).After(lastSeen(sorted[j-1])); j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	return sorted[max:]
}

func decodeBase64Any(s string) ([]byte, error) {
	s = strings.TrimRight(s, "=")
	if strings.ContainsAny(s, "-_") {
		return base64.RawURLEncoding.DecodeString(s)
	}
	return base64.RawStdEncoding.DecodeString(s)
}

// closedSince: a session issued at issuedAt (whole seconds) was closed by a
// later "close every session" (same rule as RefreshToken).
func closedSince(issuedAt time.Time, validAfter *time.Time) bool {
	if validAfter == nil {
		return false
	}
	if issuedAt.IsZero() {
		return true
	}
	return !issuedAt.After(validAfter.Truncate(time.Second))
}
