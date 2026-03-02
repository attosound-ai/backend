package repositories

import (
	"errors"

	"github.com/atto-sound/user-service/internal/models"
	"gorm.io/gorm"
)

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
	err := r.db.Where("phone_country_code = ? AND phone_number = ?", countryCode, number).First(&user).Error
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
	err := r.db.Where("CONCAT(COALESCE(phone_country_code, ''), COALESCE(phone_number, '')) = ?", fullPhone).First(&user).Error
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
	err := r.db.Where("(username ILIKE ? OR display_name ILIKE ?) AND registration_status = ?", pattern, pattern, "completed").
		Limit(limit).
		Order("username ASC").
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
