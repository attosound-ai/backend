//go:build integration

package services

// Runs the real deletion against a throwaway Postgres:
//   USER_SERVICE_TEST_DSN="host=/tmp port=55433 user=postgres dbname=atto_users_test sslmode=disable" \
//     go test -tags integration ./internal/services -run Integration

import (
	"context"
	"os"
	"strconv"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/atto-sound/user-service/internal/kafka"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
)

func integrationDB(t *testing.T) *gorm.DB {
	dsn := os.Getenv("USER_SERVICE_TEST_DSN")
	if dsn == "" {
		t.Skip("USER_SERVICE_TEST_DSN not set")
	}
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&models.User{}, &models.UserCredentials{}, &models.PushToken{},
		&models.SignupSession{}, &models.AccountDeletion{}); err != nil {
		t.Fatal(err)
	}
	db.Exec("TRUNCATE users, account_deletions RESTART IDENTITY CASCADE")
	return db
}

func seed(t *testing.T, db *gorm.DB) (*models.User, *models.User) {
	email := "stephanie@example.com"
	r := &models.User{Username: "arami", DisplayName: "Stephanie", Email: &email, Role: models.RoleRepresentative}
	if err := db.Create(r).Error; err != nil {
		t.Fatal(err)
	}
	c := &models.User{Username: "aramis", DisplayName: "James Saldana", Role: models.RoleCreator,
		IsManagedAccount: true, RepresentativeID: &r.ID}
	if err := db.Create(c).Error; err != nil {
		t.Fatal(err)
	}
	return r, c
}

func exists(db *gorm.DB, id uint64) bool {
	var n int64
	db.Model(&models.User{}).Where("id = ?", id).Count(&n)
	return n > 0
}

func TestIntegrationOperatorDeleteWritesRecord(t *testing.T) {
	db := integrationDB(t)
	r, c := seed(t, db)
	svc := NewUserService(repositories.NewUserRepository(db), kafka.NewProducer("127.0.0.1:1"))
	meta := DeletionMeta{Via: models.DeletionViaOperator, RequestedBy: "client Anthony", PerformedBy: "David", Reason: "client asked"}
	if err := svc.DeleteAccount(context.Background(), r.ID, false, meta); err != nil {
		t.Fatal(err)
	}
	if exists(db, r.ID) || !exists(db, c.ID) {
		t.Fatal("wrong accounts deleted")
	}
	var rows []models.AccountDeletion
	db.Find(&rows)
	if len(rows) != 1 {
		t.Fatalf("records = %d, want 1", len(rows))
	}
	got := rows[0]
	if got.Username != "arami" || got.Email == nil || *got.Email != "stephanie@example.com" ||
		got.RequestedBy != "client Anthony" || got.PerformedBy != "David" || got.Reason != "client asked" ||
		got.OrphanedCreatorIDs != strconv.FormatUint(c.ID, 10) || got.Via != "operator" || got.BatchID == "" {
		t.Fatalf("record wrong: %+v", got)
	}
	list, err := svc.ListDeletions("anthony", 10, 0)
	if err != nil || list.Total != 1 || list.Deletions[0].DeletedUserID != r.ID {
		t.Fatalf("list by requester: %+v %v", list, err)
	}
}

func TestIntegrationLinkedDeleteSharesBatch(t *testing.T) {
	db := integrationDB(t)
	r, c := seed(t, db)
	svc := NewUserService(repositories.NewUserRepository(db), kafka.NewProducer("127.0.0.1:1"))
	meta := DeletionMeta{Via: models.DeletionViaSelfService, RequestedBy: "arami, from the app", PerformedBy: "arami", ActorUserID: &r.ID}
	if err := svc.DeleteAccount(context.Background(), r.ID, true, meta); err != nil {
		t.Fatal(err)
	}
	if exists(db, r.ID) || exists(db, c.ID) {
		t.Fatal("linked delete left an account")
	}
	var rows []models.AccountDeletion
	db.Order("id").Find(&rows)
	if len(rows) != 2 || rows[0].BatchID != rows[1].BatchID || rows[0].OrphanedCreatorIDs != "" || !rows[1].IncludedAsLinked {
		t.Fatalf("records wrong: %+v", rows)
	}
}

