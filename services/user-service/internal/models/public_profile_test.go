package models

import (
	"encoding/json"
	"reflect"
	"sort"
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
		FollowersCount: 20, IsManagedAccount: true,
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
	var keys map[string]any
	_ = json.Unmarshal(raw, &keys)
	for _, k := range privateKeys {
		if _, ok := keys[k]; ok {
			t.Errorf("public profile still has the key %q (even empty it says the field exists): %s", k, body)
		}
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

// Every key a stranger may receive. Adding a field to PublicProfile has to
// change this list too, on purpose (Nov 12 2026).
var publicKeys = []string{
	"avatar", "bio", "bookingEmail", "createdAt", "creatorGenres", "creatorTypes", "displayName",
	"followersCount", "followingCount", "id", "location", "postsCount", "profileVerified",
	"recordLabel", "role", "socialInstagram", "socialSoundcloud", "socialSpotify", "socialTiktok",
	"socialTwitter", "socialYoutube", "username", "website",
}

var privateKeys = []string{
	"email", "phoneNumber", "phoneCountryCode", "dateOfBirth", "inmateNumber", "inmateState",
	"consentToRecording", "twoFactorEnabled", "twoFactorMethod", "isManagedAccount",
	"representativeId", "creatorName", "relationship", "creatorEmail", "creatorPhone",
}

func TestPublicProfileCarriesOnlyTheAllowedKeys(t *testing.T) {
	s := strp("x")
	full := &UserProfile{
		ID: 1, Username: "u", DisplayName: "u", Avatar: s, Bio: s, Role: "creator",
		CreatorTypes: []string{"rapper"}, CreatorGenres: []string{"rap"}, ProfileVerified: true,
		SocialInstagram: s, SocialTiktok: s, SocialYoutube: s, SocialSoundcloud: s, SocialSpotify: s,
		SocialTwitter: s, Website: s, Location: s, RecordLabel: s, BookingEmail: s,
		FollowersCount: 1, FollowingCount: 1, PostsCount: 1, CreatedAt: "2026-11-12T00:00:00Z",
		Email: "e@example.com", PhoneNumber: s, PhoneCountryCode: s, DateOfBirth: s, InmateNumber: s,
		InmateState: s, ConsentToRecording: new(bool), TwoFactorEnabled: true, TwoFactorMethod: "sms",
		IsManagedAccount: true, CreatorName: s, Relationship: s, CreatorEmail: s, CreatorPhone: s,
	}
	raw, _ := json.Marshal(full.Public())
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	got := make([]string, 0, len(m))
	for k := range m {
		got = append(got, k)
	}
	sort.Strings(got)
	if !reflect.DeepEqual(got, publicKeys) {
		t.Errorf("public keys changed:\n got  %v\n want %v", got, publicKeys)
	}
}
