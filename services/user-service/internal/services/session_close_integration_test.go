//go:build integration

package services

// Closing every session (Nov 12 2026, approved by David): a password reset
// signs the account out of every phone and ends its remembered devices; the
// phone that reset stays in with a fresh session. Also the deletion grace
// meets remembered devices. Against a throwaway Postgres:
//   USER_SERVICE_TEST_DSN="host=127.0.0.1 port=55437 user=postgres dbname=atto_users_test sslmode=disable" \
//     go test -tags integration ./internal/services -run IntegrationSessionClose

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/atto-sound/user-service/internal/kafka"
	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
)

// sessionToken signs a session token the way GenerateTokenPair does, with a
// chosen iat and exp, so "a phone signed in a minute ago" can be built.
func sessionToken(t *testing.T, uid uint64, iat, exp time.Time) string {
	t.Helper()
	id := strconv.FormatUint(uid, 10)
	c := middleware.JWTClaims{
		UserID: id,
		Scope:  middleware.ScopeUser,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject: id, Issuer: "atto-sound-user-service",
			IssuedAt: jwt.NewNumericDate(iat), ExpiresAt: jwt.NewNumericDate(exp),
		},
	}
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte("test-secret"))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

type closeRig struct {
	*graceRig
	auth *AuthService
	keys *DeviceKeyService
	repo *repositories.DeviceKeyRepository
}

func newCloseRig(t *testing.T) *closeRig {
	g := newGraceRig(t)
	g.db.Exec("TRUNCATE device_keys")
	// The OTP service says yes to any code: the reset itself is what is tested.
	otp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	t.Cleanup(otp.Close)
	userRepo := repositories.NewUserRepository(g.db)
	auth := NewAuthService(userRepo, g.jwt, kafka.NewProducer("127.0.0.1:1"), otp.URL)
	auth.SetAccounts(g.users)
	keyRepo := repositories.NewDeviceKeyRepository(g.db)
	keys := NewDeviceKeyService(keyRepo, userRepo, auth.IssueSession)
	auth.SetDeviceKeys(keys)
	return &closeRig{graceRig: g, auth: auth, keys: keys, repo: keyRepo}
}

func (r *closeRig) enroll(t *testing.T, uid uint64, iat time.Time, install string) (phoneKey, string) {
	t.Helper()
	p := newPhoneKey(t)
	res, err := r.keys.Enroll(context.Background(), uid, iat, &models.EnrollDeviceKeyRequest{
		PublicKey: p.spki, InstallationID: install, Platform: "ios"})
	if err != nil {
		t.Fatalf("enroll: %v", err)
	}
	return p, res.CredentialID
}

func (r *closeRig) continueWith(t *testing.T, p phoneKey, cred string) (*models.AuthResponse, error) {
	t.Helper()
	ch, err := r.keys.Challenge(context.Background(), cred)
	if err != nil {
		return nil, err
	}
	return r.keys.Login(context.Background(), &models.DeviceLoginRequest{
		CredentialID: cred, Challenge: ch.Challenge, Signature: p.sign(t, cred, ch.Challenge)})
}

