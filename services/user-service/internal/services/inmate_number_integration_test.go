//go:build integration

package services

// One creator per inmate number and state, against a throwaway Postgres:
//   USER_SERVICE_TEST_DSN="host=/tmp port=55433 user=postgres dbname=atto_users_test sslmode=disable" \
//     go test -tags integration ./internal/services -run IntegrationInmate

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/atto-sound/user-service/internal/config"
	"github.com/atto-sound/user-service/internal/kafka"
	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
)

type inmateFixture struct {
	db      *gorm.DB
	users   *repositories.UserRepository
	signups *repositories.SignupRepository
	svc     *SignupService
	rep     *models.User // representative of the managed creator below
	creator *models.User // managed creator, CT, number stored as "0334 658"
}

func newInmateFixture(t *testing.T) *inmateFixture {
	db := integrationDB(t)
	db.Exec("TRUNCATE signup_sessions, user_credentials RESTART IDENTITY CASCADE")
	f := &inmateFixture{db: db, users: repositories.NewUserRepository(db), signups: repositories.NewSignupRepository(db)}
	jwt := middleware.NewJWTManager(&config.Config{JWTSecret: "test", JWTAccessExpiry: time.Minute, JWTRefreshExpiry: time.Hour})
	f.svc = NewSignupService(f.signups, f.users, jwt, kafka.NewProducer("127.0.0.1:1"), "http://127.0.0.1:1")

	ct := "CT"
	repEmail := "rep@example.com"
	f.rep = &models.User{Username: "hisbeauty", DisplayName: "Rep", Email: &repEmail, Role: models.RoleRepresentative,
		InmateNumber: sp("334658"), InmateState: &ct}
	mustCreate(t, db, f.rep)
	f.creator = &models.User{Username: "herbeast", DisplayName: "Creator", Role: models.RoleCreator, IsManagedAccount: true,
		RepresentativeID: &f.rep.ID, InmateNumber: sp("0334 658"), InmateState: &ct}
	mustCreate(t, db, f.creator)
	mustCreate(t, db, &models.UserCredentials{UserID: f.creator.ID, PasswordHash: "$2a$10$abcdefghijklmnopqrstuuSomethingSomethingSomethingSomethi"})
	// An own account creator stored without a state, like voss203.
	mustCreate(t, db, &models.User{Username: "voss", DisplayName: "Voss", Role: models.RoleCreator, InmateNumber: sp("777001")})
	// A representative whose creator was never created: the number is free for a creator.
	mustCreate(t, db, &models.User{Username: "infra", DisplayName: "Infra", Role: models.RoleRepresentative,
		InmateNumber: sp("555123"), InmateState: &ct})
	return f
}

func mustCreate(t *testing.T, db *gorm.DB, v interface{}) {
	t.Helper()
	if err := db.Create(v).Error; err != nil {
		t.Fatal(err)
	}
}

// verifiedSession stores a session that already passed the OTP, with draft.
func (f *inmateFixture) verifiedSession(t *testing.T, ident string, d models.SignupDraft) uuid.UUID {
	t.Helper()
	s := &models.SignupSession{Identifier: ident, IdentifierType: models.IdentifierEmail, IdentifierVerified: true,
		Status: models.SignupStatusVerified, Draft: d, ExpiresAt: time.Now().Add(time.Hour)}
	if err := f.signups.Create(s); err != nil {
		t.Fatal(err)
	}
	return s.ID
}

func baseDraft(username string) models.SignupDraft {
	hash := "$2a$10$abcdefghijklmnopqrstuuSomethingSomethingSomethingSomethi"
	return models.SignupDraft{DisplayName: sp("Someone"), Username: sp(username), DateOfBirth: sp("1990-01-01"),
		PasswordHash: &hash, Role: sp("listener")}
}

func TestIntegrationInmate_RepositoryNormalizesInSQL(t *testing.T) {
	f := newInmateFixture(t)
	got, err := f.users.FindCreatorsByInmateNumber("334658")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != f.creator.ID {
		t.Fatalf("want only the creator (not its representative), got %+v", got)
	}
	if got, _ := f.users.FindCreatorsByInmateNumber("555123"); len(got) != 0 {
		t.Fatalf("a representative alone is not a creator, got %d rows", len(got))
	}
}

func TestIntegrationInmate_OwnAccountStepRefusedAndNothingSaved(t *testing.T) {
	f := newInmateFixture(t)
	id := f.verifiedSession(t, "own@example.com", baseDraft("newone"))

	_, _, err := f.svc.PatchDraft(context.Background(), id, &models.SignupDraft{Role: sp("creator"), InmateNumber: sp(" 334658 "), InmateState: sp("ct")})
	if !errors.Is(err, ErrInmateNumberTaken) {
		t.Fatalf("want ErrInmateNumberTaken, got %v", err)
	}
	s, _ := f.signups.FindByID(id)
	if s.Draft.InmateNumber != nil || *s.Draft.Role != "listener" {
		t.Fatalf("a refused patch must save nothing, draft is %+v", s.Draft)
	}

	// Voss: no state on either side, same number with a leading zero.
	_, _, err = f.svc.PatchDraft(context.Background(), id, &models.SignupDraft{Role: sp("creator"), InmateNumber: sp("0777001")})
	if !errors.Is(err, ErrInmateNumberTaken) {
		t.Fatalf("Voss case: want ErrInmateNumberTaken, got %v", err)
	}
}

