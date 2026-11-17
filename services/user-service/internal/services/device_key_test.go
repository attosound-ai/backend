package services

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/atto-sound/user-service/internal/models"
)

// ── in memory store ──

type memKeys struct {
	mu   sync.Mutex
	rows map[uuid.UUID]*models.DeviceKey
}

func newMemKeys() *memKeys { return &memKeys{rows: map[uuid.UUID]*models.DeviceKey{}} }

func (m *memKeys) Create(k *models.DeviceKey) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.rows {
		if r.KeyHash == k.KeyHash {
			return errors.New("duplicate key_hash")
		}
	}
	c := *k
	m.rows[k.ID] = &c
	return nil
}

func (m *memKeys) FindByID(id uuid.UUID) (*models.DeviceKey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.rows[id]; ok {
		c := *r
		return &c, nil
	}
	return nil, nil
}

func (m *memKeys) FindByKeyHash(h string) (*models.DeviceKey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.rows {
		if r.KeyHash == h {
			c := *r
			return &c, nil
		}
	}
	return nil, nil
}

func (m *memKeys) ListLive(uid uint64) ([]models.DeviceKey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []models.DeviceKey
	for _, r := range m.rows {
		if r.UserID == uid && r.RevokedAt == nil {
			out = append(out, *r)
		}
	}
	return out, nil
}

func (m *memKeys) SetChallenge(id uuid.UUID, h string, exp time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.rows[id]; ok && r.RevokedAt == nil {
		r.ChallengeHash, r.ChallengeExpiresAt = h, &exp
	}
	return nil
}

func (m *memKeys) ConsumeChallenge(id uuid.UUID, h string, now time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok || r.RevokedAt != nil || r.ChallengeHash == "" || r.ChallengeHash != h ||
		r.ChallengeExpiresAt == nil || !r.ChallengeExpiresAt.After(now) {
		return false, nil
	}
	r.ChallengeHash, r.ChallengeExpiresAt = "", nil
	return true, nil
}

func (m *memKeys) MarkUsed(id uuid.UUID, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.rows[id]; ok {
		r.LastUsedAt, r.BadSignatures = &at, 0
	}
	return nil
}

func (m *memKeys) AddBadSignature(id uuid.UUID) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rows[id]
	r.BadSignatures++
	return r.BadSignatures, nil
}

func (m *memKeys) Revoke(id uuid.UUID, reason string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.rows[id]; ok && r.RevokedAt == nil {
		r.RevokedAt, r.RevokedReason = &at, reason
		r.ChallengeHash, r.ChallengeExpiresAt = "", nil
	}
	return nil
}

func (m *memKeys) RevokeAllForUser(uid uint64, reason string, at time.Time) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for _, r := range m.rows {
		if r.UserID == uid && r.RevokedAt == nil {
			r.RevokedAt, r.RevokedReason = &at, reason
			n++
		}
	}
	return n, nil
}

type memUsers map[uint64]*models.User

func (u memUsers) FindByID(id uint64) (*models.User, error) { return u[id], nil }

// ── helpers: a "phone" holding a P-256 key ──

type phoneKey struct {
	priv *ecdsa.PrivateKey
	spki string
}

func newPhoneKey(t *testing.T) phoneKey {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return phoneKey{priv: priv, spki: base64.StdEncoding.EncodeToString(der)}
}

func (p phoneKey) sign(t *testing.T, credID, challenge string) string {
	t.Helper()
	d := sha256.Sum256(DeviceLoginMessage(credID, challenge))
	sig, err := ecdsa.SignASN1(rand.Reader, p.priv, d[:])
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(sig)
}

type fixture struct {
	svc    *DeviceKeyService
	store  *memKeys
	now    time.Time
	issued []uint64
}

func newFixture() *fixture {
	f := &fixture{store: newMemKeys(), now: time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC)}
	users := memUsers{281: {ID: 281, Username: "westcol"}, 280: {ID: 280, Username: "david.espejo"}}
	f.svc = NewDeviceKeyService(f.store, users, func(u *models.User) (*models.AuthResponse, error) {
		f.issued = append(f.issued, u.ID)
		return &models.AuthResponse{User: u.ToProfile(), Tokens: &models.TokenPair{AccessToken: "a", RefreshToken: "r"}}, nil
	})
	f.svc.now = func() time.Time { return f.now }
	return f
}

