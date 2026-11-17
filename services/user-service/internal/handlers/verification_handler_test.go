package handlers

import "testing"

func TestSkipVerificationSend(t *testing.T) {
	cases := []struct {
		name, role, phone, want string
	}{
		{"representative with a real number sends", "representative", "+18607350378", ""},
		{"creator never verifies", "creator", "+18607350378", "role_creator_does_not_verify"},
		{"listener never verifies", "listener", "+18607350378", "role_listener_does_not_verify"},
		{"empty role never verifies", "", "+18607350378", "role__does_not_verify"},
		{"placeholder number cannot receive SMS", "representative", "+15005551345", "placeholder_bridge_number"},
		{"role is checked before the number", "creator", "+15005551345", "role_creator_does_not_verify"},
	}
	for _, c := range cases {
		if got := skipVerificationSend(c.role, c.phone); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
