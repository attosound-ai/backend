package validation

import "testing"

func TestNormalizeInmateNumber(t *testing.T) {
	cases := []struct{ in, want string }{
		{"334658", "334658"},
		{" 334658 ", "334658"},
		{"334 658", "334658"},
		{"0334658", "334658"},
		{"000334658", "334658"},
		{"33-46.58", "334658"},
		{"a12345", "A12345"},
		{" A 12345", "A12345"},
		{"\t0a12345\n", "A12345"},
		{"A012345", "A012345"}, // only LEADING zeros go
		{"3346580", "3346580"},
		{"", ""},
		{"   ", ""},
		{"000", ""},
		{"--", ""},
	}
	for _, tc := range cases {
		if got := NormalizeInmateNumber(tc.in); got != tc.want {
			t.Errorf("NormalizeInmateNumber(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestNormalizeInmateNumber_SameNumberWrittenDifferently(t *testing.T) {
	forms := []string{"0123456", "123456", " 123 456 ", "123-456", "00123456"}
	for _, f := range forms {
		if NormalizeInmateNumber(f) != NormalizeInmateNumber(forms[0]) {
			t.Errorf("%q and %q must be the same number", f, forms[0])
		}
	}
	if NormalizeInmateNumber("123456") == NormalizeInmateNumber("1234560") {
		t.Error("a trailing zero changes the number")
	}
}

func TestSameInmateState(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"CT", "CT", true},
		{"ct", " CT ", true},
		{"CT", "NY", false},
		{"", "CT", true}, // unknown state matches any (old self registered creators)
		{"CT", "", true},
		{"", "", true},
		{"  ", "NY", true},
	}
	for _, tc := range cases {
		if got := SameInmateState(tc.a, tc.b); got != tc.want {
			t.Errorf("SameInmateState(%q, %q) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}
