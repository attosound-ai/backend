package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/atto-sound/user-service/internal/kafka"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
)

// UserService encapsulates user-related business logic (non-auth).
type UserService struct {
	repo     *repositories.UserRepository
	producer *kafka.Producer
	// socialStats da los números reales a la lista de operador. Nil o apagado:
	// la lista sirve las columnas guardadas.
	socialStats *SocialStatsClient
}

// NewUserService creates a new UserService instance.
func NewUserService(repo *repositories.UserRepository, producer *kafka.Producer) *UserService {
	return &UserService{
		repo:     repo,
		producer: producer,
	}
}

// SetSocialStats conecta el cliente del servicio social. Es opcional y solo
// lo usa la lista de operador; las rutas públicas no lo tocan.
func (s *UserService) SetSocialStats(c *SocialStatsClient) {
	s.socialStats = c
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
//
// meta is mandatory: one account_deletions row per removed account is
// written in the same transaction as the delete (see models.AccountDeletion).
func (s *UserService) DeleteAccount(ctx context.Context, userID uint64, deleteLinked bool, meta DeletionMeta) error {
	if err := meta.Validate(); err != nil {
		return err
	}
	user, err := s.repo.FindByID(userID)
	if err != nil || user == nil {
		return errors.New("user not found")
	}

	userIDs := []uint64{userID}

	// Always look the linked accounts up: they are deleted with deleteLinked,
	// and otherwise they tell the record which creators are left orphaned.
	linked, err := s.repo.GetLinkedAccounts(
		userID,
		user.IsManagedAccount,
		user.RepresentativeID,
	)
	if err != nil {
		log.Printf("[USER] Warning: failed to fetch linked accounts for %d: %v", userID, err)
	}
	var extra []*models.User
	if deleteLinked {
		for _, u := range linked {
			userIDs = append(userIDs, u.ID)
			extra = append(extra, u)
		}
		if len(userIDs) > 1 {
			log.Printf("[USER] Including linked accounts in deletion: %v", userIDs)
		}
	}

	batchID := uuid.NewString()
	records := BuildDeletionRecords(batchID, user, extra, linked, meta, time.Now().UTC())

	// Single transaction: the deletion records plus the user-service rows.
	// Other services purge their own rows via the user.deleted Kafka event.
	if err := s.repo.PurgeAllUserData(userIDs, records); err != nil {
		log.Printf("[USER] Failed to purge user-service data for users %v: %v", userIDs, err)
		// Surface the underlying message so the client can diagnose.
		// Safe to return: this code path never sees user-supplied SQL.
		return fmt.Errorf("delete account failed: %w", err)
	}

	log.Printf("[USER] Purged user-service rows for %v via=%s requestedBy=%q performedBy=%q batch=%s; cross-service cleanup via Kafka",
		userIDs, meta.Via, meta.RequestedBy, meta.PerformedBy, batchID)
	go captureDeletions(records)

	// Emit Kafka event for async cleanup (MongoDB, Cassandra, Redis)
	idStrs := make([]string, len(userIDs))
	for i, id := range userIDs {
		idStrs[i] = strconv.FormatUint(id, 10)
	}
	go func() {
		eventData := map[string]interface{}{
			"userIds": idStrs,
			"batchId": batchID,
			"via":     meta.Via,
		}
		if err := s.producer.Publish(context.Background(), "user.deleted", idStrs[0], eventData); err != nil {
			log.Printf("[USER] Failed to publish user.deleted event: %v", err)
		}
	}()

	return nil
}

// ListDeletions serves the operator's deletion history.
func (s *UserService) ListDeletions(search string, limit, offset int) (*DeletionList, error) {
	rows, total, err := s.repo.ListDeletions(search, limit, offset)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []models.AccountDeletion{}
	}
	return &DeletionList{Deletions: rows, Total: total}, nil
}

// DeletionList is one page of the deletion history.
type DeletionList struct {
	Deletions []models.AccountDeletion `json:"deletions"`
	Total     int64                    `json:"total"`
}

// GetLinkedAccounts returns accounts linked to the given user.
func (s *UserService) GetLinkedAccounts(userID uint64) ([]*models.User, error) {
	user, err := s.repo.FindByID(userID)
	if err != nil || user == nil {
		return nil, nil
	}
	return s.repo.GetLinkedAccounts(userID, user.IsManagedAccount, user.RepresentativeID)
}