func TestIntegrationSessionCloseOnPasswordReset(t *testing.T) {
	r := newCloseRig(t)
	rep, creator := r.seedWithPassword(t)
	ctx := context.Background()
	now := time.Now()

	// Two phones signed in a minute ago, one with a remembered device.
	iphoneRefresh := sessionToken(t, rep.ID, now.Add(-time.Minute), now.Add(7*24*time.Hour))
	samsungAccess := sessionToken(t, rep.ID, now.Add(-time.Minute), now.Add(14*time.Minute))
	samsungExpired := sessionToken(t, rep.ID, now.Add(-time.Hour), now.Add(-45*time.Minute))
	key, cred := r.enroll(t, rep.ID, now.Add(-time.Minute), "install-samsung")
	// The creator is another account: untouched by the representative's reset.
	creatorRefresh := sessionToken(t, creator.ID, now.Add(-time.Minute), now.Add(7*24*time.Hour))

	session, err := r.auth.ResetPassword(ctx, &models.ResetPasswordRequest{
		Identifier: "stephanie@example.com", OTP: "123456", Password: "otra-contrasena-larga"})
	if err != nil {
		t.Fatalf("reset: %v", err)
	}
	// The phone that reset stays in, with a session issued after the cut.
	if session == nil || session.Tokens == nil || session.User.ID != rep.ID {
		t.Fatalf("no fresh session for the phone that reset: %+v", session)
	}
	if _, err := r.auth.RefreshToken(ctx, session.Tokens.RefreshToken); err != nil {
		t.Fatalf("the fresh session does not refresh: %v", err)
	}
	if c := r.auth.CheckSession(session.Tokens.AccessToken, time.Now()); !c.Valid {
		t.Fatalf("fresh session not valid for telephony: %+v", c)
	}

	// Every other session of the account is closed.
	if _, err := r.auth.RefreshToken(ctx, iphoneRefresh); err == nil || err.Error() != "session revoked" {
		t.Fatalf("old refresh still renews: %v", err)
	}
	for name, tok := range map[string]string{"unexpired access": samsungAccess, "expired (VoIP grace)": samsungExpired} {
		if c := r.auth.CheckSession(tok, time.Now()); c.Valid || c.Reason != "session_revoked" {
			t.Fatalf("%s after reset: %+v", name, c)
		}
	}
	// Its remembered device too, with the reason the phone shows.
	_, err = r.continueWith(t, key, cred)
	wantCode(t, err, DeviceErrRevoked, models.DeviceKeyRevokedPassword)
	// An access token from before the reset cannot enroll a new key either:
	// that would turn its last minutes into 180 days.
	_, err = r.keys.Enroll(ctx, rep.ID, now.Add(-time.Minute), &models.EnrollDeviceKeyRequest{
		PublicKey: newPhoneKey(t).spki, InstallationID: "install-thief", Platform: "android"})
	wantCode(t, err, DeviceErrSessionClosed, "")
	// The fresh session can.
	fresh, _ := r.jwt.ValidateToken(session.Tokens.AccessToken)
	if _, err := r.keys.Enroll(ctx, rep.ID, fresh.IssuedAt.Time, &models.EnrollDeviceKeyRequest{
		PublicKey: newPhoneKey(t).spki, InstallationID: "install-iphone", Platform: "ios"}); err != nil {
		t.Fatalf("fresh session cannot enroll: %v", err)
	}
	// Routes that mint tokens (switch-account, also to itself) refuse the
	// old session even while its access token has minutes left.
	oldClaims, err := r.jwt.ValidateToken(samsungAccess)
	if err != nil {
		t.Fatal(err)
	}
	if r.auth.SessionStillOpen(oldClaims) {
		t.Fatal("an access token from before the reset can still mint tokens")
	}
	if !r.auth.SessionStillOpen(fresh) {
		t.Fatal("the fresh session cannot switch accounts")
	}
	// The new password works, the old one does not.
	if _, err := r.auth.Login(ctx, &models.LoginRequest{Identifier: "stephanie@example.com", Password: "otra-contrasena-larga"}); err != nil {
		t.Fatalf("new password: %v", err)
	}
	if _, err := r.auth.Login(ctx, &models.LoginRequest{Identifier: "stephanie@example.com", Password: "contrasena-larga"}); err == nil {
		t.Fatal("old password still works")
	}
	// Another account is not touched.
	if _, err := r.auth.RefreshToken(ctx, creatorRefresh); err != nil {
		t.Fatalf("the creator's session was closed by the representative's reset: %v", err)
	}
}

func TestIntegrationSessionCloseResetWithTwoFactorGivesNoSession(t *testing.T) {
	r := newCloseRig(t)
	rep, _ := r.seedWithPassword(t)
	r.db.Model(&models.UserCredentials{}).Where("user_id = ?", rep.ID).
		Updates(map[string]interface{}{"two_factor_enabled": true, "two_factor_method": "sms"})
	session, err := r.auth.ResetPassword(context.Background(), &models.ResetPasswordRequest{
		Identifier: "stephanie@example.com", OTP: "123456", Password: "otra-contrasena-larga"})
	if err != nil {
		t.Fatalf("reset: %v", err)
	}
	// The reset code proves the email, not the second factor: the login asks it.
	if session != nil {
		t.Fatalf("a session skipped the 2FA after a reset: %+v", session)
	}
	if u := r.reload(t, rep.ID); u.SessionsValidAfter == nil {
		t.Fatal("sessions were not closed")
	}
}

