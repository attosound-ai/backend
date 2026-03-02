package services

import (
	"context"
	"errors"
	"log"
	"strconv"

	"github.com/atto-sound/user-service/internal/kafka"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
)

// UserService encapsulates user-related business logic (non-auth).
type UserService struct {
	repo     *repositories.UserRepository
	producer *kafka.Producer
}

// NewUserService creates a new UserService instance.
func NewUserService(repo *repositories.UserRepository, producer *kafka.Producer) *UserService {
	return &UserService{
		repo:     repo,
		producer: producer,
	}
}

// GetUserByID retrieves a single user by their ID string.
func (s *UserService) GetUserByID(ctx context.Context, id string) (*models.UserProfile, error) {
	uid, err := strconv.ParseUint(id, 10, 64)
	if err != nil {
		return nil, errors.New("invalid user ID format")
	}

	user, err := s.repo.FindByID(uid)
	if err != nil {
		log.Printf("[USER] Error fetching user %s: %v", id, err)
		return nil, errors.New("internal error")
	}
	if user == nil {
		return nil, errors.New("user not found")
	}

	return user.ToProfile(), nil
}

// GetUsersByIDs retrieves multiple users by their ID strings.
func (s *UserService) GetUsersByIDs(ctx context.Context, ids []string) ([]*models.UserProfile, error) {
	parsed := make([]uint64, 0, len(ids))
	for _, id := range ids {
		uid, err := strconv.ParseUint(id, 10, 64)
		if err != nil {
			continue // skip invalid IDs
		}
		parsed = append(parsed, uid)
	}

	users, err := s.repo.FindByIDs(parsed)
	if err != nil {
		log.Printf("[USER] Error fetching users batch: %v", err)
		return nil, errors.New("internal error")
	}

	profiles := make([]*models.UserProfile, 0, len(users))
	for i := range users {
		profiles = append(profiles, users[i].ToProfile())
	}

	return profiles, nil
}

// SearchUsers searches for users matching a query string.
func (s *UserService) SearchUsers(ctx context.Context, query string, limit int) ([]*models.UserProfile, error) {
	if query == "" {
		return []*models.UserProfile{}, nil
	}

	users, err := s.repo.SearchUsers(query, limit)
	if err != nil {
		log.Printf("[USER] Error searching users: %v", err)
		return nil, errors.New("internal error")
	}

	profiles := make([]*models.UserProfile, 0, len(users))
	for i := range users {
		profiles = append(profiles, users[i].ToProfile())
	}

	return profiles, nil
}

// collectOptionalStringUpdates sets non-nil *string values into the updates map.
// Returns true if at least one field was set.
func collectOptionalStringUpdates(updates map[string]interface{}, fields map[string]*string) bool {
	changed := false
	for col, val := range fields {
		if val != nil {
			updates[col] = *val
			changed = true
		}
	}
	return changed
}

// checkUsernameUniqueness returns an error if the requested username is taken by another user.
func (s *UserService) checkUsernameUniqueness(username string, uid uint64) error {
	existing, err := s.repo.FindByUsername(username)
	if err != nil {
		return errors.New("internal error")
	}
	if existing != nil && existing.ID != uid {
		return errors.New("username already taken")
	}
	return nil
}

// UpdateProfile updates profile fields for the given user.
func (s *UserService) UpdateProfile(ctx context.Context, userID string, req *models.UpdateProfileRequest) (*models.UserProfile, error) {
	uid, err := strconv.ParseUint(userID, 10, 64)
	if err != nil {
		return nil, errors.New("invalid user ID format")
	}

	updates := make(map[string]interface{})

	// Basic profile fields
	collectOptionalStringUpdates(updates, map[string]*string{
		"display_name": req.DisplayName,
		"avatar":       req.Avatar,
		"bio":          req.Bio,
	})
	if req.Username != nil {
		if err := s.checkUsernameUniqueness(*req.Username, uid); err != nil {
			return nil, err
		}
		updates["username"] = *req.Username
	}

	// Representative identity fields — changing these revokes verification
	repChanged := collectOptionalStringUpdates(updates, map[string]*string{
		"artist_name":  req.ArtistName,
		"inmate_number": req.InmateNumber,
		"inmate_state": req.InmateState,
		"relationship": req.Relationship,
		"artist_email": req.ArtistEmail,
		"artist_phone": req.ArtistPhone,
	})
	if repChanged {
		updates["profile_verified"] = false
	}

	if len(updates) == 0 {
		user, err := s.repo.FindByID(uid)
		if err != nil || user == nil {
			return nil, errors.New("user not found")
		}
		return user.ToProfile(), nil
	}

	if err := s.repo.UpdateUserFields(uid, updates); err != nil {
		log.Printf("[USER] Error updating profile for %s: %v", userID, err)
		return nil, errors.New("failed to update profile")
	}

	user, err := s.repo.FindByID(uid)
	if err != nil || user == nil {
		return nil, errors.New("user not found")
	}

	return user.ToProfile(), nil
}

// VerifyUser marks a user as profile-verified and publishes a user.verified event.
func (s *UserService) VerifyUser(ctx context.Context, userID string, inmateNumber string) (bool, []string, error) {
	uid, err := strconv.ParseUint(userID, 10, 64)
	if err != nil {
		return false, nil, errors.New("invalid user ID")
	}

	user, err := s.repo.FindByID(uid)
	if err != nil || user == nil {
		return false, nil, errors.New("user not found")
	}

	user.ProfileVerified = true
	user.InmateNumber = &inmateNumber

	if err := s.repo.UpdateUser(user); err != nil {
		log.Printf("[USER] Error verifying user %s: %v", userID, err)
		return false, nil, errors.New("failed to verify user")
	}

	// Publish user.verified event
	verifyIDStr := strconv.FormatUint(user.ID, 10)
	go func() {
		eventData := map[string]interface{}{
			"id":            verifyIDStr,
			"username":      user.Username,
			"inmateNumber":  inmateNumber,
			"verified":      true,
		}
		if err := s.producer.Publish(context.Background(), "user.verified", verifyIDStr, eventData); err != nil {
			log.Printf("[USER] Failed to publish user.verified event: %v", err)
		}
	}()

	allowedTypes := []string{"audio", "image", "video"}
	return true, allowedTypes, nil
}

// GetContentPermissions returns upload permissions for a user based on their role and verification status.
func (s *UserService) GetContentPermissions(ctx context.Context, userID string) (bool, []string, int64, error) {
	uid, err := strconv.ParseUint(userID, 10, 64)
	if err != nil {
		return false, nil, 0, errors.New("invalid user ID")
	}

	user, err := s.repo.FindByID(uid)
	if err != nil || user == nil {
		return false, nil, 0, errors.New("user not found")
	}

	// Determine permissions based on role and verification
	switch user.Role {
	case models.RoleArtist:
		if user.ProfileVerified {
			return true, []string{"audio", "image", "video"}, 500 * 1024 * 1024, nil // 500MB
		}
		return false, []string{}, 0, nil
	case models.RoleRepresentative:
		return true, []string{"audio", "image", "video"}, 500 * 1024 * 1024, nil
	case models.RoleListener:
		return true, []string{"image"}, 10 * 1024 * 1024, nil // 10MB, images only
	default:
		return false, []string{}, 0, nil
	}
}
