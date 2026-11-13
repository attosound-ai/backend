package services

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/atto-sound/user-service/internal/models"
)

var selfMeta = DeletionMeta{
	Via:         models.DeletionViaSelfService,
	RequestedBy: "westcol (281), from the app with an OTP",
	PerformedBy: "westcol (281)",
	Reason:      "me voy",
	ActorUserID: u64(281),
	ClientIP:    "10.0.0.1",
}

func TestGraceRequestsScheduleThirtyDaysForEveryAccount(t *testing.T) {
	at := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)
	reqs := BuildGraceRequests("b1", rep, []*models.User{creator}, selfMeta, true, "es", at, models.DefaultDeletionGrace)
	if len(reqs) != 2 {
		t.Fatalf("requests = %d, want 2", len(reqs))
	}
	want := time.Date(2026, 12, 12, 10, 0, 0, 0, time.UTC)
	for _, r := range reqs {
		if !r.ScheduledFor.Equal(want) || !r.RequestedAt.Equal(at) || r.Status != models.DeletionRequestPending || r.BatchID != "b1" {
			t.Fatalf("bad schedule: %+v", r)
		}
		if r.RequestedBy != selfMeta.RequestedBy || r.Via != "self_service" || r.Locale != "es" {
			t.Fatalf("meta lost: %+v", r)
		}
	}
	if reqs[0].UserID != 266 || reqs[0].IncludedAsLinked || !reqs[0].DeleteLinked {
		t.Fatalf("root row wrong: %+v", reqs[0])
	}
	if reqs[1].UserID != 267 || !reqs[1].IncludedAsLinked || reqs[1].DeleteLinked {
		t.Fatalf("linked row wrong: %+v", reqs[1])
	}
}

func TestGraceRequestsKeepAnotherPendingLinkedDate(t *testing.T) {
	when := time.Now()
	pending := &models.User{ID: 300, Username: "ya_en_gracia", DeactivatedAt: &when}
	reqs := BuildGraceRequests("b2", rep, []*models.User{pending, rep, nil}, selfMeta, true, "en", when, time.Hour)
	if len(reqs) != 1 || reqs[0].UserID != 266 {
		t.Fatalf("an already pending linked account or the target twice got in: %+v", reqs)
	}
}

func TestGraceRequestsNilTarget(t *testing.T) {
	if got := BuildGraceRequests("b", nil, nil, selfMeta, false, "", now, time.Hour); got != nil {
		t.Fatalf("want nil, got %+v", got)
	}
}

func TestRecoveryScope(t *testing.T) {
	batch := []models.AccountDeletionRequest{
		{UserID: 266, IncludedAsLinked: false},
		{UserID: 267, IncludedAsLinked: true},
	}
	if got := RecoveryScope(266, batch); len(got) != 2 {
		t.Fatalf("the account that asked must bring its whole batch back, got %v", got)
	}
	if got := RecoveryScope(267, batch); len(got) != 1 || got[0] != 267 {
		t.Fatalf("a linked account comes back alone, got %v", got)
	}
	if got := RecoveryScope(999, batch); got != nil {
		t.Fatalf("outsider must recover nothing, got %v", got)
	}
}

func TestScheduledDeletionMetaKeepsWhoAsked(t *testing.T) {
	m := ScheduledDeletionMeta(models.AccountDeletionRequest{
		Via: "self_service", RequestedBy: "westcol (281), from the app with an OTP", Reason: "me voy", ActorUserID: u64(281),
	})
	if m.RequestedBy != "westcol (281), from the app with an OTP" || m.PerformedBy != ScheduledDeletionPerformer ||
		m.Via != "self_service" || m.Reason != "me voy" || m.ActorUserID == nil || *m.ActorUserID != 281 {
		t.Fatalf("meta wrong: %+v", m)
	}
	if err := m.Validate(); err != nil {
		t.Fatalf("scheduled meta must pass the same validation as any deletion: %v", err)
	}
}

func TestSessionRevoked(t *testing.T) {
	cut := time.Date(2026, 11, 12, 10, 0, 0, 500_000_000, time.UTC)
	before := jwt.NewNumericDate(cut.Add(-time.Hour))
	sameSecond := jwt.NewNumericDate(cut.Truncate(time.Second))
	after := jwt.NewNumericDate(cut.Add(2 * time.Second))
	if !sessionRevoked(before, &cut) || !sessionRevoked(sameSecond, &cut) {
		t.Fatal("tokens issued before or in the same second as the cut must be revoked")
	}
	if sessionRevoked(after, &cut) {
		t.Fatal("a token issued after the cut is valid")
	}
	if sessionRevoked(before, nil) {
		t.Fatal("no cut, no revocation")
	}
	if !sessionRevoked(nil, &cut) {
		t.Fatal("a token without iat cannot prove it is newer")
	}
}

func TestNotifiableEmail(t *testing.T) {
	real := "stephanie@example.com"
	internal := "creator_334658_266@managed.atto"
	blank := " "
	cases := map[*models.User]string{
		{Email: &real}:     real,
		{Email: &internal}: "",
		{Email: &blank}:    "",
		{}:                 "",
	}
	for u, want := range cases {
		if got := notifiableEmail(u); got != want {
			t.Fatalf("notifiableEmail(%v) = %q, want %q", u.Email, got, want)
		}
	}
	if notifiableEmail(nil) != "" {
		t.Fatal("nil user")
	}
}

func TestPendingDeletionErrorIsDetectable(t *testing.T) {
	var err error = &ErrAccountPendingDeletion{UserID: 1}
	if e, ok := IsAccountPendingDeletion(err); !ok || e.UserID != 1 || err.Error() != AccountPendingDeletionCode {
		t.Fatal("pending deletion error not detected")
	}
	if _, ok := IsAccountPendingDeletion(ErrDeletionMetaIncomplete); ok {
		t.Fatal("other errors are not pending deletions")
	}
}
