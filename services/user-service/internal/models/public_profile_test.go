package models

import (
	"encoding/json"
	"strings"
	"testing"
)

func strp(s string) *string { return &s }

func TestPublicProfileDropsPrivateFields(t *testing.T) {
	rep := uint64(152)
	consent := true
	full := &UserProfile{
		ID: 153, Username: "suicideking", DisplayName: "Suicide King", Role: "creator",
		Email: "x@example.com", PhoneNumber: strp("5550100"), PhoneCountryCode: strp("+1"),
		InmateNumber: strp("123456"), InmateState: strp("CT"), CreatorName: strp("Real Name"),
		Relationship: strp("brother"), ConsentToRecording: &consent, CreatorEmail: strp("c@example.com"),
		CreatorPhone: strp("5550101"), DateOfBirth: strp("1990-01-01"), TwoFactorEnabled: true,
		TwoFactorMethod: "email", RepresentativeID: &rep, Bio: strp("bio"), BookingEmail: strp("book@example.com"),
		FollowersCount: 20,
	}
	pub := full.Public()
	raw, _ := json.Marshal(pub)
	body := string(raw)
	for _, leak := range []string{"x@example.com", "5550100", "123456", "\"CT\"", "Real Name", "brother",
		"consentToRecording", "c@example.com", "5550101", "1990-01-01", "representativeId", "\"email\":\"email\""} {
		if strings.Contains(body, leak) {
			t.Errorf("public profile still carries %s: %s", leak, body)
		}
	}
	if pub.Username != "suicideking" || pub.Role != "creator" || pub.Bio == nil || pub.BookingEmail == nil || pub.FollowersCount != 20 {
		t.Errorf("public profile lost a public field: %+v", pub)
	}
	if full.InmateNumber == nil || full.Email == "" {
		t.Error("Public must not change the original profile")
	}
}

func TestPublicProfileNil(t *testing.T) {
	var p *UserProfile
	if p.Public() != nil {
		t.Error("nil stays nil")
	}
}
