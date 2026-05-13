package repositories

import (
	"errors"
	"time"

	"github.com/atto-sound/user-service/internal/models"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// SignupRepository handles persistence for in-progress signup sessions.
type SignupRepository struct {
	db *gorm.DB
}

func NewSignupRepository(db *gorm.DB) *SignupRepository {
	return &SignupRepository{db: db}
}

// FindActiveByIdentifier returns the currently-active (started or verified)
// session for the given identifier, or nil if none. The unique partial index
// ensures at most one active session per identifier.
func (r *SignupRepository) FindActiveByIdentifier(identifier string) (*models.SignupSession, error) {
	var s models.SignupSession
	err := r.db.Where(
		"identifier = ? AND status IN ?",
		identifier,
		[]models.SignupStatus{models.SignupStatusStarted, models.SignupStatusVerified},
	).First(&s).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// FindByID returns a session by its UUID, regardless of status.
func (r *SignupRepository) FindByID(id uuid.UUID) (*models.SignupSession, error) {
	var s models.SignupSession
	err := r.db.Where("id = ?", id).First(&s).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// Create inserts a new signup session.
func (r *SignupRepository) Create(s *models.SignupSession) error {
	return r.db.Create(s).Error
}

// Update persists changes to the given session row.
func (r *SignupRepository) Update(s *models.SignupSession) error {
	return r.db.Save(s).Error
}

// IncrementOTPAttempts atomically bumps the counter and returns the new value.
// Useful for rate-limiting at the session level (the OTP service rate-limits
// globally, this gives per-signup visibility).
func (r *SignupRepository) IncrementOTPAttempts(id uuid.UUID) (int, error) {
	res := r.db.Model(&models.SignupSession{}).
		Where("id = ?", id).
		UpdateColumn("otp_attempts", gorm.Expr("otp_attempts + 1"))
	if res.Error != nil {
		return 0, res.Error
	}
	var s models.SignupSession
	if err := r.db.Select("otp_attempts").Where("id = ?", id).First(&s).Error; err != nil {
		return 0, err
	}
	return s.OTPAttempts, nil
}

// Delete removes a session row (used after successful promotion to users).
func (r *SignupRepository) Delete(id uuid.UUID) error {
	return r.db.Where("id = ?", id).Delete(&models.SignupSession{}).Error
}

// MarkAbandoned flags expired active sessions. Returns how many rows changed.
// Run periodically from the cron worker.
func (r *SignupRepository) MarkAbandoned(cutoff time.Time) (int64, error) {
	res := r.db.Model(&models.SignupSession{}).
		Where("status IN ? AND expires_at < ?",
			[]models.SignupStatus{models.SignupStatusStarted, models.SignupStatusVerified},
			cutoff,
		).
		Update("status", models.SignupStatusAbandoned)
	return res.RowsAffected, res.Error
}

// PurgeAbandoned hard-deletes abandoned sessions older than the cutoff.
// Two-stage cleanup (mark → purge) gives us audit/analytics time before the
// row vanishes.
func (r *SignupRepository) PurgeAbandoned(cutoff time.Time) (int64, error) {
	res := r.db.Where("status = ? AND updated_at < ?", models.SignupStatusAbandoned, cutoff).
		Delete(&models.SignupSession{})
	return res.RowsAffected, res.Error
}
