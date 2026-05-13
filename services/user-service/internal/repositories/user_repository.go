package repositories

import (
	"errors"
	"fmt"
	"math/rand"
	"regexp"
	"strings"

	"github.com/atto-sound/user-service/internal/models"
	"gorm.io/gorm"
)

var nonDigitRe = regexp.MustCompile(`[^0-9]`)

// digitsOnly strips all non-digit characters from a phone number string.
func digitsOnly(s string) string {
	return nonDigitRe.ReplaceAllString(s, "")
}

// UserRepository handles all database operations for users.
type UserRepository struct {
	db *gorm.DB
}

// NewUserRepository creates a new UserRepository.
func NewUserRepository(db *gorm.DB) *UserRepository {
	return &UserRepository{db: db}
}

// CreateUser inserts a new User into the database.
func (r *UserRepository) CreateUser(user *models.User) error {
	return r.db.Create(user).Error
}

// CreateCredentials inserts new UserCredentials into the database.
func (r *UserRepository) CreateCredentials(creds *models.UserCredentials) error {
	return r.db.Create(creds).Error
}

// FindByID retrieves a user by their ID.
func (r *UserRepository) FindByID(id uint64) (*models.User, error) {
	var user models.User
	err := r.db.Where("id = ?", id).First(&user).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

// FindByEmail retrieves a user by their email address.
func (r *UserRepository) FindByEmail(email string) (*models.User, error) {
	var user models.User
	err := r.db.Where("email = ?", email).First(&user).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

// FindByPhone retrieves a user by their phone country code and number.
func (r *UserRepository) FindByPhone(countryCode, number string) (*models.User, error) {
	var user models.User
	err := r.db.Where("phone_country_code = ? AND REGEXP_REPLACE(phone_number, '[^0-9]', '', 'g') = ?", countryCode, digitsOnly(number)).First(&user).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

// FindByFullPhone retrieves a user by their full E.164 phone (country code + number concatenated).
func (r *UserRepository) FindByFullPhone(fullPhone string) (*models.User, error) {
	var user models.User
	normalized := digitsOnly(fullPhone)
	err := r.db.Where("REGEXP_REPLACE(CONCAT(COALESCE(phone_country_code, ''), COALESCE(phone_number, '')), '[^0-9]', '', 'g') = ?", normalized).First(&user).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

// FindByPhoneNumber retrieves a user by their phone number (without country code).
func (r *UserRepository) FindByPhoneNumber(number string) (*models.User, error) {
	var user models.User
	err := r.db.Where("REGEXP_REPLACE(phone_number, '[^0-9]', '', 'g') = ?", digitsOnly(number)).First(&user).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

// FindByUsername retrieves a user by their username.
func (r *UserRepository) FindByUsername(username string) (*models.User, error) {
	var user models.User
	err := r.db.Where("username = ?", username).First(&user).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

// FindCredentialsByUserID retrieves credentials for a given user ID.
func (r *UserRepository) FindCredentialsByUserID(userID uint64) (*models.UserCredentials, error) {
	var creds models.UserCredentials
	err := r.db.Where("user_id = ?", userID).First(&creds).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &creds, nil
}

// FindByIDs retrieves multiple users by their IDs.
func (r *UserRepository) FindByIDs(ids []uint64) ([]models.User, error) {
	var users []models.User
	if len(ids) == 0 {
		return users, nil
	}
	err := r.db.Where("id IN ?", ids).Find(&users).Error
	return users, err
}

// SearchUsers searches for users by username or display name with ILIKE.
func (r *UserRepository) SearchUsers(query string, limit int) ([]models.User, error) {
	var users []models.User
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	pattern := "%" + query + "%"
	err := r.db.Where("username ILIKE ? OR display_name ILIKE ? OR email ILIKE ? OR phone_number ILIKE ?", pattern, pattern, pattern, pattern).
		Limit(limit).
		Order("username ASC").
		Find(&users).Error
	return users, err
}

// DiscoverUsers returns up to limit registered users excluding the given ID.
func (r *UserRepository) DiscoverUsers(excludeID uint64, limit int) ([]models.User, error) {
	var users []models.User
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	err := r.db.Where("id != ?", excludeID).
		Limit(limit).
		Order("RANDOM()").
		Find(&users).Error
	return users, err
}

// UpdateUser updates an existing user record.
func (r *UserRepository) UpdateUser(user *models.User) error {
	return r.db.Save(user).Error
}

// UpdateUserFields updates only the specified columns on a user record.
func (r *UserRepository) UpdateUserFields(id uint64, updates map[string]interface{}) error {
	return r.db.Model(&models.User{}).Where("id = ?", id).Updates(updates).Error
}

// UpdateCredentialsPassword updates only the password_hash for a given user.
func (r *UserRepository) UpdateCredentialsPassword(userID uint64, passwordHash string) error {
	return r.db.Model(&models.UserCredentials{}).
		Where("user_id = ?", userID).
		Update("password_hash", passwordHash).Error
}

// UpdateCredentials2FA updates the 2FA fields on UserCredentials.
func (r *UserRepository) UpdateCredentials2FA(userID uint64, enabled bool, method string) error {
	return r.db.Model(&models.UserCredentials{}).
		Where("user_id = ?", userID).
		Updates(map[string]interface{}{
			"two_factor_enabled": enabled,
			"two_factor_method":  method,
		}).Error
}

// slugifyCreatorName converts a creator name to a lowercase alphanumeric slug (max 20 chars).
func slugifyCreatorName(name string) string {
	re := regexp.MustCompile(`[^a-z0-9]+`)
	slug := re.ReplaceAllString(strings.ToLower(name), "_")
	slug = strings.Trim(slug, "_")
	if len(slug) > 20 {
		slug = slug[:20]
	}
	if slug == "" {
		slug = "creator"
	}
	return slug
}

// CreateManagedCreator creates a managed creator account linked to the given representative.
// When creatorFields is provided, creates a full account with real email, password, and credentials.
// When creatorFields is nil, falls back to auto-generated email/username (legacy behavior).
func (r *UserRepository) CreateManagedCreator(
	repUser *models.User,
	creatorFields *models.ManagedCreatorFields,
	passwordHash string,
	inmateNumber, inmateState string,
	consentToRecording bool,
) (*models.User, error) {
	repID := repUser.ID

	var username, displayName string
	var emailPtr, phoneCountryCode, phoneNumber, avatar *string
	var creatorTypes, creatorGenres []string

	if creatorFields != nil {
		trimmedEmail := strings.ToLower(strings.TrimSpace(creatorFields.Email))
		if trimmedEmail != "" {
			emailPtr = &trimmedEmail
		}
		username = strings.ToLower(creatorFields.Username)
		displayName = creatorFields.DisplayName
		phoneCountryCode = creatorFields.PhoneCountryCode
		phoneNumber = creatorFields.PhoneNumber
		avatar = creatorFields.Avatar
		creatorTypes = creatorFields.CreatorTypes
		creatorGenres = creatorFields.CreatorGenres
	} else {
		// Legacy fallback: auto-generate
		legacyEmail := fmt.Sprintf("creator_%s_%d@managed.atto", inmateNumber, repUser.ID)
		emailPtr = &legacyEmail
		slug := slugifyCreatorName(displayName)
		username = fmt.Sprintf("creator_%s_%04d", slug, rand.Intn(10000))
		displayName = inmateNumber // best-effort fallback
	}

	creator := &models.User{
		Email:              emailPtr,
		Username:           username,
		DisplayName:        displayName,
		Role:               models.RoleCreator,
		IsManagedAccount:   true,
		RepresentativeID:   &repID,
		PhoneCountryCode:   phoneCountryCode,
		PhoneNumber:        phoneNumber,
		Avatar:             avatar,
		InmateNumber:       &inmateNumber,
		InmateState:        &inmateState,
		ConsentToRecording: &consentToRecording,
		CreatorTypes:       creatorTypes,
		CreatorGenres:      creatorGenres,
	}

	// If we have a real password, create user + credentials in a transaction
	if passwordHash != "" {
		creds := &models.UserCredentials{PasswordHash: passwordHash}
		if err := r.CreateUserWithCredentials(creator, creds); err != nil {
			return nil, fmt.Errorf("failed to create managed creator with credentials: %w", err)
		}
		return creator, nil
	}

	// Legacy: no credentials
	if err := r.db.Create(creator).Error; err != nil {
		return nil, fmt.Errorf("failed to create managed creator: %w", err)
	}
	return creator, nil
}

// GetLinkedAccounts returns accounts linked to the caller.
// If isManagedAccount is true, returns the representative via representativeID.
// Otherwise returns all managed creators where representative_id = callerID.
func (r *UserRepository) GetLinkedAccounts(callerID uint64, isManagedAccount bool, representativeID *uint64) ([]*models.User, error) {
	var users []*models.User
	if isManagedAccount && representativeID != nil {
		var rep models.User
		if err := r.db.First(&rep, *representativeID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return users, nil
			}
			return nil, err
		}
		users = append(users, &rep)
	} else {
		if err := r.db.Where("representative_id = ? AND is_managed_account = true", callerID).Find(&users).Error; err != nil {
			return nil, err
		}
	}
	return users, nil
}

// CreateUserWithCredentials creates a user and their credentials in a single transaction.
func (r *UserRepository) CreateUserWithCredentials(user *models.User, creds *models.UserCredentials) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(user).Error; err != nil {
			return err
		}
		creds.UserID = user.ID
		if err := tx.Create(creds).Error; err != nil {
			return err
		}
		return nil
	})
}

// ── Push Token methods ──
// Multi-account: same token can map to multiple users (one row per user-token pair).

// UpsertPushToken creates or updates a push token for a specific user.
// Does NOT affect other users' mappings for the same token.
func (r *UserRepository) UpsertPushToken(userID uint64, token, deviceID, platform string) error {
	pt := models.PushToken{
		UserID:   userID,
		Token:    token,
		DeviceID: deviceID,
		Platform: platform,
		IsActive: true,
	}
	return r.db.Where("user_id = ? AND token = ?", userID, token).Assign(pt).FirstOrCreate(&pt).Error
}

// DeletePushToken removes a push token for a specific user only.
// Other users' mappings for the same token are preserved.
func (r *UserRepository) DeletePushToken(userID uint64, token string) error {
	return r.db.Where("user_id = ? AND token = ?", userID, token).Delete(&models.PushToken{}).Error
}

// DeactivateAllForToken marks ALL user mappings for a token as inactive
// (e.g. DeviceNotRegistered — the device no longer exists).
func (r *UserRepository) DeactivateAllForToken(token string) error {
	return r.db.Model(&models.PushToken{}).Where("token = ?", token).Update("is_active", false).Error
}

// GetActivePushTokens returns all active push tokens for a user.
func (r *UserRepository) GetActivePushTokens(userID uint64) ([]models.PushToken, error) {
	var tokens []models.PushToken
	err := r.db.Where("user_id = ? AND is_active = ?", userID, true).Find(&tokens).Error
	return tokens, err
}

// ── Account Deletion ──
// All methods accept a *gorm.DB (transaction) so the caller can wrap
// everything in a single atomic commit.

// DeleteUserRecord hard-deletes the user, credentials, and push tokens.
func (r *UserRepository) DeleteUserRecord(tx *gorm.DB, userID uint64) error {
	if err := tx.Unscoped().Where("user_id = ?", userID).Delete(&models.PushToken{}).Error; err != nil {
		return fmt.Errorf("delete push_tokens: %w", err)
	}
	if err := tx.Unscoped().Where("user_id = ?", userID).Delete(&models.UserCredentials{}).Error; err != nil {
		return fmt.Errorf("delete user_credentials: %w", err)
	}
	if err := tx.Unscoped().Where("id = ?", userID).Delete(&models.User{}).Error; err != nil {
		return fmt.Errorf("delete user: %w", err)
	}
	return nil
}

// DEPRECATED: cross-database DELETEs no longer attempted from user-service.
// Each service (social, payment, telephony, chat) owns its own Postgres DB
// in production and consumes the `user.deleted` Kafka event to purge its
// own rows. The functions below are kept for reference but no longer
// invoked by PurgeAllUserData — they were running against user-service's
// DB and failing with "relation does not exist" for tables that live in
// other DBs, which silently broke account deletion for any user with
// existing data.

// DeleteSocialData removes all social-service rows for a user (raw SQL
// because these tables are not managed by the user-service GORM models).
//
//nolint:unused // kept for reference/migration scenarios
func (r *UserRepository) DeleteSocialData(tx *gorm.DB, userID string) error {
	tables := []struct {
		sql string
	}{
		{`DELETE FROM follows WHERE follower_id = ? OR following_id = ?`},
		{`DELETE FROM interactions WHERE user_id = ?`},
		{`DELETE FROM comments WHERE user_id = ?`},
		{`DELETE FROM bookmarks WHERE user_id = ?`},
		{`DELETE FROM reposts WHERE user_id = ?`},
		{`DELETE FROM reel_views WHERE user_id = ?`},
	}
	for _, t := range tables {
		if strings.Contains(t.sql, "OR") {
			if err := tx.Exec(t.sql, userID, userID).Error; err != nil {
				return err
			}
		} else {
			if err := tx.Exec(t.sql, userID).Error; err != nil {
				return err
			}
		}
	}
	// Notifications reference two user columns
	if err := tx.Exec(`DELETE FROM notifications WHERE recipient_id = ? OR actor_id = ?`, userID, userID).Error; err != nil {
		return err
	}
	return nil
}

// DeletePaymentData removes subscriptions and transactions for a user.
//
//nolint:unused // kept for reference; superseded by Kafka user.deleted consumer
func (r *UserRepository) DeletePaymentData(tx *gorm.DB, userID string) error {
	if err := tx.Exec(`DELETE FROM subscriptions WHERE user_id = ?`, userID).Error; err != nil {
		return fmt.Errorf("delete subscriptions: %w", err)
	}
	if err := tx.Exec(`DELETE FROM transactions WHERE user_id = ?`, userID).Error; err != nil {
		return fmt.Errorf("delete transactions: %w", err)
	}
	return nil
}

// DeleteTelephonyData removes calls, phone assignments, projects, and related data.
//
//nolint:unused // kept for reference; superseded by Kafka user.deleted consumer
func (r *UserRepository) DeleteTelephonyData(tx *gorm.DB, userID string) error {
	if err := tx.Exec(`DELETE FROM calls WHERE "userId" = ?`, userID).Error; err != nil {
		return fmt.Errorf("delete calls: %w", err)
	}
	if err := tx.Exec(`DELETE FROM phone_number_assignments WHERE "userId" = ?`, userID).Error; err != nil {
		return fmt.Errorf("delete phone_number_assignments: %w", err)
	}
	// Delete project children first, then projects
	if err := tx.Exec(`DELETE FROM audio_segments WHERE "projectId"::text IN (SELECT id::text FROM projects WHERE "userId" = ?)`, userID).Error; err != nil {
		return fmt.Errorf("delete audio_segments: %w", err)
	}
	if err := tx.Exec(`DELETE FROM timeline_clips WHERE "projectId"::text IN (SELECT id::text FROM projects WHERE "userId" = ?)`, userID).Error; err != nil {
		return fmt.Errorf("delete timeline_clips: %w", err)
	}
	if err := tx.Exec(`DELETE FROM projects WHERE "userId" = ?`, userID).Error; err != nil {
		return fmt.Errorf("delete projects: %w", err)
	}
	return nil
}

// PurgeAllUserData deletes user-service-owned rows for a list of user IDs
// in a single atomic transaction (users, user_credentials, push_tokens).
// Other services (social, payment, telephony, chat) own their own
// Postgres DBs in production and consume the `user.deleted` Kafka event
// to purge their own rows asynchronously.
//
// Earlier versions of this function attempted cross-database DELETEs from
// user-service against tables like `follows`, `subscriptions`, `calls`,
// etc. — those tables don't exist in user-service's DB so the transaction
// always rolled back with "relation does not exist" and the user got
// "Something went wrong". The cross-DB attempts have been removed; the
// per-service Kafka consumers handle their own cleanup.
//
// Marker `_ = idStr` is omitted on purpose: idStr is no longer needed
// here because we no longer call the cross-DB helpers.
func (r *UserRepository) PurgeAllUserData(userIDs []uint64) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		for _, uid := range userIDs {
			if err := r.DeleteUserRecord(tx, uid); err != nil {
				return fmt.Errorf("user record (user %d): %w", uid, err)
			}
		}
		return nil
	})
}
