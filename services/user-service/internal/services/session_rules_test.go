package services

// Where remembered devices meet the deletion grace (Nov 13 2026, when the
// two branches were joined for the deploy). Without a database: the rules
// that need one live in session_close_integration_test.go.

import (
	"context"
	"testing"
	"time"

	"github.com/atto-sound/user-service/internal/config"
	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
)

func rulesAuth() (*AuthService, *middleware.JWTManager) {
	mgr := middleware.NewJWTManager(&config.Config{
		JWTSecret: "session-rules-secret", JWTAccessExpiry: 15 * time.Minute, JWTRefreshExpiry: time.Hour,
	})
	return &AuthService{jwtMgr: mgr}, mgr
}

func inGrace(id uint64, name string) (*models.User, time.Time) {
	at := time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC)
	sched := at.Add(30 * 24 * time.Hour)
	return &models.User{ID: id, Username: name, DeactivatedAt: &at, ScheduledDeletionAt: &sched}, sched
}

// IssueSession (the device key login) goes through sessionFor: an account in
// its grace gets the recover screen and a recovery token, never a session.
func TestIssueSessionFollowsTheDeletionGrace(t *testing.T) {
	auth, mgr := rulesAuth()

	res, err := auth.IssueSession(&models.User{ID: 281, Username: "westcol"})
	if err != nil || res == nil || res.Tokens == nil || res.Tokens.AccessToken == "" {
		t.Fatalf("live account: %+v, %v", res, err)
	}

	gone, sched := inGrace(281, "westcol")
	res, err = auth.IssueSession(gone)
	if res != nil {
		t.Fatalf("an account in its grace got a session: %+v", res)
	}
	pending, ok := IsAccountPendingDeletion(err)
	if !ok || pending.UserID != 281 || !pending.ScheduledDeletionAt.Equal(sched) {
		t.Fatalf("want the pending deletion answer, got %v", err)
	}
	uid, err := mgr.ValidateRecoveryToken(pending.RecoveryToken)
	if err != nil || uid != 281 {
		t.Fatalf("recovery token: uid %d, %v", uid, err)
	}
	// The recovery token is not a session anywhere.
	claims, err := mgr.ValidateToken(pending.RecoveryToken)
	if err != nil || middleware.IsSessionToken(claims) {
		t.Fatalf("recovery token taken for a session: %v", err)
	}
}

// POST /auth/login/device with a key still alive on an account in its grace
// answers like the password login (the handler turns this error into the
// same 403, see handlers.TestDeviceLoginAnswersTheGraceLikeTheLogin).
func TestDeviceLoginOfAnAccountInGraceGivesNoSession(t *testing.T) {
	auth, _ := rulesAuth()
	user := &models.User{ID: 281, Username: "westcol"}
	store := newMemKeys()
	svc := NewDeviceKeyService(store, memUsers{281: user}, auth.IssueSession)
	now := time.Date(2026, 11, 12, 16, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }

	p := newPhoneKey(t)
	enrolled, err := svc.Enroll(context.Background(), 281, now, &models.EnrollDeviceKeyRequest{
		PublicKey: p.spki, InstallationID: "install-iphone", Platform: "ios"})
	if err != nil {
		t.Fatalf("enroll: %v", err)
	}
	// The deletion request revokes the keys; this forces a key still alive
	// (defense in depth, the same case as the integration test).
	gone, _ := inGrace(281, "westcol")
	*user = *gone
	ch, err := svc.Challenge(context.Background(), enrolled.CredentialID)
	if err != nil {
		t.Fatal(err)
	}
	res, err := svc.Login(context.Background(), &models.DeviceLoginRequest{
		CredentialID: enrolled.CredentialID, Challenge: ch.Challenge,
		Signature: p.sign(t, enrolled.CredentialID, ch.Challenge)})
	if res != nil {
		t.Fatalf("device login opened a session in the grace: %+v", res)
	}
	if pending, ok := IsAccountPendingDeletion(err); !ok || pending.RecoveryToken == "" {
		t.Fatalf("want the pending deletion answer, got %v", err)
	}
}

type spyRevoker struct{ calls []string }

func (s *spyRevoker) RevokeAllForUser(uid uint64, reason string) {
	s.calls = append(s.calls, reason)
}

// The hook password reset and 2FA use reaches the device keys service.
func TestRevokeDeviceKeysReachesTheService(t *testing.T) {
	auth, _ := rulesAuth()
	auth.revokeDeviceKeys(281, models.DeviceKeyRevokedTwoFactor) // nil: no panic
	spy := &spyRevoker{}
	auth.SetDeviceKeys(spy)
	auth.revokeDeviceKeys(281, models.DeviceKeyRevokedTwoFactor)
	if len(spy.calls) != 1 || spy.calls[0] != models.DeviceKeyRevokedTwoFactor {
		t.Fatalf("revoker calls: %v", spy.calls)
	}
}
