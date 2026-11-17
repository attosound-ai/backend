//go:build integration

package services

// The device key flows against a real, throwaway Postgres:
//   USER_SERVICE_TEST_DSN="host=/tmp port=55433 user=postgres dbname=atto_users_test sslmode=disable" \
//     go test -tags integration ./internal/services -run IntegrationDeviceKey

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/atto-sound/user-service/internal/kafka"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
)

func TestIntegrationDeviceKeyFlow(t *testing.T) {
	db := integrationDB(t)
	db.Exec("TRUNCATE device_keys")
	u := &models.User{Username: "westcol_qa", DisplayName: "QA", Role: models.RoleCreator}
	if err := db.Create(u).Error; err != nil {
		t.Fatal(err)
	}
	userRepo := repositories.NewUserRepository(db)
	store := repositories.NewDeviceKeyRepository(db)
	issued := 0
	svc := NewDeviceKeyService(store, userRepo, func(user *models.User) (*models.AuthResponse, error) {
		issued++
		return &models.AuthResponse{User: user.ToProfile()}, nil
	})
	ctx := context.Background()

	p := newPhoneKey(t)
	res, err := svc.Enroll(ctx, u.ID, time.Now(), &models.EnrollDeviceKeyRequest{
		PublicKey: p.spki, InstallationID: "install-integration", Platform: "android", Hardware: "strongbox"})
	if err != nil {
		t.Fatal(err)
	}
	cred := res.CredentialID

	// Two logins racing with the same challenge: exactly one wins.
	ch, err := svc.Challenge(ctx, cred)
	if err != nil {
		t.Fatal(err)
	}
	sig := p.sign(t, cred, ch.Challenge)
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := svc.Login(ctx, &models.DeviceLoginRequest{CredentialID: cred, Challenge: ch.Challenge, Signature: sig}); err == nil {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if wins != 1 || issued != 1 {
		t.Fatalf("wins %d, issued %d; want 1 and 1", wins, issued)
	}

	// Bad signatures are counted in the database and revoke at the cap.
	thief := newPhoneKey(t)
	for i := 0; i < MaxBadSignatures; i++ {
		c, err := svc.Challenge(ctx, cred)
		if err != nil {
			t.Fatalf("challenge %d: %v", i, err)
		}
		_, _ = svc.Login(ctx, &models.DeviceLoginRequest{CredentialID: cred, Challenge: c.Challenge, Signature: thief.sign(t, cred, c.Challenge)})
	}
	k, _ := store.FindByID(uuid.MustParse(cred))
	if k.RevokedAt == nil || k.RevokedReason != models.DeviceKeyRevokedBadSignatures {
		t.Fatalf("not revoked after bad signatures: %+v", k)
	}

	// A fresh key, then the account is deleted: its keys go with it.
	q := newPhoneKey(t)
	if _, err := svc.Enroll(ctx, u.ID, time.Now(), &models.EnrollDeviceKeyRequest{
		PublicKey: q.spki, InstallationID: "install-integration", Platform: "android"}); err != nil {
		t.Fatal(err)
	}
	users := NewUserService(userRepo, kafka.NewProducer("127.0.0.1:1"))
	meta := DeletionMeta{Via: models.DeletionViaOperator, RequestedBy: "test", PerformedBy: "test", Reason: "integration"}
	if err := users.DeleteAccount(ctx, u.ID, false, meta); err != nil {
		t.Fatal(err)
	}
	var left int64
	db.Model(&models.DeviceKey{}).Where("user_id = ?", u.ID).Count(&left)
	if left != 0 {
		t.Fatalf("%d device keys left after deleting the account", left)
	}
}
