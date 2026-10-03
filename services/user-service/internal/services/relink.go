package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"

	"github.com/atto-sound/user-service/internal/models"
)

// RelinkRequest gives an orphaned managed creator a new representative.
//
// Oct 3 2026: the representative arami (266) was deleted at the client's
// request and its creator aramis (267) stayed, with representative_id
// pointing at nothing. Stephanie kept signing in to the creator but could not
// edit it, switch accounts or add her old account back. This rebuilds the
// pair the way signup would have left it.
type RelinkRequest struct {
	CreatorID       uint64 `json:"creatorId"`
	CreatorUsername string `json:"creatorUsername"`
	Email           string `json:"email"`
	Username        string `json:"username"`
	DisplayName     string `json:"displayName"`
	Relationship    string `json:"relationship"`
	Avatar          string `json:"avatar"`
	RequestedBy     string `json:"requestedBy"`
	PerformedBy     string `json:"performedBy"`
	Reason          string `json:"reason"`
}

// Relink errors the handler maps to status codes.
var (
	ErrRelinkIncomplete   = errors.New("creatorId, creatorUsername, email, username, displayName, requestedBy, performedBy and reason are required")
	ErrRelinkNotCreator   = errors.New("that account is not a managed creator")
	ErrRelinkNotOrphan    = errors.New("that creator still has a representative")
	ErrRelinkNameMismatch = errors.New("creatorUsername does not match creatorId")
	ErrRelinkTaken        = errors.New("email or username already in use")
)

// Validate checks the request before touching the database.
func (r RelinkRequest) Validate() error {
	for _, v := range []string{r.CreatorUsername, r.Email, r.Username, r.DisplayName, r.RequestedBy, r.PerformedBy, r.Reason} {
		if strings.TrimSpace(v) == "" {
			return ErrRelinkIncomplete
		}
	}
	if r.CreatorID == 0 || !strings.Contains(r.Email, "@") {
		return ErrRelinkIncomplete
	}
	return nil
}

// RelinkResult is what the operator gets back.
type RelinkResult struct {
	RepresentativeID uint64 `json:"representativeId"`
	Username         string `json:"username"`
	Email            string `json:"email"`
	CreatorID        uint64 `json:"creatorId"`
	CreatorEmail     string `json:"creatorInternalEmail"`
}

// RelinkOrphanedCreator creates the representative and points the creator at
// it in one transaction. The representative signs in with the creator's
// current password (the person managing both chose it at signup) and can
// reset it by email.
func (s *UserService) RelinkOrphanedCreator(ctx context.Context, req RelinkRequest) (*RelinkResult, error) {
	if err := req.Validate(); err != nil {
		return nil, err
	}
	creator, err := s.repo.FindByID(req.CreatorID)
	if err != nil || creator == nil {
		return nil, errors.New("user not found")
	}
	if !strings.EqualFold(creator.Username, strings.TrimSpace(req.CreatorUsername)) {
		return nil, ErrRelinkNameMismatch
	}
	if creator.Role != models.RoleCreator || !creator.IsManagedAccount {
		return nil, ErrRelinkNotCreator
	}
	if creator.RepresentativeID != nil {
		if rep, _ := s.repo.FindByID(*creator.RepresentativeID); rep != nil {
			return nil, ErrRelinkNotOrphan
		}
	}

	email := strings.ToLower(strings.TrimSpace(req.Email))
	username := strings.ToLower(strings.TrimSpace(req.Username))
	rep := &models.User{
		Username:           username,
		Email:              &email,
		DisplayName:        strings.TrimSpace(req.DisplayName),
		Role:               models.RoleRepresentative,
		InmateNumber:       creator.InmateNumber,
		InmateState:        creator.InmateState,
		ConsentToRecording: creator.ConsentToRecording,
	}
	if v := strings.TrimSpace(req.Relationship); v != "" {
		rep.Relationship = &v
	}
	if v := strings.TrimSpace(req.Avatar); v != "" {
		rep.Avatar = &v
	}
	name := creator.DisplayName
	rep.CreatorName = &name

	internalEmail, err := s.repo.CreateRepresentativeForCreator(rep, creator)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique") {
			return nil, ErrRelinkTaken
		}
		return nil, fmt.Errorf("relink failed: %w", err)
	}

	idStr := strconv.FormatUint(rep.ID, 10)
	log.Printf("[ADMIN] relinked creator %d (%s) to new representative %d (%s) requestedBy=%q performedBy=%q reason=%q",
		creator.ID, creator.Username, rep.ID, rep.Username, req.RequestedBy, req.PerformedBy, req.Reason)
	go func() {
		eventData := map[string]interface{}{
			"id":          idStr,
			"username":    rep.Username,
			"email":       email,
			"displayName": rep.DisplayName,
			"role":        string(rep.Role),
			"locale":      "en",
		}
		if err := s.producer.Publish(context.Background(), "user.created", idStr, eventData); err != nil {
			log.Printf("[ADMIN] Failed to publish user.created for relinked rep %d: %v", rep.ID, err)
		}
	}()

	return &RelinkResult{
		RepresentativeID: rep.ID,
		Username:         rep.Username,
		Email:            email,
		CreatorID:        creator.ID,
		CreatorEmail:     internalEmail,
	}, nil
}
