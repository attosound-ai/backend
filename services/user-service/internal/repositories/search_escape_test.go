package repositories

import (
	"strings"
	"testing"
)

// q=_ (any one character) or q=% matched every account until Nov 12 2026.
func TestSearchUsersEscapesWildcards(t *testing.T) {
	for _, tc := range []struct{ q, want string }{
		{"_", `'%\_%'`},
		{"%", `'%\%%'`},
		{`a\b`, `'%a\\b%'`},
		{"a_b%c", `'%a\_b\%c%'`},
	} {
		repo, capture := dryRunRepo(t)
		if _, err := repo.SearchUsers(tc.q, 20); err != nil {
			t.Fatalf("search %q: %v", tc.q, err)
		}
		q := strings.Join(capture.sql, "\n")
		if !strings.Contains(q, tc.want) {
			t.Errorf("q=%q: pattern %s not in %s", tc.q, tc.want, q)
		}
		if strings.Count(q, `ESCAPE '\'`) < 2 {
			t.Errorf("q=%q: ILIKE without ESCAPE: %s", tc.q, q)
		}
	}
}

func TestSearchUsersNeverAnswersMoreThanTwenty(t *testing.T) {
	for _, limit := range []int{0, -1, 21, 100, 5000} {
		repo, capture := dryRunRepo(t)
		if _, err := repo.SearchUsers("ab", limit); err != nil {
			t.Fatal(err)
		}
		q := strings.Join(capture.sql, "\n")
		if !strings.Contains(q, "LIMIT 20") {
			t.Errorf("limit %d: %s", limit, q)
		}
	}
}

func TestSearchUsersPutsTheExactUsernameFirst(t *testing.T) {
	repo, capture := dryRunRepo(t)
	if _, err := repo.SearchUsers("attosound", 20); err != nil {
		t.Fatal(err)
	}
	q := strings.Join(capture.sql, "\n")
	if !strings.Contains(q, "ORDER BY LOWER(username) = LOWER('attosound') DESC") {
		t.Errorf("exact match is not ordered first: %s", q)
	}
}

func TestFindByUsernameInsensitiveIsAnExactMatch(t *testing.T) {
	repo, capture := dryRunRepo(t)
	if _, err := repo.FindByUsernameInsensitive("Atto_Sound%"); err != nil {
		t.Fatal(err)
	}
	q := strings.ToLower(strings.Join(capture.sql, "\n"))
	if strings.Contains(q, "like") || !strings.Contains(q, "lower(username) = lower('atto_sound%')") || !strings.Contains(q, "limit 1") {
		t.Errorf("not an exact single row match: %s", q)
	}
}
