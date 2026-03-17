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
	err := r.db.Where("(username ILIKE ? OR display_name ILIKE ? OR email ILIKE ? OR phone_number ILIKE ?) AND registration_status = ?", pattern, pattern, pattern, pattern, "completed").
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
	err := r.db.Where("id != ? AND registration_status = ?", excludeID, "completed").
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

// slugifyArtistName converts an artist name to a lowercase alphanumeric slug (max 20 chars).
func slugifyArtistName(name string) string {
	re := regexp.MustCompile(`[^a-z0-9]+`)
	slug := re.ReplaceAllString(strings.ToLower(name), "_")
	slug = strings.Trim(slug, "_")
	if len(slug) > 20 {
		slug = slug[:20]
	}
	if slug == "" {
		slug = "artista"
	}
	return slug
}

// CreateManagedArtist creates a managed artist account linked to the given representative.
// When artistFields is provided, creates a full account with real email, password, and credentials.
// When artistFields is nil, falls back to auto-generated email/username (legacy behavior).
func (r *UserRepository) CreateManagedArtist(
	repUser *models.User,
	artistFields *models.ManagedArtistFields,
	passwordHash string,
	inmateNumber, inmateState string,
	consentToRecording bool,
) (*models.User, error) {
	repID := repUser.ID

	var email, username, displayName string
	var phoneCountryCode, phoneNumber, avatar *string
	var artistTypes, artistGenres []string

	if artistFields != nil {
		email = strings.ToLower(artistFields.Email)
		username = strings.ToLower(artistFields.Username)
		displayName = artistFields.DisplayName
		phoneCountryCode = artistFields.PhoneCountryCode
		phoneNumber = artistFields.PhoneNumber
		avatar = artistFields.Avatar
		artistTypes = artistFields.ArtistTypes
		artistGenres = artistFields.ArtistGenres
	} else {
		// Legacy fallback: auto-generate
		email = fmt.Sprintf("artist_%s_%d@managed.atto", inmateNumber, repUser.ID)
		slug := slugifyArtistName(displayName)
		username = fmt.Sprintf("artist_%s_%04d", slug, rand.Intn(10000))
		displayName = inmateNumber // best-effort fallback
	}

	artist := &models.User{
		Email:              email,
		Username:           username,
		DisplayName:        displayName,
		Role:               models.RoleArtist,
		IsManagedAccount:   true,
		RepresentativeID:   &repID,
		PhoneCountryCode:   phoneCountryCode,
		PhoneNumber:        phoneNumber,
		Avatar:             avatar,
		InmateNumber:       &inmateNumber,
		InmateState:        &inmateState,
		ConsentToRecording: &consentToRecording,
		ArtistTypes:        artistTypes,
		ArtistGenres:       artistGenres,
		RegistrationStatus: "completed",
	}

	// If we have a real password, create user + credentials in a transaction
	if passwordHash != "" {
		creds := &models.UserCredentials{PasswordHash: passwordHash}
		if err := r.CreateUserWithCredentials(artist, creds); err != nil {
			return nil, fmt.Errorf("failed to create managed artist with credentials: %w", err)
		}
		return artist, nil
	}

	// Legacy: no credentials
	if err := r.db.Create(artist).Error; err != nil {
		return nil, fmt.Errorf("failed to create managed artist: %w", err)
	}
	return artist, nil
}

// GetLinkedAccounts returns accounts linked to the caller.
// If isManagedAccount is true, returns the representative via representativeID.
// Otherwise returns all managed artists where representative_id = callerID.
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
