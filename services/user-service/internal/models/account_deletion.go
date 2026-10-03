package models

import "time"

// Deletion channels. Every way an account can disappear must be one of these.
const (
	// DeletionViaSelfService is DELETE /users/me/account: the owner, with an OTP.
	DeletionViaSelfService = "self_service"
	// DeletionViaOperator is DELETE /users/admin/:id behind the admin token.
	DeletionViaOperator = "operator"
	// DeletionViaBackfill marks rows rebuilt afterwards from telemetry, for
	// deletions that happened before this table existed.
	DeletionViaBackfill = "backfill"
)

// AccountDeletion is the permanent record of one deleted account.
//
// Why it exists (Oct 3 2026): the representative account arami (266) was
// deleted on Sep 20 through the operator endpoint, and two weeks later
// nobody could say who deleted it or why. The only trace was a Railway log
// line and an anonymous PostHog event. Now every deletion writes one row per
// account IN THE SAME TRANSACTION that removes the user, so an account can
// never disappear without its record. This table is never purged and holds
// no foreign key to users on purpose: the user row is gone by design.
type AccountDeletion struct {
	ID uint64 `gorm:"primaryKey;autoIncrement" json:"id"`
	// BatchID groups the accounts removed by one request (a representative
	// and the creators deleted with it share it).
	BatchID string `gorm:"size:36;index;not null" json:"batchId"`

	// Snapshot of the account, taken before the delete.
	DeletedUserID    uint64     `gorm:"index;not null" json:"deletedUserId"`
	Username         string     `gorm:"size:50;index;not null" json:"username"`
	DisplayName      string     `gorm:"size:100" json:"displayName"`
	Email            *string    `gorm:"size:255" json:"email,omitempty"`
	Phone            *string    `gorm:"size:25" json:"phone,omitempty"`
	Role             string     `gorm:"size:20;not null" json:"role"`
	IsManagedAccount bool       `json:"isManagedAccount"`
	RepresentativeID *uint64    `json:"representativeId,omitempty"`
	InmateNumber     *string    `gorm:"size:50" json:"inmateNumber,omitempty"`
	AccountCreatedAt *time.Time `json:"accountCreatedAt,omitempty"`

	// How and why.
	Via string `gorm:"size:20;index;not null" json:"via"`
	// RequestedBy is who asked for the deletion ("the owner from the app",
	// "client Anthony by WhatsApp"). Required on the operator route.
	RequestedBy string `gorm:"size:200;not null" json:"requestedBy"`
	// PerformedBy is who ran it (the account itself, or the operator).
	PerformedBy string `gorm:"size:200;not null" json:"performedBy"`
	Reason      string `gorm:"size:1000" json:"reason"`
	// ActorUserID is the signed in account that triggered a self service
	// delete (a representative deleting its creators too is the actor of all).
	ActorUserID *uint64 `json:"actorUserId,omitempty"`
	// IncludedAsLinked is true for accounts removed because their linked
	// account was deleted with deleteLinked.
	IncludedAsLinked bool `json:"includedAsLinked"`
	// OrphanedCreatorIDs lists managed creators left WITHOUT a representative
	// by this delete (comma separated). Non empty means someone still logs in
	// to a creator whose representative is gone, like aramis after arami.
	OrphanedCreatorIDs string `gorm:"size:500" json:"orphanedCreatorIds,omitempty"`

	ClientIP  string    `gorm:"size:64" json:"clientIp,omitempty"`
	UserAgent string    `gorm:"size:300" json:"userAgent,omitempty"`
	DeletedAt time.Time `gorm:"index;not null" json:"deletedAt"`
}

// TableName pins the table name.
func (AccountDeletion) TableName() string { return "account_deletions" }
