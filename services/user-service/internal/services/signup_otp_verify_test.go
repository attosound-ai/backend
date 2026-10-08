package services

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/atto-sound/user-service/internal/models"
)

// otpServiceAnswering stands in for the OTP service with one fixed answer.
func otpServiceAnswering(t *testing.T, status int, body string) *SignupService {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/otp/verify" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return &SignupService{otpServiceURL: srv.URL, httpClient: &http.Client{Timeout: 2 * time.Second}}
}

// A mistyped code used to travel as a plain error that no sentinel matched,
// so the handler answered 500 and the server error alarm fired (Oct 7 2026,
// four times in six minutes for one person signing up).
func TestVerifyOTP_WrongCodeIsAnInvalidCodeWithTheServiceWords(t *testing.T) {
	svc := otpServiceAnswering(t, http.StatusBadRequest, `{"success":false,"error":"invalid code, 4 attempts remaining"}`)

	err := svc.verifyOTP("someone@example.com", models.IdentifierEmail, "000000")

	if !errors.Is(err, ErrInvalidOTP) {
		t.Fatalf("a wrong code must be ErrInvalidOTP for the handler, got %v", err)
	}
	if err.Error() != "invalid code, 4 attempts remaining" {
		t.Fatalf("the app shows these words, they must arrive untouched: %q", err.Error())
	}
	if errors.Is(err, ErrOTPUnavailable) {
		t.Fatal("a wrong code is not an outage")
	}
}

func TestVerifyOTP_EveryRefusalOfTheServiceIsAnInvalidCode(t *testing.T) {
	for _, words := range []string{
		"maximum verification attempts exceeded",
		"too many failed attempts, try again later",
		"no verification code found, request a new one",
	} {
		svc := otpServiceAnswering(t, http.StatusBadRequest, `{"success":false,"error":"`+words+`"}`)
		err := svc.verifyOTP("+18605550100", models.IdentifierPhone, "123456")
		if !errors.Is(err, ErrInvalidOTP) || err.Error() != words {
			t.Fatalf("%q: got %v", words, err)
		}
	}
}

func TestVerifyOTP_RefusalWithoutWordsIsStillAnInvalidCode(t *testing.T) {
	svc := otpServiceAnswering(t, http.StatusBadRequest, `{}`)
	if err := svc.verifyOTP("someone@example.com", models.IdentifierEmail, "000000"); err != ErrInvalidOTP {
		t.Fatalf("got %v", err)
	}
}

func TestVerifyOTP_RightCodePasses(t *testing.T) {
	svc := otpServiceAnswering(t, http.StatusOK, `{"success":true}`)
	if err := svc.verifyOTP("someone@example.com", models.IdentifierEmail, "123456"); err != nil {
		t.Fatalf("got %v", err)
	}
}

// When the OTP service is the one failing, nothing is known about the code:
// the person must not read "invalid code" for a code that may be right.
func TestVerifyOTP_ServiceFailureIsNotAWrongCode(t *testing.T) {
	for _, status := range []int{http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable} {
		svc := otpServiceAnswering(t, status, `{"success":false,"error":"redis: connection refused"}`)
		err := svc.verifyOTP("someone@example.com", models.IdentifierEmail, "123456")
		if !errors.Is(err, ErrOTPUnavailable) || errors.Is(err, ErrInvalidOTP) {
			t.Fatalf("status %d: got %v", status, err)
		}
	}
}

func TestVerifyOTP_UnreachableServiceIsNotAWrongCode(t *testing.T) {
	svc := otpServiceAnswering(t, http.StatusOK, `{}`)
	svc.otpServiceURL = "http://127.0.0.1:1" // nothing listens there
	err := svc.verifyOTP("someone@example.com", models.IdentifierEmail, "123456")
	if !errors.Is(err, ErrOTPUnavailable) || errors.Is(err, ErrInvalidOTP) {
		t.Fatalf("got %v", err)
	}
}