func TestIntegrationInmate_FreeNumberAndOtherStateCompleteAsCreator(t *testing.T) {
	f := newInmateFixture(t)
	for i, tc := range []struct{ number, state string }{{"123123", "CT"}, {"334658", "NY"}, {"555123", "CT"}} {
		ident := []string{"a@example.com", "b@example.com", "c@example.com"}[i]
		id := f.verifiedSession(t, ident, baseDraft([]string{"freeone", "otherstate", "repalone"}[i]))
		if _, _, err := f.svc.PatchDraft(context.Background(), id, &models.SignupDraft{Role: sp("creator"), InmateNumber: sp(tc.number), InmateState: sp(tc.state)}); err != nil {
			t.Fatalf("%s/%s: patch: %v", tc.number, tc.state, err)
		}
		res, err := f.svc.Complete(context.Background(), id)
		if err != nil {
			t.Fatalf("%s/%s: complete: %v", tc.number, tc.state, err)
		}
		if res.User.Role != string(models.RoleCreator) {
			t.Fatalf("%s/%s: want a creator, got %s", tc.number, tc.state, res.User.Role)
		}
	}
}

func TestIntegrationInmate_RepresentativeConsentStepRefused(t *testing.T) {
	f := newInmateFixture(t)
	d := baseDraft("newrep")
	d.Role = sp("representative")
	id := f.verifiedSession(t, "rep2@example.com", d)
	_, _, err := f.svc.PatchDraft(context.Background(), id, &models.SignupDraft{InmateNumber: sp("334658"), InmateState: sp("CT"),
		CreatorName: sp("X"), ConsentToRecording: boolPtr(true)})
	if !errors.Is(err, ErrInmateNumberTaken) {
		t.Fatalf("a representative creating a second creator for the number: want ErrInmateNumberTaken, got %v", err)
	}
}

// A draft saved before the rule (or raced past the step) stops at Complete,
// and no user row lands.
func TestIntegrationInmate_CompleteChecksAgain(t *testing.T) {
	f := newInmateFixture(t)
	d := baseDraft("latecomer")
	d.Role = sp("creator")
	d.InmateNumber = sp("334658")
	d.InmateState = sp("CT")
	id := f.verifiedSession(t, "late@example.com", d)
	if _, err := f.svc.Complete(context.Background(), id); !errors.Is(err, ErrInmateNumberTaken) {
		t.Fatalf("want ErrInmateNumberTaken, got %v", err)
	}
	if u, _ := f.users.FindByUsername("latecomer"); u != nil {
		t.Fatal("no account may be created")
	}
}

// The representative keeps its creator's number on its own row and the
// operator relink gives an orphaned creator a new representative with the
// same number: neither is a second creator, both keep working.
func TestIntegrationInmate_RelinkToExistingCreatorStillWorks(t *testing.T) {
	f := newInmateFixture(t)
	f.db.Unscoped().Delete(&models.User{}, f.rep.ID) // the creator is now an orphan
	us := NewUserService(f.users, kafka.NewProducer("127.0.0.1:1"))
	res, err := us.RelinkOrphanedCreator(context.Background(), RelinkRequest{CreatorID: f.creator.ID, CreatorUsername: "herbeast",
		Email: "newrep@example.com", Username: "newrep", DisplayName: "New Rep", RequestedBy: "test", PerformedBy: "test", Reason: "test"})
	if err != nil {
		t.Fatalf("relink must keep working: %v", err)
	}
	rep, _ := f.users.FindByID(res.RepresentativeID)
	if rep == nil || rep.InmateNumber == nil || *rep.InmateNumber != "0334 658" {
		t.Fatalf("the new representative carries the creator's number, got %+v", rep)
	}
	got, _ := f.users.FindCreatorsByInmateNumber("334658")
	if len(got) != 1 {
		t.Fatalf("still one creator for the number, got %d", len(got))
	}
}

func boolPtr(b bool) *bool { return &b }

// Signing up with a free number and editing it afterwards to a taken one is
// refused; saving the profile with the number unchanged still works, even for
// creators that already share a number.
func TestIntegrationInmate_ProfileEditCannotTakeANumber(t *testing.T) {
	f := newInmateFixture(t)
	ct := "CT"
	other := &models.User{Username: "sneaky", DisplayName: "S", Role: models.RoleCreator, InmateNumber: sp("123123"), InmateState: &ct}
	mustCreate(t, f.db, other)
	us := NewUserService(f.users, kafka.NewProducer("127.0.0.1:1"))
	id := strconv.FormatUint(other.ID, 10)

	if _, err := us.UpdateProfile(context.Background(), id, &models.UpdateProfileRequest{InmateNumber: sp("334658")}); !errors.Is(err, ErrInmateNumberTaken) {
		t.Fatalf("want ErrInmateNumberTaken, got %v", err)
	}
	// The creator that holds the number sends it back unchanged with a new bio.
	bio := "new bio"
	if _, err := us.UpdateProfile(context.Background(), strconv.FormatUint(f.creator.ID, 10),
		&models.UpdateProfileRequest{Bio: &bio, InmateNumber: sp("0334 658"), InmateState: &ct}); err != nil {
		t.Fatalf("unchanged number must save: %v", err)
	}
	// Its representative edits the number on its own row: not a creator, not checked.
	if _, err := us.UpdateProfile(context.Background(), strconv.FormatUint(f.rep.ID, 10),
		&models.UpdateProfileRequest{InmateNumber: sp("777001")}); err != nil {
		t.Fatalf("a representative's own row is not checked: %v", err)
	}
}
