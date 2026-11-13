package services

import (
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/atto-sound/user-service/internal/models"
)

// DeletionMeta says how and why an account is being deleted. Every caller of
// DeleteAccount must fill it; there is no anonymous deletion any more.
type DeletionMeta struct {
	Via         string
	RequestedBy string
	PerformedBy string
	Reason      string
	ActorUserID *uint64
	ClientIP    string
	UserAgent   string
}

// ErrDeletionMetaIncomplete is returned before anything is deleted.
var ErrDeletionMetaIncomplete = errors.New("deletion needs via, requestedBy and performedBy (and a reason for operator deletions)")

// Validate refuses a deletion that would leave an unexplained record.
func (m DeletionMeta) Validate() error {
	if strings.TrimSpace(m.RequestedBy) == "" || strings.TrimSpace(m.PerformedBy) == "" {
		return ErrDeletionMetaIncomplete
	}
	switch m.Via {
	case models.DeletionViaSelfService:
		return nil
	case models.DeletionViaOperator:
		if strings.TrimSpace(m.Reason) == "" {
			return ErrDeletionMetaIncomplete
		}
		return nil
	default:
		return ErrDeletionMetaIncomplete
	}
}

// orphansOf returns the managed creators a deletion leaves without their
// representative: the target is a representative, and its creators are not
// among the accounts being deleted.
func orphansOf(target *models.User, linked []*models.User, deleting map[uint64]bool) []uint64 {
	if target == nil || target.IsManagedAccount {
		return nil
	}
	var out []uint64
	for _, u := range linked {
		if u == nil || !u.IsManagedAccount || u.RepresentativeID == nil || *u.RepresentativeID != target.ID {
			continue
		}
		if !deleting[u.ID] {
			out = append(out, u.ID)
		}
	}
	return out
}

func joinIDs(ids []uint64) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.FormatUint(id, 10)
	}
	return strings.Join(parts, ",")
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[:n]
	}
	return s
}

// BuildDeletionRecords turns one deletion request into one row per account.
// Pure, so the rules are tested without a database.
//
// target is the account the request named; extra are the linked accounts
// deleted with it (deleteLinked); linked is every account linked to target,
// deleted or not, used to detect creators left without a representative.
func BuildDeletionRecords(
	batchID string,
	target *models.User,
	extra []*models.User,
	linked []*models.User,
	meta DeletionMeta,
	now time.Time,
) []models.AccountDeletion {
	if target == nil {
		return nil
	}
	deleting := map[uint64]bool{target.ID: true}
	for _, u := range extra {
		if u != nil {
			deleting[u.ID] = true
		}
	}
	orphans := joinIDs(orphansOf(target, linked, deleting))

	row := func(u *models.User, asLinked bool) models.AccountDeletion {
		var phone *string
		if u.PhoneNumber != nil && *u.PhoneNumber != "" {
			p := *u.PhoneNumber
			if u.PhoneCountryCode != nil {
				p = *u.PhoneCountryCode + p
			}
			phone = &p
		}
		var created *time.Time
		if !u.CreatedAt.IsZero() {
			c := u.CreatedAt
			created = &c
		}
		r := models.AccountDeletion{
			BatchID:          batchID,
			DeletedUserID:    u.ID,
			Username:         u.Username,
			DisplayName:      u.DisplayName,
			Email:            u.Email,
			Phone:            phone,
			Role:             string(u.Role),
			IsManagedAccount: u.IsManagedAccount,
			RepresentativeID: u.RepresentativeID,
			InmateNumber:     u.InmateNumber,
			AccountCreatedAt: created,
			Via:              meta.Via,
			RequestedBy:      clip(meta.RequestedBy, 200),
			PerformedBy:      clip(meta.PerformedBy, 200),
			Reason:           clip(meta.Reason, 1000),
			ActorUserID:      meta.ActorUserID,
			IncludedAsLinked: asLinked,
			ClientIP:         clip(meta.ClientIP, 64),
			UserAgent:        clip(meta.UserAgent, 300),
			DeletedAt:        now,
		}
		if !asLinked {
			r.OrphanedCreatorIDs = orphans
		}
		return r
	}

	out := []models.AccountDeletion{row(target, false)}
	for _, u := range extra {
		if u != nil && u.ID != target.ID {
			out = append(out, row(u, true))
		}
	}
	return out
}
