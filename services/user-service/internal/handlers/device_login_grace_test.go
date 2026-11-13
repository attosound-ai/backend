package handlers

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/services"
)

// oneKeyStore holds the keys of this test in memory.
type oneKeyStore struct {
	rows map[uuid.UUID]*models.DeviceKey
}

func (s *oneKeyStore) Create(k *models.DeviceKey) error {
	c := *k
	s.rows[k.ID] = &c
	return nil
}
func (s *oneKeyStore) FindByID(id uuid.UUID) (*models.DeviceKey, error) {
	if r, ok := s.rows[id]; ok {
		c := *r
		return &c, nil
	}
	return nil, nil
}
func (s *oneKeyStore) FindByKeyHash(h string) (*models.DeviceKey, error) {
	for _, r := range s.rows {
		if r.KeyHash == h {
			c := *r
			return &c, nil
		}
	}
	return nil, nil
}
func (s *oneKeyStore) ListLive(uid uint64) ([]models.DeviceKey, error) {
	var out []models.DeviceKey
	for _, r := range s.rows {
		if r.UserID == uid && r.RevokedAt == nil {
			out = append(out, *r)
		}
	}
	return out, nil
}
func (s *oneKeyStore) SetChallenge(id uuid.UUID, h string, exp time.Time) error {
	s.rows[id].ChallengeHash, s.rows[id].ChallengeExpiresAt = h, &exp
	return nil
}
func (s *oneKeyStore) ConsumeChallenge(id uuid.UUID, h string, now time.Time) (bool, error) {
	r := s.rows[id]
	if r == nil || r.ChallengeHash != h || r.ChallengeExpiresAt == nil || !r.ChallengeExpiresAt.After(now) {
		return false, nil
	}
	r.ChallengeHash, r.ChallengeExpiresAt = "", nil
	return true, nil
}
func (s *oneKeyStore) MarkUsed(id uuid.UUID, at time.Time) error         { return nil }
func (s *oneKeyStore) AddBadSignature(id uuid.UUID) (int, error)         { return 1, nil }
func (s *oneKeyStore) Revoke(id uuid.UUID, r string, at time.Time) error { return nil }
func (s *oneKeyStore) RevokeAllForUser(uid uint64, r string, at time.Time) (int64, error) {
	return 0, nil
}

type graceUsers map[uint64]*models.User

func (u graceUsers) FindByID(id uint64) (*models.User, error) { return u[id], nil }

// POST /auth/login/device for an account in its deletion grace answers the
// same 403 account_pending_deletion, with the date and a recovery token, as
// the password login, so the app opens the recover screen.
func TestDeviceLoginAnswersTheGraceLikeTheLogin(t *testing.T) {
	mgr := deviceTestMgr()
	auth := services.NewAuthService(nil, mgr, nil, "")
	at := time.Now().UTC().Add(-time.Hour)
	sched := at.Add(30 * 24 * time.Hour)
	user := &models.User{ID: 281, Username: "westcol"}
	users := graceUsers{281: user}
	svc := services.NewDeviceKeyService(&oneKeyStore{rows: map[uuid.UUID]*models.DeviceKey{}}, users, auth.IssueSession)

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	enrolled, err := svc.Enroll(context.Background(), 281, time.Now(), &models.EnrollDeviceKeyRequest{
		PublicKey: base64.StdEncoding.EncodeToString(der), InstallationID: "install-iphone", Platform: "ios"})
	if err != nil {
		t.Fatalf("enroll: %v", err)
	}
	// A key still alive on an account in its grace (the deletion request
	// revokes them; this forces the case).
	user.DeactivatedAt, user.ScheduledDeletionAt = &at, &sched
	ch, err := svc.Challenge(context.Background(), enrolled.CredentialID)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(services.DeviceLoginMessage(enrolled.CredentialID, ch.Challenge))
	sig, err := ecdsa.SignASN1(rand.Reader, priv, digest[:])
	if err != nil {
		t.Fatal(err)
	}

	app := fiber.New()
	app.Post("/auth/login/device", NewDeviceKeyHandler(svc).Login)
	body, _ := json.Marshal(models.DeviceLoginRequest{
		CredentialID: enrolled.CredentialID, Challenge: ch.Challenge,
		Signature: base64.StdEncoding.EncodeToString(sig)})
	req := httptest.NewRequest("POST", "/auth/login/device", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != fiber.StatusForbidden {
		t.Fatalf("status %d, want 403", res.StatusCode)
	}
	var out struct {
		Success bool   `json:"success"`
		Error   string `json:"error"`
		Data    struct {
			UserID              uint64    `json:"userId"`
			ScheduledDeletionAt time.Time `json:"scheduledDeletionAt"`
			RecoveryToken       string    `json:"recoveryToken"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Success || out.Error != services.AccountPendingDeletionCode || out.Data.UserID != 281 ||
		out.Data.RecoveryToken == "" || !out.Data.ScheduledDeletionAt.Equal(sched) {
		t.Fatalf("answer: %+v", out)
	}
	if uid, err := mgr.ValidateRecoveryToken(out.Data.RecoveryToken); err != nil || uid != 281 {
		t.Fatalf("recovery token: %d, %v", uid, err)
	}
}
