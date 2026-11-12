package services

import (
	"errors"
	"fmt"

	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/validation"
)

// ErrInmateNumberTaken: a creator already exists for this inmate number in
// this state. The person is told to sign in to that account instead.
//
// Nov 6 2026: Voss (voss203) left prison and made a second creator account,
// mr.voss225, with the same number. Anyone already free could do the same and
// enter the contest, which is only for people in prison. David proposed that
// the inmate number identify one creator and Anthony approved it.
var ErrInmateNumberTaken = errors.New("an account with this inmate number already exists, sign in to it instead")

// InmateNumberTakenCode is the machine readable code the app keys its message
// and its sign in button on.
const InmateNumberTakenCode = "INMATE_NUMBER_TAKEN"

// creatorLookup finds the creators whose inmate number normalizes to the given
// value (UserRepository.FindCreatorsByInmateNumber in production).
type creatorLookup func(normalized string) ([]models.User, error)

// conflictingCreator returns the first creator in existing that holds the
// number in a state that can be the same as state, or nil. existing is
// already filtered by number; this decides on the state.
func conflictingCreator(existing []models.User, state string) *models.User {
	for i := range existing {
		if existing[i].Role != models.RoleCreator {
			continue
		}
		if validation.SameInmateState(strVal(existing[i].InmateState), state) {
			return &existing[i]
		}
	}
	return nil
}

// ensureInmateNumberFree answers ErrInmateNumberTaken when a creator already
// holds number (normalized) in state. An empty number is not checked: the own
// account path may skip the inmate step and finish as a standard account.
//
// Only a NEW creator is checked. A representative's own row keeps its
// creator's number and never counts (see FindCreatorsByInmateNumber), and the
// operator relink that gives an existing creator a new representative creates
// no creator, so it never reaches here.
func ensureInmateNumberFree(lookup creatorLookup, number, state string) error {
	normalized := validation.NormalizeInmateNumber(number)
	if normalized == "" {
		return nil
	}
	existing, err := lookup(normalized)
	if err != nil {
		return fmt.Errorf("check inmate number: %w", err)
	}
	if conflictingCreator(existing, state) != nil {
		return ErrInmateNumberTaken
	}
	return nil
}

// draftCreatesCreator says whether completing this draft makes a creator that
// carries the draft's inmate number: an own account that validated an inmate
// (role creator), or a representative, whose signup creates the managed
// creator with that number in the same transaction.
func draftCreatesCreator(d *models.SignupDraft) bool {
	if d.Role == nil || d.InmateNumber == nil {
		return false
	}
	switch models.Role(*d.Role) {
	case models.RoleCreator, models.RoleRepresentative:
		return validation.NormalizeInmateNumber(*d.InmateNumber) != ""
	}
	return false
}
