package services

import (
	"context"
	"log"
	"time"

	"github.com/google/uuid"

	"github.com/atto-sound/user-service/internal/models"
)

// DeviceKeyStore is the persistence the device key flows need. The Postgres
// one is repositories.DeviceKeyRepository; tests use an in memory one.
type DeviceKeyStore interface {
	Create(k *models.DeviceKey) error
	// FindByID returns nil, nil when there is no such key.
	FindByID(id uuid.UUID) (*models.DeviceKey, error)
	// FindByKeyHash returns nil, nil when that public key was never enrolled.
	FindByKeyHash(hash string) (*models.DeviceKey, error)
	// ListLive returns the keys of a user that are not revoked.
	ListLive(userID uint64) ([]models.DeviceKey, error)
	SetChallenge(id uuid.UUID, hash string, expiresAt time.Time) error
	// ConsumeChallenge clears the live challenge when it matches hash and has
	// not expired, atomically. True when it did (the challenge is now spent).
	ConsumeChallenge(id uuid.UUID, hash string, now time.Time) (bool, error)
	// MarkUsed stamps the use and resets the bad signature count.
	MarkUsed(id uuid.UUID, at time.Time) error
	// AddBadSignature returns the count after adding one.
	AddBadSignature(id uuid.UUID) (int, error)
	Revoke(id uuid.UUID, reason string, at time.Time) error
	RevokeAllForUser(userID uint64, reason string, at time.Time) (int64, error)
}

// deviceKeyUsers is the slice of the user repository the flows read.
type deviceKeyUsers interface {
	FindByID(id uint64) (*models.User, error)
}

// SessionIssuer opens a session for an account that just proved who it is.
// It is AuthService.IssueSession in production.
type SessionIssuer func(user *models.User) (*models.AuthResponse, error)

// DeviceKeyService runs enrollment, challenge, login and revocation.
type DeviceKeyService struct {
	store DeviceKeyStore
	users deviceKeyUsers
	issue SessionIssuer
	now   func() time.Time
}

// NewDeviceKeyService wires the flows.
func NewDeviceKeyService(store DeviceKeyStore, users deviceKeyUsers, issue SessionIssuer) *DeviceKeyService {
	return &DeviceKeyService{store: store, users: users, issue: issue, now: time.Now}
}

func parseCredentialID(raw string) (uuid.UUID, error) {
	id, err := uuid.Parse(raw)
	if err != nil || id == uuid.Nil {
		return uuid.Nil, deviceErr(404, DeviceErrNotFound, "")
	}
	return id, nil
}

// Enroll stores a new public key for the signed in account. A new key for
// the same installation replaces the previous one, and the oldest keys
// beyond MaxLiveDeviceKeys are revoked.
//
// issuedAt is the iat of the session asking. A key turns a 15 minute access
// token into 180 days of "Continue", so a session closed since (password
// reset, deletion request) must not enroll one, even while its access token
// has minutes left; neither does an account in its deletion grace.
func (s *DeviceKeyService) Enroll(ctx context.Context, userID uint64, issuedAt time.Time, req *models.EnrollDeviceKeyRequest) (*models.EnrollDeviceKeyResponse, error) {
	if err := ValidateEnrollRequest(req); err != nil {
		return nil, err
	}
	owner, err := s.users.FindByID(userID)
	if err != nil {
		return nil, err
	}
	if owner == nil || owner.IsDeactivated() || closedSince(issuedAt, owner.SessionsValidAfter) {
		return nil, deviceErr(401, DeviceErrSessionClosed, "")
	}
	_, der, err := ParseDevicePublicKey(req.PublicKey)
	if err != nil {
		return nil, err
	}
	hash := DeviceKeyHash(der)
	now := s.now()

	existing, err := s.store.FindByKeyHash(hash)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		// The same key sent twice (a retry after a lost response) is fine
		// for its own account while it is alive; anything else is refused.
		if existing.UserID == userID && CheckDeviceKeyUsable(existing, now) == nil {
			return &models.EnrollDeviceKeyResponse{
				CredentialID: existing.ID.String(),
				ExpiresAt:    DeviceKeyExpiresAt(existing),
			}, nil
		}
		return nil, deviceErr(409, DeviceErrKeyInUse, "")
	}

	live, err := s.store.ListLive(userID)
	if err != nil {
		return nil, err
	}
	kept := live[:0:0]
	for _, k := range live {
		if k.InstallationID == req.InstallationID {
			if err := s.store.Revoke(k.ID, models.DeviceKeyRevokedReplaced, now); err != nil {
				return nil, err
			}
			continue
		}
		kept = append(kept, k)
	}

	key := &models.DeviceKey{
		ID:             uuid.New(),
		UserID:         userID,
		PublicKey:      der,
		KeyHash:        hash,
		InstallationID: req.InstallationID,
		Platform:       req.Platform,
		DeviceName:     req.DeviceName,
		Biometric:      req.Biometric,
		Hardware:       req.Hardware,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := s.store.Create(key); err != nil {
		return nil, err
	}
	for _, old := range KeysBeyondCap(append(kept, *key), MaxLiveDeviceKeys) {
		if err := s.store.Revoke(old.ID, models.DeviceKeyRevokedTooMany, now); err != nil {
			log.Printf("[DEVICE-KEY] could not revoke %s beyond the cap: %v", old.ID, err)
		}
	}
	return &models.EnrollDeviceKeyResponse{CredentialID: key.ID.String(), ExpiresAt: DeviceKeyExpiresAt(key)}, nil
}

