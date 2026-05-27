package services

import (
	"context"
	"errors"
	"fmt"
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

// DiscoverUsers returns a list of registered users excluding the requester.
func (s *UserService) DiscoverUsers(ctx context.Context, excludeID uint64, limit int) ([]*models.UserProfile, error) {
	users, err := s.repo.DiscoverUsers(excludeID, limit)
	if err != nil {
		log.Printf("[USER] Error discovering users: %v", err)
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
		"creator_name":  req.CreatorName,
		"inmate_number": req.InmateNumber,
		"inmate_state":  req.InmateState,
		"relationship":  req.Relationship,
		"creator_email": req.CreatorEmail,
		"creator_phone": req.CreatorPhone,
	})
	if repChanged {
		updates["profile_verified"] = false
	}

	// Social media links + extended bio
	collectOptionalStringUpdates(updates, map[string]*string{
		"social_instagram":  req.SocialInstagram,
		"social_tiktok":     req.SocialTiktok,
		"social_youtube":    req.SocialYoutube,
		"social_soundcloud": req.SocialSoundcloud,
		"social_spotify":    req.SocialSpotify,
		"social_twitter":    req.SocialTwitter,
		"website":           req.Website,
		"location":          req.Location,
		"record_label":      req.RecordLabel,
		"booking_email":     req.BookingEmail,
	})

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
			"id":           verifyIDStr,
			"username":     user.Username,
			"inmateNumber": inmateNumber,
			"verified":     true,
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
	case models.RoleCreator:
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

// GetActivePushTokens returns active push tokens for a user.
func (s *UserService) GetActivePushTokens(userID uint64) ([]models.PushToken, error) {
	return s.repo.GetActivePushTokens(userID)
}

// DeleteAccount permanently removes a user and all associated data from
// every Postgres table, then emits a Kafka event so non-Postgres stores
// (MongoDB, Cassandra, Redis) can clean up asynchronously.
func (s *UserService) DeleteAccount(ctx context.Context, userID uint64, deleteLinked bool) error {
	user, err := s.repo.FindByID(userID)
	if err != nil || user == nil {
		return errors.New("user not found")
	}

	userIDs := []uint64{userID}

	if deleteLinked {
		linked, err := s.repo.GetLinkedAccounts(
			userID,
			user.IsManagedAccount,
			user.RepresentativeID,
		)
		if err != nil {
			log.Printf("[USER] Warning: failed to fetch linked accounts for %d: %v", userID, err)
		}
		for _, u := range linked {
			userIDs = append(userIDs, u.ID)
		}
		if len(userIDs) > 1 {
			log.Printf("[USER] Including linked accounts in deletion: %v", userIDs)
		}
	}

	// Single transaction: wipe user-service Postgres rows.
	// Other services purge their own rows via the user.deleted Kafka event.
	if err := s.repo.PurgeAllUserData(userIDs); err != nil {
		log.Printf("[USER] Failed to purge user-service data for users %v: %v", userIDs, err)
		// Surface the underlying message so the client can diagnose.
		// Safe to return: this code path never sees user-supplied SQL.
		return fmt.Errorf("delete account failed: %w", err)
	}

	log.Printf("[USER] Purged user-service rows for %v; cross-service cleanup via Kafka", userIDs)

	// Emit Kafka event for async cleanup (MongoDB, Cassandra, Redis)
	idStrs := make([]string, len(userIDs))
	for i, id := range userIDs {
		idStrs[i] = strconv.FormatUint(id, 10)
	}
	go func() {
		eventData := map[string]interface{}{
			"userIds": idStrs,
		}
		if err := s.producer.Publish(context.Background(), "user.deleted", idStrs[0], eventData); err != nil {
			log.Printf("[USER] Failed to publish user.deleted event: %v", err)
		}
	}()

	return nil
}

// GetLinkedAccounts returns accounts linked to the given user.
func (s *UserService) GetLinkedAccounts(userID uint64) ([]*models.User, error) {
	user, err := s.repo.FindByID(userID)
	if err != nil || user == nil {
		return nil, nil
	}
	return s.repo.GetLinkedAccounts(userID, user.IsManagedAccount, user.RepresentativeID)
}

// GetLinkedAccountIDsForUser returns the full set of linked account IDs for
// the given user (representative + every managed creator under that
// representative). For standalone users (no representative_id, not managed),
// returns just [userID].
//
// Returns (nil, nil) when the user does not exist — caller distinguishes
// "missing" from "empty" by the nil slice. Used by telephony-service to
// fan out TwiML across all reachable Voice SDK identities for a device.
func (s *UserService) GetLinkedAccountIDsForUser(userID uint64) ([]uint64, error) {
	user, err := s.repo.FindByID(userID)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, nil
	}

	var anchorID uint64
	if user.IsManagedAccount && user.RepresentativeID != nil {
		anchorID = *user.RepresentativeID
	} else {
		anchorID = user.ID
	}

	ids, err := s.repo.GetLinkedAccountIDs(anchorID)
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		// Defensive: anchor row must exist, but if Postgres returns empty
		// for any reason we still want to honour the contract that the
		// requested userID is always in the result.
		return []uint64{userID}, nil
	}
	return ids, nil
}
