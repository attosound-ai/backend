package validation

import "strings"

// NormalizeInmateNumber reduces an inmate number to the form used to tell two
// of them apart: upper case, only letters and digits (spaces, dashes and dots
// dropped) and no leading zeros. " 0123 456 " and "123456" are the same
// number. A number with nothing left after that ("", "000", "--") comes back
// empty, and an empty number is never compared.
//
// Nov 6 2026: Voss (voss203) left prison and signed up again as mr.voss225
// with the same number. The contest is only for people in prison, so one
// number may belong to one creator only, and the comparison must not be
// fooled by a space or a zero.
//
// The SQL in UserRepository.FindCreatorsByInmateNumber applies the same steps
// (upper, keep [A-Z0-9], ltrim '0'); keep both in step.
func NormalizeInmateNumber(raw string) string {
	var b strings.Builder
	b.Grow(len(raw))
	for _, r := range strings.ToUpper(raw) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return strings.TrimLeft(b.String(), "0")
}

// NormalizeInmateState reduces a state code to its comparable form ("ct " is
// "CT"). Empty means the state is not known.
func NormalizeInmateState(raw string) string {
	return strings.ToUpper(strings.TrimSpace(raw))
}

// SameInmateState says whether two states can name the same prison system. A
// state that is not known matches any state: the creators who signed up on
// their own before Nov 2026 were stored without one (voss203 among them), and
// treating "unknown" as "different" would let exactly that case through.
func SameInmateState(a, b string) bool {
	a, b = NormalizeInmateState(a), NormalizeInmateState(b)
	return a == "" || b == "" || a == b
}