func TestIntegrationSessionCloseDeletionRequestEndsRememberedDevices(t *testing.T) {
	r := newCloseRig(t)
	rep, _ := r.seedWithPassword(t)
	ctx := context.Background()
	key, cred := r.enroll(t, rep.ID, time.Now().Add(-time.Minute), "install-iphone")

	if _, err := r.users.RequestDeletion(ctx, rep.ID, false, selfDelete(rep), "es"); err != nil {
		t.Fatalf("request deletion: %v", err)
	}
	_, err := r.continueWith(t, key, cred)
	wantCode(t, err, DeviceErrRevoked, models.DeviceKeyRevokedDeactivated)

	// Recovering the account does not bring the key back.
	if _, _, err := r.users.RecoverAccount(ctx, rep.ID, "test"); err != nil {
		t.Fatalf("recover: %v", err)
	}
	_, err = r.continueWith(t, key, cred)
	wantCode(t, err, DeviceErrRevoked, models.DeviceKeyRevokedDeactivated)
}

func TestIntegrationSessionCloseDeviceLoginAnswersTheGraceLikeTheLogin(t *testing.T) {
	r := newCloseRig(t)
	rep, _ := r.seedWithPassword(t)
	key, cred := r.enroll(t, rep.ID, time.Now().Add(-time.Minute), "install-iphone")
	// Defense in depth: a key still alive on an account in its grace (the
	// deactivation revokes them, this forces the case) gets the recover
	// screen, never a session.
	at := time.Now().UTC()
	r.db.Model(&models.User{}).Where("id = ?", rep.ID).
		Updates(map[string]interface{}{"deactivated_at": at, "scheduled_deletion_at": at.Add(30 * 24 * time.Hour)})
	_, err := r.continueWith(t, key, cred)
	pending, ok := IsAccountPendingDeletion(err)
	if !ok || pending.RecoveryToken == "" || pending.UserID != rep.ID {
		t.Fatalf("device login of an account in grace: %v", err)
	}
}

func TestIntegrationSessionCheckRefusesWhatIsNotAnOpenSession(t *testing.T) {
	r := newCloseRig(t)
	rep, _ := r.seedWithPassword(t)
	now := time.Now()
	twoFA, _ := r.jwt.Generate2FAToken(rep.ID)
	cases := map[string]struct {
		token  string
		valid  bool
		reason string
	}{
		"expired an hour ago, still open": {sessionToken(t, rep.ID, now.Add(-2*time.Hour), now.Add(-time.Hour)), true, ""},
		"past the 30 day grace":           {sessionToken(t, rep.ID, now.Add(-40*24*time.Hour), now.Add(-31*24*time.Hour)), false, "too_old"},
		"2FA temporary token":             {twoFA, false, "not_a_session"},
		"not ours":                        {"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.bad", false, "invalid_token"},
		"unknown account":                 {sessionToken(t, 999999, now.Add(-time.Minute), now.Add(time.Minute)), false, "user_not_found"},
	}
	for name, c := range cases {
		got := r.auth.CheckSession(c.token, now)
		if got.Valid != c.valid || got.Reason != c.reason {
			t.Fatalf("%s: %+v", name, got)
		}
	}
}

func TestIntegrationSessionCloseTwoFactorOnEndsRememberedDevices(t *testing.T) {
	r := newCloseRig(t)
	rep, creator := r.seedWithPassword(t)
	key, cred := r.enroll(t, rep.ID, time.Now().Add(-time.Minute), "install-iphone")
	otherKey, otherCred := r.enroll(t, creator.ID, time.Now().Add(-time.Minute), "install-samsung")

	// Keys made before 2FA was on never passed the second factor.
	if err := r.auth.Enable2FAConfirm(context.Background(), strconv.FormatUint(rep.ID, 10),
		&models.Verify2FASetupRequest{Code: "123456", Method: "email"}); err != nil {
		t.Fatalf("enable 2FA: %v", err)
	}
	_, err := r.continueWith(t, key, cred)
	wantCode(t, err, DeviceErrRevoked, models.DeviceKeyRevokedTwoFactor)
	// Another account keeps its key.
	if _, err := r.continueWith(t, otherKey, otherCred); err != nil {
		t.Fatalf("another account's key died too: %v", err)
	}
}
