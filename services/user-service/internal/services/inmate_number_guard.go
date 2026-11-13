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

// conflictingCreator returns the first creator in existing, other than the
// user excludeID (0 for none), that holds the number in a state that can be
// the same as state, or nil. existing is already filtered by number; this
// decides on the state.
func conflictingCreator(existing []models.User, state string, excludeID uint64) *models.User {
	for i := range existing {
		if existing[i].Role != models.RoleCreator || (excludeID != 0 && existing[i].ID == excludeID) {
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
	return ensureInmateNumberFreeFor(lookup, number, state, 0)
}

// ensureInmateNumberFreeFor is ensureInmateNumberFree for an existing creator
// changing its own number: its own row (excludeID) does not count.
func ensureInmateNumberFreeFor(lookup creatorLookup, number, state string, excludeID uint64) error {
	normalized := validation.NormalizeInmateNumber(number)
	if normalized == "" {
		return nil
	}
	existing, err := lookup(normalized)
	if err != nil {
		return fmt.Errorf("check inmate number: %w", err)
	}
	if conflictingCreator(existing, state, excludeID) != nil {
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

// inmateIdentityChanged says whether a profile edit really moves a creator to
// another inmate number or state. Only then is the number checked again: the
// edit screens send the fields back unchanged, and the creators that already
// share a number in production must still be able to save their profile.
func inmateIdentityChanged(current *models.User, number, state *string) bool {
	if number != nil && validation.NormalizeInmateNumber(*number) != validation.NormalizeInmateNumber(strVal(current.InmateNumber)) {
		return true
	}
	if state != nil && validation.NormalizeInmateState(*state) != validation.NormalizeInmateState(strVal(current.InmateState)) {
		return true
	}
	return false
}