// GetActivePushTokensForUser returns the list of currently-active Expo push
// tokens registered to a given user. Used by telephony-service to deliver
// "missed call" fallback notifications when the Twilio Voice SDK push fails
// to reach a device (e.g., SDK unregistered, watchdog kill, push-cred
// mismatch), so the user at least sees a regular notification rather than
// the call disappearing silently.
func (s *UserService) GetActivePushTokensForUser(userID uint64) ([]models.PushToken, error) {
	return s.repo.GetActivePushTokens(userID)
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

// AdminUserRow es una fila de la lista de operador: lo justo para identificar
// una cuenta y saber cómo entró, sin arrastrar la ficha entera.
//
// StatsLive dice de dónde salen FollowersCount y PostsCount: true si los acaba
// de dar el servicio social (los mismos que enseña el perfil de la app), false
// si son las columnas guardadas, que nadie actualiza.
type AdminUserRow struct {
	ID               uint64     `json:"id"`
	Username         string     `json:"username"`
	DisplayName      string     `json:"displayName"`
	Email            *string    `json:"email,omitempty"`
	Phone            *string    `json:"phone,omitempty"`
	Role             string     `json:"role"`
	CreatorName      *string    `json:"creatorName,omitempty"`
	Avatar           *string    `json:"avatar,omitempty"`
	Location         *string    `json:"location,omitempty"`
	ProfileVerified  bool       `json:"profileVerified"`
	IsManagedAccount bool       `json:"isManagedAccount"`
	RepresentativeID *uint64    `json:"representativeId,omitempty"`
	FollowersCount   int64      `json:"followersCount"`
	PostsCount       int64      `json:"postsCount"`
	StatsLive        bool       `json:"statsLive"`
	CreatedAt        time.Time  `json:"createdAt"`
	LastSeenAt       *time.Time `json:"lastSeenAt,omitempty"`
}

// AdminUserList es la respuesta completa de la lista.
type AdminUserList struct {
	Users     []AdminUserRow   `json:"users"`
	Total     int64            `json:"total"`
	Limit     int              `json:"limit"`
	Offset    int              `json:"offset"`
	ByRole    map[string]int64 `json:"byRole"`
	Truncated bool             `json:"truncated"`
}

// telefonoCompleto junta prefijo y número para que la lista muestre uno solo.
func telefonoCompleto(cc, number *string) *string {
	if number == nil || *number == "" {
		return nil
	}
	if cc == nil || *cc == "" {
		return number
	}
	full := *cc + *number
	return &full
}

// applyLiveStats pisa seguidores y publicaciones con los números reales de las
// filas que los tienen y marca cada fila con su origen. Las que no están en el
// mapa conservan lo guardado y quedan con StatsLive en false.
func applyLiveStats(rows []AdminUserRow, stats map[uint64]SocialStats) {
	for i := range rows {
		st, ok := stats[rows[i].ID]
		rows[i].StatsLive = ok
		if !ok {
			continue
		}
		rows[i].FollowersCount = st.Followers
		rows[i].PostsCount = st.Posts
	}
}

// ListUsersForAdmin devuelve la página pedida de usuarios registrados.
func (s *UserService) ListUsersForAdmin(
	ctx context.Context,
	f repositories.AdminUserFilter,
) (*AdminUserList, error) {
	users, total, err := s.repo.ListForAdmin(f)
	if err != nil {
		log.Printf("[ADMIN] list users failed: %v", err)
		return nil, errors.New("could not list users")
	}

	rows := make([]AdminUserRow, 0, len(users))
	for i := range users {
		u := &users[i]
		rows = append(rows, AdminUserRow{
			ID:               u.ID,
			Username:         u.Username,
			DisplayName:      u.DisplayName,
			Email:            u.Email,
			Phone:            telefonoCompleto(u.PhoneCountryCode, u.PhoneNumber),
			Role:             string(u.Role),
			CreatorName:      u.CreatorName,
			Avatar:           u.Avatar,
			Location:         u.Location,
			ProfileVerified:  u.ProfileVerified,
			IsManagedAccount: u.IsManagedAccount,
			RepresentativeID: u.RepresentativeID,
			FollowersCount:   u.FollowersCount,
			PostsCount:       u.PostsCount,
			CreatedAt:        u.CreatedAt,
		})
	}

	// Seguidores y publicaciones de verdad los calcula el servicio social; las
	// columnas de users se quedaron en cero porque nada las actualiza. Se
	// piden solo los de esta página, y la fila que no responde a tiempo se
	// queda con lo guardado: nunca tumba ni frena la lista.
	if s.socialStats.Enabled() && len(rows) > 0 {
		ids := make([]uint64, len(rows))
		for i := range rows {
			ids[i] = rows[i].ID
		}
		applyLiveStats(rows, s.socialStats.FetchStats(ctx, ids))
	}

	// El recuento por rol es del total, no de la página: es la cabecera de la
	// pantalla y tiene que decir cuántos hay, no cuántos se ven.
	byRole, err := s.repo.CountUsersByRole()
	if err != nil {
		// Que falle el resumen no puede tumbar la lista.
		log.Printf("[ADMIN] count by role failed: %v", err)
		byRole = map[string]int64{}
	}

	limit := f.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	return &AdminUserList{
		Users:     rows,
		Total:     total,
		Limit:     limit,
		Offset:    f.Offset,
		ByRole:    byRole,
		Truncated: int64(f.Offset+len(rows)) < total,
	}, nil
}
