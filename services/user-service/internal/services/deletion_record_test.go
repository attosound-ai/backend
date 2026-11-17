package services

import (
	"testing"
	"time"

	"github.com/atto-sound/user-service/internal/models"
)

func u64(v uint64) *uint64 { return &v }

var (
	rep     = &models.User{ID: 266, Username: "arami", Role: models.RoleRepresentative}
	creator = &models.User{ID: 267, Username: "aramis", Role: models.RoleCreator, IsManagedAccount: true, RepresentativeID: u64(266)}
	op      = DeletionMeta{Via: models.DeletionViaOperator, RequestedBy: "client", PerformedBy: "operator", Reason: "asked"}
	now     = time.Date(2026, 9, 20, 17, 1, 48, 0, time.UTC)
)

// The exact Sep 20 case: the representative alone, its creator stays. The
// record must say the creator was left without a representative.
func TestRecordsMarkOrphanedCreators(t *testing.T) {
	rows := BuildDeletionRecords("b1", rep, nil, []*models.User{creator}, op, now)
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	r := rows[0]
	if r.DeletedUserID != 266 || r.Username != "arami" || r.OrphanedCreatorIDs != "267" {
		t.Fatalf("bad row: %+v", r)
	}
	if r.RequestedBy != "client" || r.PerformedBy != "operator" || r.Reason != "asked" || r.Via != "operator" || r.BatchID != "b1" {
		t.Fatalf("meta lost: %+v", r)
	}
}

func TestRecordsWithLinkedHaveNoOrphans(t *testing.T) {
	rows := BuildDeletionRecords("b2", rep, []*models.User{creator}, []*models.User{creator}, op, now)
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	if rows[0].OrphanedCreatorIDs != "" {
		t.Fatalf("orphans reported although the creator was deleted too: %q", rows[0].OrphanedCreatorIDs)
	}
	if rows[0].IncludedAsLinked || !rows[1].IncludedAsLinked || rows[1].DeletedUserID != 267 {
		t.Fatalf("linked flags wrong: %+v", rows)
	}
	if rows[1].BatchID != "b2" || rows[1].RequestedBy != "client" {
		t.Fatal("linked row lost the batch or the meta")
	}
}

// Deleting a creator never orphans anyone, even if its representative is in
// the linked list.
func TestDeletingACreatorOrphansNobody(t *testing.T) {
	rows := BuildDeletionRecords("b3", creator, nil, []*models.User{rep}, op, now)
	if rows[0].OrphanedCreatorIDs != "" {
		t.Fatalf("orphans = %q, want none", rows[0].OrphanedCreatorIDs)
	}
}

func TestMetaValidation(t *testing.T) {
	ok := []DeletionMeta{
		op,
		{Via: models.DeletionViaSelfService, RequestedBy: "aramis (267)", PerformedBy: "aramis (267)"},
	}
	for _, m := range ok {
		if err := m.Validate(); err != nil {
			t.Fatalf("%+v rejected: %v", m, err)
		}
	}
	bad := []DeletionMeta{
		{},
		{Via: models.DeletionViaOperator, RequestedBy: "client", PerformedBy: "operator"},
		{Via: models.DeletionViaOperator, RequestedBy: " ", PerformedBy: "operator", Reason: "x"},
		{Via: "whatever", RequestedBy: "a", PerformedBy: "b", Reason: "c"},
		{Via: models.DeletionViaBackfill, RequestedBy: "a", PerformedBy: "b", Reason: "c"},
	}
	for _, m := range bad {
		if err := m.Validate(); err == nil {
			t.Fatalf("%+v accepted", m)
		}
	}
}

func TestLongFieldsAreClipped(t *testing.T) {
	long := make([]byte, 5000)
	for i := range long {
		long[i] = 'x'
	}
	m := op
	m.Reason = string(long)
	m.RequestedBy = string(long)
	r := BuildDeletionRecords("b4", rep, nil, nil, m, now)[0]
	if len(r.Reason) != 1000 || len(r.RequestedBy) != 200 {
		t.Fatalf("not clipped: reason %d requestedBy %d", len(r.Reason), len(r.RequestedBy))
	}
}
