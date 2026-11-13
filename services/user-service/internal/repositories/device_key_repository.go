package repositories

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/atto-sound/user-service/internal/models"
)

// DeviceKeyRepository stores the device keys of remembered accounts.
type DeviceKeyRepository struct {
	db *gorm.DB
}

// NewDeviceKeyRepository creates the repository.
func NewDeviceKeyRepository(db *gorm.DB) *DeviceKeyRepository {
	return &DeviceKeyRepository{db: db}
}

// Create inserts a new key.
func (r *DeviceKeyRepository) Create(k *models.DeviceKey) error {
	return r.db.Create(k).Error
}

// findOne uses Find, not First: "no such key" is a normal answer here and
// must not log a "record not found" line on every unknown credential.
func (r *DeviceKeyRepository) findOne(q *gorm.DB) (*models.DeviceKey, error) {
	var keys []models.DeviceKey
	if err := q.Limit(1).Find(&keys).Error; err != nil {
		return nil, err
	}
	if len(keys) == 0 {
		return nil, nil
	}
	return &keys[0], nil
}

// FindByID returns nil, nil when there is no such key.
func (r *DeviceKeyRepository) FindByID(id uuid.UUID) (*models.DeviceKey, error) {
	return r.findOne(r.db.Where("id = ?", id))
}

// FindByKeyHash returns nil, nil when the public key was never enrolled.
func (r *DeviceKeyRepository) FindByKeyHash(hash string) (*models.DeviceKey, error) {
	return r.findOne(r.db.Where("key_hash = ?", hash))
}

// ListLive returns the keys of a user that are not revoked.
func (r *DeviceKeyRepository) ListLive(userID uint64) ([]models.DeviceKey, error) {
	var keys []models.DeviceKey
	err := r.db.Where("user_id = ? AND revoked_at IS NULL", userID).
		Order("created_at DESC").Find(&keys).Error
	return keys, err
}

// SetChallenge replaces the live challenge of a live key.
func (r *DeviceKeyRepository) SetChallenge(id uuid.UUID, hash string, expiresAt time.Time) error {
	return r.db.Model(&models.DeviceKey{}).
		Where("id = ? AND revoked_at IS NULL", id).
		Updates(map[string]interface{}{"challenge_hash": hash, "challenge_expires_at": expiresAt}).Error
}

// ConsumeChallenge spends the challenge in one statement: two requests with
// the same challenge cannot both pass.
func (r *DeviceKeyRepository) ConsumeChallenge(id uuid.UUID, hash string, now time.Time) (bool, error) {
	res := r.db.Model(&models.DeviceKey{}).
		Where("id = ? AND revoked_at IS NULL AND challenge_hash <> '' AND challenge_hash = ? AND challenge_expires_at > ?",
			id, hash, now).
		Updates(map[string]interface{}{"challenge_hash": "", "challenge_expires_at": nil})
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

// MarkUsed stamps the use and resets the bad signature count.
func (r *DeviceKeyRepository) MarkUsed(id uuid.UUID, at time.Time) error {
	return r.db.Model(&models.DeviceKey{}).Where("id = ?", id).
		Updates(map[string]interface{}{"last_used_at": at, "bad_signatures": 0}).Error
}

// AddBadSignature adds one and returns the count.
func (r *DeviceKeyRepository) AddBadSignature(id uuid.UUID) (int, error) {
	var n int
	err := r.db.Raw(`UPDATE device_keys SET bad_signatures = bad_signatures + 1, updated_at = NOW()
		WHERE id = ? RETURNING bad_signatures`, id).Scan(&n).Error
	return n, err
}

// Revoke ends one key; a key already revoked keeps its first reason.
func (r *DeviceKeyRepository) Revoke(id uuid.UUID, reason string, at time.Time) error {
	return r.db.Model(&models.DeviceKey{}).
		Where("id = ? AND revoked_at IS NULL", id).
		Updates(map[string]interface{}{
			"revoked_at": at, "revoked_reason": reason,
			"challenge_hash": "", "challenge_expires_at": nil,
		}).Error
}

// RevokeAllForUser ends every live key of a user.
func (r *DeviceKeyRepository) RevokeAllForUser(userID uint64, reason string, at time.Time) (int64, error) {
	res := r.db.Model(&models.DeviceKey{}).
		Where("user_id = ? AND revoked_at IS NULL", userID).
		Updates(map[string]interface{}{
			"revoked_at": at, "revoked_reason": reason,
			"challenge_hash": "", "challenge_expires_at": nil,
		})
	return res.RowsAffected, res.Error
}