func (f *fixture) enroll(t *testing.T, uid uint64, p phoneKey, install string) string {
	t.Helper()
	res, err := f.svc.Enroll(context.Background(), uid, f.now, &models.EnrollDeviceKeyRequest{
		PublicKey: p.spki, InstallationID: install, Platform: "ios", DeviceName: "iPhone", Biometric: true,
	})
	if err != nil {
		t.Fatalf("enroll: %v", err)
	}
	return res.CredentialID
}

func (f *fixture) login(t *testing.T, p phoneKey, cred string) (*models.AuthResponse, error) {
	t.Helper()
	ch, err := f.svc.Challenge(context.Background(), cred)
	if err != nil {
		return nil, err
	}
	return f.svc.Login(context.Background(), &models.DeviceLoginRequest{
		CredentialID: cred, Challenge: ch.Challenge, Signature: p.sign(t, cred, ch.Challenge),
	})
}

func wantCode(t *testing.T, err error, code, reason string) {
	t.Helper()
	de, ok := AsDeviceKeyError(err)
	if !ok {
		t.Fatalf("want %s, got %v", code, err)
	}
	if de.Code != code || (reason != "" && de.Reason != reason) {
		t.Fatalf("want %s/%s, got %s/%s", code, reason, de.Code, de.Reason)
	}
}

// ── tests ──

func TestSignedMessageMatchesTheApp(t *testing.T) {
	// The same vector is in the app's test (rememberedAccountsModel.test.ts).
	got := string(DeviceLoginMessage("6f1c2b8e-0000-4000-8000-000000000001", "Y2hhbGxlbmdl"))
	want := "atto.device-login.v1|6f1c2b8e-0000-4000-8000-000000000001|Y2hhbGxlbmdl"
	if got != want {
		t.Fatalf("message %q, want %q", got, want)
	}
	sum := sha256.Sum256([]byte(want))
	if hex.EncodeToString(sum[:]) == "" {
		t.Fatal("digest")
	}
}

