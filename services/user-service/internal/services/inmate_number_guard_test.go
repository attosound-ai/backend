package services

import (
	"errors"
	"testing"

	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/validation"
)

// fakeUsers stands in for the users table: the lookup filters by normalized
// number the way UserRepository.FindCreatorsByInmateNumber does in SQL,
// creators only.
func fakeUsers(users ...models.User) creatorLookup {
	return func(normalized string) ([]models.User, error) {
		var out []models.User
		for _, u := range users {
			if u.Role != models.RoleCreator || u.InmateNumber == nil {
				continue
			}
			if validation.NormalizeInmateNumber(*u.InmateNumber) == normalized {
				out = append(out, u)
			}
		}
		return out, nil
	}
}

func sp(s string) *string { return &s }

func creatorWith(id uint64, number string, state *string) models.User {
	return models.User{ID: id, Role: models.RoleCreator, InmateNumber: sp(number), InmateState: state}
}

func repWith(id uint64, number string, state *string) models.User {
	return models.User{ID: id, Role: models.RoleRepresentative, InmateNumber: sp(number), InmateState: state}
}

func TestEnsureInmateNumberFree(t *testing.T) {
	ct := sp("CT")
	db := fakeUsers(
		creatorWith(254, "334658", ct),  // managed creator in CT
		repWith(253, "334658", ct),      // its representative keeps the same number
		creatorWith(265, "777001", nil), // own account creator stored without a state (voss203)
		repWith(205, "555123", ct),      // representative whose creator was never created
	)

	cases := []struct {
		name   string
		number string
		state  string
		taken  bool
	}{
		{"new creator, free number", "123123", "CT", false},
		{"same number, same state", "334658", "CT", true},
		{"same number written with spaces, zeros and lower case state", " 0334 658 ", "ct", true},
		{"same number, another state", "334658", "NY", false},
		{"same number, no state given", "334658", "", true},
		{"existing creator has no state: blocks any state", "777001", "CT", true},
		{"second own account with the same number and no state (Voss)", "0777001", "", true},
		{"only a representative holds the number: not a creator, free", "555123", "CT", false},
		{"empty number is never checked", "", "CT", false},
		{"blank number is never checked", "  ", "CT", false},
	}
	for _, tc := range cases {
		err := ensureInmateNumberFree(db, tc.number, tc.state)
		if tc.taken && !errors.Is(err, ErrInmateNumberTaken) {
			t.Errorf("%s: want ErrInmateNumberTaken, got %v", tc.name, err)
		}
		if !tc.taken && err != nil {
			t.Errorf("%s: want nil, got %v", tc.name, err)
		}
	}
}

func TestEnsureInmateNumberFree_LookupFailureIsNotATakenNumber(t *testing.T) {
	boom := errors.New("pq: connection reset")
	err := ensureInmateNumberFree(func(string) ([]models.User, error) { return nil, boom }, "334658", "CT")
	if !errors.Is(err, boom) {
		t.Fatalf("the database error must come through, got %v", err)
	}
	if errors.Is(err, ErrInmateNumberTaken) {
		t.Fatal("a failed lookup must not tell the person the number is taken")
	}
}

func TestEnsureInmateNumberFree_LookupGetsTheNormalizedNumber(t *testing.T) {
	var got string
	_ = ensureInmateNumberFree(func(n string) ([]models.User, error) { got = n; return nil, nil }, " 00a12 345", "CT")
	if got != "A12345" {
		t.Fatalf("lookup received %q, want A12345", got)
	}
}

func TestConflictingCreator_IgnoresNonCreators(t *testing.T) {
	rows := []models.User{repWith(1, "1", sp("CT")), {ID: 2, Role: models.RoleListener, InmateNumber: sp("1")}}
	if c := conflictingCreator(rows, "CT", 0); c != nil {
		t.Fatalf("only creators count, got user %d", c.ID)
	}
	rows = append(rows, creatorWith(3, "1", sp("CT")))
	if c := conflictingCreator(rows, "CT", 0); c == nil || c.ID != 3 {
		t.Fatalf("want creator 3, got %+v", c)
	}
}

func TestDraftCreatesCreator(t *testing.T) {
	cases := []struct {
		name string
		d    models.SignupDraft
		want bool
	}{
		{"own account that validated an inmate", models.SignupDraft{Role: sp("creator"), InmateNumber: sp("334658")}, true},
		{"representative with its creator's number", models.SignupDraft{Role: sp("representative"), InmateNumber: sp("334658")}, true},
		{"standard account", models.SignupDraft{Role: sp("listener"), InmateNumber: sp("334658")}, false},
		{"creator role without a number yet", models.SignupDraft{Role: sp("creator")}, false},
		{"blank number", models.SignupDraft{Role: sp("creator"), InmateNumber: sp(" 0 ")}, false},
		{"no role yet", models.SignupDraft{InmateNumber: sp("334658")}, false},
	}
	for _, tc := range cases {
		if got := draftCreatesCreator(&tc.d); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

// An existing creator changing its own number: its own row never blocks it,
// another creator with the number does.
func TestEnsureInmateNumberFreeFor_OwnRowDoesNotCount(t *testing.T) {
	ct := sp("CT")
	db := fakeUsers(creatorWith(10, "334658", ct), creatorWith(11, "999000", ct))
	if err := ensureInmateNumberFreeFor(db, "0334658", "CT", 10); err != nil {
		t.Fatalf("creator 10 rewriting its own number: want nil, got %v", err)
	}
	if err := ensureInmateNumberFreeFor(db, "334658", "CT", 11); !errors.Is(err, ErrInmateNumberTaken) {
		t.Fatalf("creator 11 taking creator 10's number: want ErrInmateNumberTaken, got %v", err)
	}
}

func TestInmateIdentityChanged(t *testing.T) {
	cur := &models.User{InmateNumber: sp("334658"), InmateState: sp("CT")}
	cases := []struct {
		name          string
		number, state *string
		want          bool
	}{
		{"nothing sent", nil, nil, false},
		{"same number sent back", sp("334658"), nil, false},
		{"same number written differently", sp(" 0334 658"), sp("ct"), false},
		{"another number", sp("334659"), nil, true},
		{"another state", nil, sp("NY"), true},
		{"number cleared", sp(""), nil, true},
	}
	for _, tc := range cases {
		if got := inmateIdentityChanged(cur, tc.number, tc.state); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}