// If the record cannot be written, NOTHING is deleted.
func TestIntegrationNoRecordNoDelete(t *testing.T) {
	db := integrationDB(t)
	r, _ := seed(t, db)
	db.Exec("ALTER TABLE account_deletions ADD CONSTRAINT block_all CHECK (false) NOT VALID")
	defer db.Exec("ALTER TABLE account_deletions DROP CONSTRAINT block_all")
	svc := NewUserService(repositories.NewUserRepository(db), kafka.NewProducer("127.0.0.1:1"))
	meta := DeletionMeta{Via: models.DeletionViaOperator, RequestedBy: "a", PerformedBy: "b", Reason: "c"}
	if err := svc.DeleteAccount(context.Background(), r.ID, false, meta); err == nil {
		t.Fatal("delete succeeded although its record could not be written")
	}
	if !exists(db, r.ID) {
		t.Fatal("account deleted without a record")
	}
}

func TestIntegrationIncompleteMetaDeletesNothing(t *testing.T) {
	db := integrationDB(t)
	r, _ := seed(t, db)
	svc := NewUserService(repositories.NewUserRepository(db), kafka.NewProducer("127.0.0.1:1"))
	if err := svc.DeleteAccount(context.Background(), r.ID, false, DeletionMeta{Via: models.DeletionViaOperator}); err == nil {
		t.Fatal("accepted an anonymous deletion")
	}
	if !exists(db, r.ID) {
		t.Fatal("account deleted anonymously")
	}
}

// The Oct 3 repair: delete the representative only, then give the orphaned
// creator a new one. The new rep shares the creator's password and the
// creator points at it with a fresh internal email.
func TestIntegrationRelinkOrphanedCreator(t *testing.T) {
	db := integrationDB(t)
	db.Exec("TRUNCATE user_credentials")
	r, c := seed(t, db)
	inmate := "334658"
	db.Model(&models.User{}).Where("id = ?", c.ID).Update("inmate_number", inmate)
	db.Create(&models.UserCredentials{UserID: c.ID, PasswordHash: "hash-of-creator"})
	svc := NewUserService(repositories.NewUserRepository(db), kafka.NewProducer("127.0.0.1:1"))

	req := RelinkRequest{CreatorID: c.ID, CreatorUsername: "aramis", Email: "Stephanie@Example.com", Username: "arami",
		DisplayName: "Stephanie", Relationship: "family", RequestedBy: "client", PerformedBy: "operator", Reason: "rep deleted"}
	if _, err := svc.RelinkOrphanedCreator(context.Background(), req); err != ErrRelinkNotOrphan {
		t.Fatalf("relinked a creator that still has its representative: %v", err)
	}
	meta := DeletionMeta{Via: models.DeletionViaOperator, RequestedBy: "a", PerformedBy: "b", Reason: "c"}
	if err := svc.DeleteAccount(context.Background(), r.ID, false, meta); err != nil {
		t.Fatal(err)
	}
	bad := req
	bad.CreatorUsername = "arami"
	if _, err := svc.RelinkOrphanedCreator(context.Background(), bad); err != ErrRelinkNameMismatch {
		t.Fatalf("username guard: %v", err)
	}
	res, err := svc.RelinkOrphanedCreator(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	var rep, cr models.User
	db.First(&rep, res.RepresentativeID)
	db.First(&cr, c.ID)
	if rep.Role != models.RoleRepresentative || rep.Email == nil || *rep.Email != "stephanie@example.com" || rep.Username != "arami" {
		t.Fatalf("rep wrong: %+v", rep)
	}
	if cr.RepresentativeID == nil || *cr.RepresentativeID != rep.ID || cr.Email == nil ||
		*cr.Email != "creator_334658_"+strconv.FormatUint(rep.ID, 10)+"@managed.atto" {
		t.Fatalf("creator not relinked: %+v", cr)
	}
	var creds models.UserCredentials
	db.Where("user_id = ?", rep.ID).First(&creds)
	if creds.PasswordHash != "hash-of-creator" {
		t.Fatal("rep did not get the creator's password")
	}
	linked, _ := repositories.NewUserRepository(db).GetLinkedAccounts(rep.ID, false, nil)
	if len(linked) != 1 || linked[0].ID != c.ID {
		t.Fatalf("switcher would not see the creator: %+v", linked)
	}
	if _, err := svc.RelinkOrphanedCreator(context.Background(), req); err != ErrRelinkNotOrphan {
		t.Fatalf("second relink allowed: %v", err)
	}
}