// Challenge hands out the one live challenge of a key.
func (s *DeviceKeyService) Challenge(ctx context.Context, credentialID string) (*models.DeviceChallengeResponse, error) {
	id, err := parseCredentialID(credentialID)
	if err != nil {
		return nil, err
	}
	key, err := s.store.FindByID(id)
	if err != nil {
		return nil, err
	}
	now := s.now()
	if err := CheckDeviceKeyUsable(key, now); err != nil {
		return nil, err
	}
	challenge, hash, err := NewDeviceChallenge()
	if err != nil {
		return nil, err
	}
	exp := now.Add(DeviceChallengeTTL)
	if err := s.store.SetChallenge(id, hash, exp); err != nil {
		return nil, err
	}
	return &models.DeviceChallengeResponse{Challenge: challenge, ExpiresAt: exp}, nil
}

// Login checks the signature over the challenge and opens a session. Each
// challenge is spent before the signature is checked, so every challenge is
// worth exactly one attempt. No 2FA code is asked: see the note on
// DeviceKeySkipsSecondFactor.
func (s *DeviceKeyService) Login(ctx context.Context, req *models.DeviceLoginRequest) (*models.AuthResponse, error) {
	id, err := parseCredentialID(req.CredentialID)
	if err != nil {
		return nil, err
	}
	if req.Challenge == "" || req.Signature == "" {
		return nil, deviceErr(400, DeviceErrInvalidRequest, "")
	}
	key, err := s.store.FindByID(id)
	if err != nil {
		return nil, err
	}
	now := s.now()
	if err := CheckDeviceKeyUsable(key, now); err != nil {
		return nil, err
	}
	ok, err := s.store.ConsumeChallenge(id, HashDeviceChallenge(req.Challenge), now)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, deviceErr(401, DeviceErrChallengeInvalid, "")
	}
	if verr := VerifyDeviceSignature(key.PublicKey, key.ID.String(), req.Challenge, req.Signature); verr != nil {
		n, cerr := s.store.AddBadSignature(id)
		if cerr == nil && n >= MaxBadSignatures {
			_ = s.store.Revoke(id, models.DeviceKeyRevokedBadSignatures, now)
			log.Printf("[DEVICE-KEY] %s revoked after %d bad signatures (user %d)", id, n, key.UserID)
		}
		return nil, deviceErr(401, DeviceErrSignatureInvalid, "")
	}

	user, err := s.users.FindByID(key.UserID)
	if err != nil {
		return nil, err
	}
	if user == nil {
		_ = s.store.Revoke(id, models.DeviceKeyRevokedAccount, now)
		return nil, deviceErr(410, DeviceErrRevoked, models.DeviceKeyRevokedAccount)
	}
	res, err := s.issue(user)
	if err != nil {
		return nil, err
	}
	if err := s.store.MarkUsed(id, now); err != nil {
		log.Printf("[DEVICE-KEY] could not stamp the use of %s: %v", id, err)
	}
	return res, nil
}

// List returns the live keys of the account, the asking installation's
// one marked as current.
func (s *DeviceKeyService) List(ctx context.Context, userID uint64, installationID string) ([]models.DeviceKeyView, error) {
	live, err := s.store.ListLive(userID)
	if err != nil {
		return nil, err
	}
	now := s.now()
	out := make([]models.DeviceKeyView, 0, len(live))
	for _, k := range KeysBeyondCap(live, 0) { // newest first
		if CheckDeviceKeyUsable(&k, now) != nil {
			continue
		}
		out = append(out, models.DeviceKeyView{
			ID:         k.ID.String(),
			Platform:   k.Platform,
			DeviceName: k.DeviceName,
			Biometric:  k.Biometric,
			Hardware:   k.Hardware,
			CreatedAt:  k.CreatedAt,
			LastUsedAt: k.LastUsedAt,
			ExpiresAt:  DeviceKeyExpiresAt(&k),
			Current:    installationID != "" && k.InstallationID == installationID,
		})
	}
	return out, nil
}

// Revoke ends one key of the account. Revoking twice is fine; another
// account's key is "not found".
func (s *DeviceKeyService) Revoke(ctx context.Context, userID uint64, credentialID string) error {
	id, err := parseCredentialID(credentialID)
	if err != nil {
		return err
	}
	key, err := s.store.FindByID(id)
	if err != nil {
		return err
	}
	if key == nil || key.UserID != userID {
		return deviceErr(404, DeviceErrNotFound, "")
	}
	if key.RevokedAt != nil {
		return nil
	}
	return s.store.Revoke(id, models.DeviceKeyRevokedByUser, s.now())
}

// RevokeAllForUser ends every key of an account (password reset, 2FA
// turned on). Logs and never fails the caller: the action that triggered
// it already happened.
func (s *DeviceKeyService) RevokeAllForUser(userID uint64, reason string) {
	n, err := s.store.RevokeAllForUser(userID, reason, s.now())
	if err != nil {
		log.Printf("[DEVICE-KEY] could not revoke the keys of user %d (%s): %v", userID, reason, err)
		return
	}
	if n > 0 {
		log.Printf("[DEVICE-KEY] revoked %d key(s) of user %d: %s", n, userID, reason)
	}
}

// DeviceKeySkipsSecondFactor documents a decision (Nov 12 2026): a device
// key login does not ask the 2FA code.
//
//   - The key was enrolled from a session, and a session of an account with
//     2FA only exists after the code was given. Turning 2FA on revokes every
//     key made before (DeviceKeyRevokedTwoFactor), so no key predates it.
//   - The key is a possession factor bound to hardware: it cannot be copied
//     off the phone. With Face ID or the fingerprint on, it is possession
//     plus inherence, two factors by itself.
//   - This is how trusted devices work at Instagram, Google or Apple: the
//     second factor is asked on a new device, not on the one already trusted.
//
// A password reset (someone may know the password) revokes every key too.
const DeviceKeySkipsSecondFactor = true
