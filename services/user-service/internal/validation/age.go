package validation

import (
	"errors"
	"time"
)

// ParseAndValidateDOB parses "YYYY-MM-DD" and validates age >= 18.
func ParseAndValidateDOB(dobStr string) (time.Time, error) {
	dob, err := time.Parse("2006-01-02", dobStr)
	if err != nil {
		return time.Time{}, errors.New("invalid date format, expected YYYY-MM-DD")
	}

	now := time.Now().UTC()
	age := now.Year() - dob.Year()
	if now.Month() < dob.Month() || (now.Month() == dob.Month() && now.Day() < dob.Day()) {
		age--
	}

	if age < 18 {
		return time.Time{}, errors.New("must be at least 18 years old")
	}

	return dob, nil
}
