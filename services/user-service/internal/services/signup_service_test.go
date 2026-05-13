package services

import (
	"strings"
	"testing"

	"github.com/atto-sound/user-service/internal/models"
)

// nextStepFor covers the wizard ordering. The whole point of moving step
// decisions to the server is that this single function is the source of truth.
func TestNextStepFor(t *testing.T) {
	strPtr := func(s string) *string { return &s }
	truePtr := func() *bool { b := true; return &b }

	cases := []struct {
		name    string
		session models.SignupSession
		want    string
	}{
		{
			name:    "fresh session: OTP first",
			session: models.SignupSession{IdentifierVerified: false},
			want:    stepOTP,
		},
		{
			name: "verified, no name yet",
			session: models.SignupSession{
				IdentifierVerified: true,
				Draft:              models.SignupDraft{},
			},
			want: stepName,
		},
		{
			name: "name set, missing DOB",
			session: models.SignupSession{
				IdentifierVerified: true,
				Draft:              models.SignupDraft{DisplayName: strPtr("Ada")},
			},
			want: stepDOB,
		},
		{
			name: "missing password",
			session: models.SignupSession{
				IdentifierVerified: true,
				Draft: models.SignupDraft{
					DisplayName: strPtr("Ada"),
					DateOfBirth: strPtr("1815-12-10"),
				},
			},
			want: stepPassword,
		},
		{
			name: "missing username",
			session: models.SignupSession{
				IdentifierVerified: true,
				Draft: models.SignupDraft{
					DisplayName:  strPtr("Ada"),
					DateOfBirth:  strPtr("1815-12-10"),
					PasswordHash: strPtr("hash"),
				},
			},
			want: stepProfile,
		},
		{
			name: "listener fully filled → complete",
			session: models.SignupSession{
				IdentifierVerified: true,
				Draft: models.SignupDraft{
					DisplayName:  strPtr("Ada"),
					DateOfBirth:  strPtr("1815-12-10"),
					PasswordHash: strPtr("hash"),
					Username:     strPtr("ada"),
					Role:         strPtr(string(models.RoleListener)),
				},
			},
			want: "complete",
		},
		{
			name: "representative needs inmate number after role",
			session: models.SignupSession{
				IdentifierVerified: true,
				Draft: models.SignupDraft{
					DisplayName:  strPtr("Ada"),
					DateOfBirth:  strPtr("1815-12-10"),
					PasswordHash: strPtr("hash"),
					Username:     strPtr("ada"),
					Role:         strPtr(string(models.RoleRepresentative)),
				},
			},
			want: stepCreatorInfo,
		},
		{
			name: "representative with inmate but no consent",
			session: models.SignupSession{
				IdentifierVerified: true,
				Draft: models.SignupDraft{
					DisplayName:  strPtr("Ada"),
					DateOfBirth:  strPtr("1815-12-10"),
					PasswordHash: strPtr("hash"),
					Username:     strPtr("ada"),
					Role:         strPtr(string(models.RoleRepresentative)),
					InmateNumber: strPtr("A12345"),
				},
			},
			want: stepConsent,
		},
		{
			name: "representative with consent → subscription",
			session: models.SignupSession{
				IdentifierVerified: true,
				Draft: models.SignupDraft{
					DisplayName:        strPtr("Ada"),
					DateOfBirth:        strPtr("1815-12-10"),
					PasswordHash:       strPtr("hash"),
					Username:           strPtr("ada"),
					Role:               strPtr(string(models.RoleRepresentative)),
					InmateNumber:       strPtr("A12345"),
					ConsentToRecording: truePtr(),
				},
			},
			want: stepSubscription,
		},
		{
			name: "representative all fields → complete",
			session: models.SignupSession{
				IdentifierVerified: true,
				Draft: models.SignupDraft{
					DisplayName:        strPtr("Ada"),
					DateOfBirth:        strPtr("1815-12-10"),
					PasswordHash:       strPtr("hash"),
					Username:           strPtr("ada"),
					Role:               strPtr(string(models.RoleRepresentative)),
					InmateNumber:       strPtr("A12345"),
					ConsentToRecording: truePtr(),
					SelectedPlan:       strPtr("record_pro"),
					BridgeNumber:       strPtr("+15551234567"),
				},
			},
			want: "complete",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := NextStepFor(&tc.session)
			if got != tc.want {
				t.Fatalf("NextStepFor: got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestMergeDraft_KeepsExistingWhenPatchNil(t *testing.T) {
	original := "Ada"
	base := models.SignupDraft{DisplayName: &original}
	patch := models.SignupDraft{} // nothing set

	mergeDraft(&base, &patch)

	if base.DisplayName == nil || *base.DisplayName != original {
		t.Fatalf("expected DisplayName to survive nil patch, got %v", base.DisplayName)
	}
}

func TestMergeDraft_OverwritesWhenPatchSet(t *testing.T) {
	old := "Ada"
	neu := "Babbage"
	base := models.SignupDraft{DisplayName: &old}
	patch := models.SignupDraft{DisplayName: &neu}

	mergeDraft(&base, &patch)

	if base.DisplayName == nil || *base.DisplayName != neu {
		t.Fatalf("expected DisplayName overwrite, got %v", base.DisplayName)
	}
}

func TestMergeDraft_LowercasesUsernameAndEmail(t *testing.T) {
	base := models.SignupDraft{}
	uname := "  ADA  "
	email := "Ada@Example.COM"
	patch := models.SignupDraft{Username: &uname, Email: &email}

	mergeDraft(&base, &patch)

	if base.Username == nil || *base.Username != "ada" {
		t.Fatalf("username not normalized: %v", base.Username)
	}
	if base.Email == nil || *base.Email != "ada@example.com" {
		t.Fatalf("email not normalized: %v", base.Email)
	}
}

func TestRecomputeCompletedSteps_OrderedAndDeduped(t *testing.T) {
	strPtr := func(s string) *string { return &s }
	session := &models.SignupSession{
		IdentifierVerified: true,
		Draft: models.SignupDraft{
			DisplayName:  strPtr("Ada"),
			DateOfBirth:  strPtr("1815-12-10"),
			PasswordHash: strPtr("hash"),
		},
	}
	got := recomputeCompletedSteps(session)
	want := []string{stepIdentifier, stepOTP, stepName, stepDOB, stepPassword}
	if strings.Join([]string(got), ",") != strings.Join(want, ",") {
		t.Fatalf("recomputeCompletedSteps: got %v, want %v", got, want)
	}
}

func TestLooksLikeBcrypt(t *testing.T) {
	// 60-char $2b$ string. Hash bytes aren't real bcrypt — we only check shape.
	yes := "$2b$10$" + strings.Repeat("a", 53)
	if len(yes) != 60 {
		t.Fatalf("test fixture wrong length: %d", len(yes))
	}
	if !looksLikeBcrypt(yes) {
		t.Fatalf("expected bcrypt-shaped string to be detected")
	}
	if looksLikeBcrypt("plain-password-1234") {
		t.Fatalf("expected plain password to NOT be detected as bcrypt")
	}
	if looksLikeBcrypt("") {
		t.Fatalf("empty string should not be bcrypt")
	}
}