func TestParseDevicePublicKey(t *testing.T) {
	p := newPhoneKey(t)
	if _, _, err := ParseDevicePublicKey(p.spki); err != nil {
		t.Fatalf("standard base64: %v", err)
	}
	der, _ := base64.StdEncoding.DecodeString(p.spki)
	if _, _, err := ParseDevicePublicKey(base64.RawURLEncoding.EncodeToString(der)); err != nil {
		t.Fatalf("url base64: %v", err)
	}
	// P-384 and RSA are refused: the phones make P-256 only.
	k384, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	d384, _ := x509.MarshalPKIXPublicKey(&k384.PublicKey)
	krsa, _ := rsa.GenerateKey(rand.Reader, 2048)
	drsa, _ := x509.MarshalPKIXPublicKey(&krsa.PublicKey)
	for name, b := range map[string]string{
		"p384":    base64.StdEncoding.EncodeToString(d384),
		"rsa":     base64.StdEncoding.EncodeToString(drsa),
		"garbage": "bm90IGEga2V5",
		"empty":   "",
	} {
		if _, _, err := ParseDevicePublicKey(b); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

func TestContinueWithTheRightKeyOpensASession(t *testing.T) {
	f := newFixture()
	p := newPhoneKey(t)
	cred := f.enroll(t, 281, p, "install-aaaa")
	res, err := f.login(t, p, cred)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if res.User.ID != 281 || len(f.issued) != 1 {
		t.Fatalf("session for %d, issued %v", res.User.ID, f.issued)
	}
	k, _ := f.store.FindByID(uuid.MustParse(cred))
	if k.LastUsedAt == nil || k.ChallengeHash != "" {
		t.Fatalf("use not stamped or challenge left alive: %+v", k)
	}
}

func TestAChallengeWorksOnce(t *testing.T) {
	f := newFixture()
	p := newPhoneKey(t)
	cred := f.enroll(t, 281, p, "install-aaaa")
	ch, _ := f.svc.Challenge(context.Background(), cred)
	req := &models.DeviceLoginRequest{CredentialID: cred, Challenge: ch.Challenge, Signature: p.sign(t, cred, ch.Challenge)}
	if _, err := f.svc.Login(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	_, err := f.svc.Login(context.Background(), req) // replayed
	wantCode(t, err, DeviceErrChallengeInvalid, "")
}

func TestAnExpiredChallengeIsRefused(t *testing.T) {
	f := newFixture()
	p := newPhoneKey(t)
	cred := f.enroll(t, 281, p, "install-aaaa")
	ch, _ := f.svc.Challenge(context.Background(), cred)
	f.now = f.now.Add(DeviceChallengeTTL + time.Second)
	_, err := f.svc.Login(context.Background(), &models.DeviceLoginRequest{
		CredentialID: cred, Challenge: ch.Challenge, Signature: p.sign(t, cred, ch.Challenge)})
	wantCode(t, err, DeviceErrChallengeInvalid, "")
}

func TestAnotherKeyCannotSignForThisCredential(t *testing.T) {
	f := newFixture()
	owner, thief := newPhoneKey(t), newPhoneKey(t)
	cred := f.enroll(t, 281, owner, "install-aaaa")
	for i := 1; i <= MaxBadSignatures; i++ {
		_, err := f.login(t, thief, cred)
		if i < MaxBadSignatures {
			wantCode(t, err, DeviceErrSignatureInvalid, "")
		}
	}
	// After MaxBadSignatures the key is revoked, even for its owner.
	_, err := f.login(t, owner, cred)
	wantCode(t, err, DeviceErrRevoked, models.DeviceKeyRevokedBadSignatures)
	if len(f.issued) != 0 {
		t.Fatalf("a session was issued: %v", f.issued)
	}
}

func TestASignatureForOneCredentialDoesNotWorkForAnother(t *testing.T) {
	f := newFixture()
	p := newPhoneKey(t)
	credA := f.enroll(t, 281, p, "install-aaaa")
	q := newPhoneKey(t)
	credB := f.enroll(t, 280, q, "install-aaaa")
	ch, _ := f.svc.Challenge(context.Background(), credB)
	// Signed by the right key for B, but over A's credential id.
	_, err := f.svc.Login(context.Background(), &models.DeviceLoginRequest{
		CredentialID: credB, Challenge: ch.Challenge, Signature: q.sign(t, credA, ch.Challenge)})
	wantCode(t, err, DeviceErrSignatureInvalid, "")
}

func TestPasswordResetAndTwoFactorRevokeEveryKey(t *testing.T) {
	for _, reason := range []string{models.DeviceKeyRevokedPassword, models.DeviceKeyRevokedTwoFactor} {
		f := newFixture()
		p1, p2 := newPhoneKey(t), newPhoneKey(t)
		c1 := f.enroll(t, 281, p1, "install-iphone")
		c2 := f.enroll(t, 281, p2, "install-samsung")
		other := newPhoneKey(t)
		c3 := f.enroll(t, 280, other, "install-iphone")

		f.svc.RevokeAllForUser(281, reason)

		_, err := f.login(t, p1, c1)
		wantCode(t, err, DeviceErrRevoked, reason)
		_, err = f.login(t, p2, c2)
		wantCode(t, err, DeviceErrRevoked, reason)
		if _, err := f.login(t, other, c3); err != nil {
			t.Fatalf("%s: another account's key died too: %v", reason, err)
		}
	}
}

func TestRevokeFromSettingsOnlyForTheOwner(t *testing.T) {
	f := newFixture()
	p := newPhoneKey(t)
	cred := f.enroll(t, 281, p, "install-aaaa")
	err := f.svc.Revoke(context.Background(), 280, cred)
	wantCode(t, err, DeviceErrNotFound, "")
	if err := f.svc.Revoke(context.Background(), 281, cred); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Revoke(context.Background(), 281, cred); err != nil {
		t.Fatalf("second revoke: %v", err)
	}
	_, err = f.login(t, p, cred)
	wantCode(t, err, DeviceErrRevoked, models.DeviceKeyRevokedByUser)
}

func TestAKeyUnusedForTooLongExpires(t *testing.T) {
	f := newFixture()
	p := newPhoneKey(t)
	cred := f.enroll(t, 281, p, "install-aaaa")
	f.now = f.now.Add(DeviceKeyIdleLifetime - time.Hour)
	if _, err := f.login(t, p, cred); err != nil {
		t.Fatalf("still in time: %v", err)
	}
	// The use slid the window: another almost full lifetime is fine.
	f.now = f.now.Add(DeviceKeyIdleLifetime - time.Hour)
	if _, err := f.login(t, p, cred); err != nil {
		t.Fatalf("sliding window: %v", err)
	}
	f.now = f.now.Add(DeviceKeyIdleLifetime)
	_, err := f.svc.Challenge(context.Background(), cred)
	wantCode(t, err, DeviceErrExpired, "")
}

func TestANewKeyForTheSameInstallReplacesTheOld(t *testing.T) {
	f := newFixture()
	old, fresh := newPhoneKey(t), newPhoneKey(t)
	cOld := f.enroll(t, 281, old, "install-aaaa")
	cNew := f.enroll(t, 281, fresh, "install-aaaa")
	_, err := f.login(t, old, cOld)
	wantCode(t, err, DeviceErrRevoked, models.DeviceKeyRevokedReplaced)
	if _, err := f.login(t, fresh, cNew); err != nil {
		t.Fatal(err)
	}
}

func TestEnrollingTheSameKeyAgainIsIdempotentAndCannotChangeAccount(t *testing.T) {
	f := newFixture()
	p := newPhoneKey(t)
	c1 := f.enroll(t, 281, p, "install-aaaa")
	c2 := f.enroll(t, 281, p, "install-aaaa")
	if c1 != c2 {
		t.Fatalf("retry made a second credential: %s %s", c1, c2)
	}
	_, err := f.svc.Enroll(context.Background(), 280, f.now, &models.EnrollDeviceKeyRequest{
		PublicKey: p.spki, InstallationID: "install-bbbb", Platform: "ios"})
	wantCode(t, err, DeviceErrKeyInUse, "")
}

func TestTheCapRevokesTheLeastRecentlyUsed(t *testing.T) {
	f := newFixture()
	keys := make([]phoneKey, MaxLiveDeviceKeys+1)
	creds := make([]string, MaxLiveDeviceKeys+1)
	for i := range keys {
		keys[i] = newPhoneKey(t)
		creds[i] = f.enroll(t, 281, keys[i], "install-"+uuid.NewString()[:8])
		f.now = f.now.Add(time.Minute)
	}
	_, err := f.login(t, keys[0], creds[0])
	wantCode(t, err, DeviceErrRevoked, models.DeviceKeyRevokedTooMany)
	live, _ := f.store.ListLive(281)
	if len(live) != MaxLiveDeviceKeys {
		t.Fatalf("live keys %d, want %d", len(live), MaxLiveDeviceKeys)
	}
}

func TestAccountGoneRevokesTheKey(t *testing.T) {
	f := newFixture()
	p := newPhoneKey(t)
	cred := f.enroll(t, 281, p, "install-aaaa")
	f.svc.users = memUsers{} // the account was deleted
	_, err := f.login(t, p, cred)
	wantCode(t, err, DeviceErrRevoked, models.DeviceKeyRevokedAccount)
}

func TestEnrollValidation(t *testing.T) {
	f := newFixture()
	p := newPhoneKey(t)
	for name, req := range map[string]models.EnrollDeviceKeyRequest{
		"platform": {PublicKey: p.spki, InstallationID: "install-aaaa", Platform: "windows"},
		"install":  {PublicKey: p.spki, InstallationID: "short", Platform: "ios"},
		"key":      {PublicKey: "nope", InstallationID: "install-aaaa", Platform: "android"},
	} {
		r := req
		if _, err := f.svc.Enroll(context.Background(), 281, f.now, &r); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

func TestUnknownOrMalformedCredentialIsNotFound(t *testing.T) {
	f := newFixture()
	_, err := f.svc.Challenge(context.Background(), "not-a-uuid")
	wantCode(t, err, DeviceErrNotFound, "")
	_, err = f.svc.Challenge(context.Background(), uuid.NewString())
	wantCode(t, err, DeviceErrNotFound, "")
}

func TestListMarksTheCurrentInstallAndHidesRevoked(t *testing.T) {
	f := newFixture()
	a, b := newPhoneKey(t), newPhoneKey(t)
	f.enroll(t, 281, a, "install-iphone")
	cb := f.enroll(t, 281, b, "install-samsung")
	_ = f.svc.Revoke(context.Background(), 281, cb)
	views, err := f.svc.List(context.Background(), 281, "install-iphone")
	if err != nil {
		t.Fatal(err)
	}
	if len(views) != 1 || !views[0].Current {
		t.Fatalf("views %+v", views)
	}
}

func TestDeviceKeyTwoFactorDecisionIsExplicit(t *testing.T) {
	if !DeviceKeySkipsSecondFactor {
		t.Fatal("decision changed: update DeviceKeyService.Login and the app")
	}
}
