package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// SMS codes through Twilio Verify (Nov 12 2026).
//
// Codes sent with the Messages API from our own number stopped reaching the
// United States: the only A2P campaign of the account (2FA) has been FAILED
// since Mar 4 with error 30909, so carriers block or filter what that number
// sends. Verify sends from senders Twilio registered itself and needs no
// campaign of ours ("you can use Twilio Verify rather than registering for
// A2P 10DLC", Twilio's A2P 10DLC page).
//
// Verify makes the code and checks it (no custom code): that is the only mode
// where Fraud Guard protects the service and where Twilio bills a successful
// verification instead of every attempt.

// CheckResult is what Verify said about a code.
type CheckResult int

const (
	// CheckApproved: the code is the right one. Verify forgets the
	// verification right away, so the same code never works twice.
	CheckApproved CheckResult = iota
	// CheckWrongCode: the verification is still pending, the code was not it.
	CheckWrongCode
	// CheckGone: no pending verification for that number (expired after 10
	// minutes, already approved, or canceled).
	CheckGone
	// CheckTooManyAttempts: Verify's own limit of checks for that
	// verification (error 60202).
	CheckTooManyAttempts
)

// SMSVerifier sends a code by SMS and checks it, keeping the code itself.
type SMSVerifier interface {
	// Start sends a code to `to` (E.164) and returns the verification SID.
	Start(ctx context.Context, to, locale string) (string, error)
	// Check says whether `code` is the one sent to `to`.
	Check(ctx context.Context, to, code string) (CheckResult, error)
	// Cancel ends a pending verification so the next Start sends a new code.
	Cancel(ctx context.Context, verificationSID string) error
}

// VerifyError is a request to Verify that did not go through.
type VerifyError struct {
	Op         string // "start", "check" or "cancel"
	HTTPStatus int    // 0 when Twilio was not reached
	Code       int    // Twilio error code, 0 when there was none
	Message    string // Twilio's words, for the logs only
	Transport  error  // network failure, timeout, unreadable answer
}

// Error never carries Twilio's message: the handler picks the HTTP status
// from words like "invalid" or "expired", and those must come from us.
func (e *VerifyError) Error() string {
	if e.Transport != nil {
		return fmt.Sprintf("twilio verify %s: not reached", e.Op)
	}
	return fmt.Sprintf("twilio verify %s: HTTP %d, code %d", e.Op, e.HTTPStatus, e.Code)
}

func (e *VerifyError) Unwrap() error { return e.Transport }

// Unavailable says Verify could not do its job at all (down, unreachable,
// wrong credentials or service SID, account throttled), as opposed to a
// refusal about this number (fraud, geo permissions, a landline, too many
// codes). Only an unavailable Verify may fall back to the old provider:
// sending through our own number what Fraud Guard just blocked would undo it.
func (e *VerifyError) Unavailable() bool {
	switch {
	case e.Transport != nil:
		return true
	case e.HTTPStatus >= 500:
		return true
	case e.HTTPStatus == http.StatusUnauthorized, e.Code == 20003:
		return true
	case e.Code == 20429: // too many requests to the API, not to this number
		return true
	case e.Op == "start" && e.HTTPStatus == http.StatusNotFound:
		return true // the service SID does not exist
	}
	return false
}

// TooManySends says Verify refused because the number asked for too many
// codes (60203: max send attempts; 60212: concurrent requests).
func (e *VerifyError) TooManySends() bool {
	return e.Code == 60203 || e.Code == 60212
}

// IsUnavailable reports whether err is a VerifyError for which Verify was unavailable.
func IsUnavailable(err error) bool {
	var ve *VerifyError
	return errors.As(err, &ve) && ve.Unavailable()
}

// TwilioVerify talks to the Verify v2 API.
type TwilioVerify struct {
	// BaseURL is https://verify.twilio.com/v2; tests point it at a fake.
	BaseURL    string
	accountSID string
	authToken  string
	serviceSID string
	httpClient *http.Client
}

// NewTwilioVerify creates a client for one Verify service (VA...).
func NewTwilioVerify(accountSID, authToken, serviceSID string) *TwilioVerify {
	return &TwilioVerify{
		BaseURL:    "https://verify.twilio.com/v2",
		accountSID: accountSID,
		authToken:  authToken,
		serviceSID: serviceSID,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// VerifyLocale turns the app's language (en, es, pt-BR) into a Verify locale.
// Anything else is left out, and Verify then picks the language from the
// country of the number.
func VerifyLocale(locale string) string {
	l := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(locale, "_", "-")))
	switch {
	case l == "":
		return ""
	case l == "pt" || l == "pt-br":
		return "pt-BR"
	case strings.HasPrefix(l, "pt-"):
		return "pt"
	case l == "es" || strings.HasPrefix(l, "es-"):
		return "es"
	case l == "en" || strings.HasPrefix(l, "en-"):
		return "en"
	}
	return ""
}

type verifyAnswer struct {
	SID    string `json:"sid"`
	Status string `json:"status"`
}

// Start sends a code by SMS. Within the 10 minutes of a pending verification
// Verify sends the same code again rather than a new one.
func (v *TwilioVerify) Start(ctx context.Context, to, locale string) (string, error) {
	form := url.Values{}
	form.Set("To", to)
	form.Set("Channel", "sms")
	form.Set("RiskCheck", "enable") // Fraud Guard, stated even though it is the default
	if l := VerifyLocale(locale); l != "" {
		form.Set("Locale", l)
	}
	began := time.Now()
	var answer verifyAnswer
	err := v.post(ctx, "start", "/Services/"+v.serviceSID+"/Verifications", form, &answer)
	if err != nil {
		log.Printf("[VERIFY] start to %s failed in %d ms: %s", MaskPhone(to), time.Since(began).Milliseconds(), describe(err))
		return "", err
	}
	log.Printf("[VERIFY] start to %s ok in %d ms (sid %s, status %s, locale %q)", MaskPhone(to), time.Since(began).Milliseconds(), answer.SID, answer.Status, form.Get("Locale"))
	return answer.SID, nil
}

// Check asks Verify whether code is the one it sent to `to`.
func (v *TwilioVerify) Check(ctx context.Context, to, code string) (CheckResult, error) {
	form := url.Values{}
	form.Set("To", to)
	form.Set("Code", code)
	began := time.Now()
	var answer verifyAnswer
	err := v.post(ctx, "check", "/Services/"+v.serviceSID+"/VerificationCheck", form, &answer)
	ms := time.Since(began).Milliseconds()
	if err != nil {
		var ve *VerifyError
		if errors.As(err, &ve) && ve.Transport == nil {
			switch {
			case ve.HTTPStatus == http.StatusNotFound:
				log.Printf("[VERIFY] check for %s: no pending verification (%d ms)", MaskPhone(to), ms)
				return CheckGone, nil
			case ve.Code == 60202:
				log.Printf("[VERIFY] check for %s: Verify's attempt limit reached (%d ms)", MaskPhone(to), ms)
				return CheckTooManyAttempts, nil
			}
		}
		log.Printf("[VERIFY] check for %s failed in %d ms: %s", MaskPhone(to), ms, describe(err))
		return CheckGone, err
	}
	log.Printf("[VERIFY] check for %s: %s (%d ms)", MaskPhone(to), answer.Status, ms)
	switch answer.Status {
	case "approved":
		return CheckApproved, nil
	case "pending":
		return CheckWrongCode, nil
	case "max_attempts_reached":
		return CheckTooManyAttempts, nil
	default: // canceled, expired, deleted, failed
		return CheckGone, nil
	}
}

// Cancel ends a pending verification.
func (v *TwilioVerify) Cancel(ctx context.Context, verificationSID string) error {
	form := url.Values{}
	form.Set("Status", "canceled")
	err := v.post(ctx, "cancel", "/Services/"+v.serviceSID+"/Verifications/"+url.PathEscape(verificationSID), form, nil)
	var ve *VerifyError
	if errors.As(err, &ve) && ve.HTTPStatus == http.StatusNotFound {
		return nil // already over: nothing left to cancel
	}
	if err != nil {
		log.Printf("[VERIFY] cancel %s failed: %s", verificationSID, describe(err))
	}
	return err
}

func (v *TwilioVerify) post(ctx context.Context, op, path string, form url.Values, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(v.BaseURL, "/")+path, strings.NewReader(form.Encode()))
	if err != nil {
		return &VerifyError{Op: op, Transport: err}
	}
	req.SetBasicAuth(v.accountSID, v.authToken)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := v.httpClient.Do(req)
	if err != nil {
		return &VerifyError{Op: op, Transport: err}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return &VerifyError{Op: op, HTTPStatus: resp.StatusCode, Transport: err}
	}

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var twErr struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(body, &twErr)
		return &VerifyError{Op: op, HTTPStatus: resp.StatusCode, Code: twErr.Code, Message: twErr.Message}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return &VerifyError{Op: op, HTTPStatus: resp.StatusCode, Transport: fmt.Errorf("unreadable answer: %w", err)}
	}
	return nil
}

// describe is an error for the logs, with Twilio's message when it gave one.
func describe(err error) string {
	var ve *VerifyError
	if errors.As(err, &ve) {
		switch {
		case ve.Transport != nil:
			return fmt.Sprintf("%s (%v)", ve.Error(), ve.Transport)
		case ve.Message != "":
			return fmt.Sprintf("%s: %s", ve.Error(), ve.Message)
		}
	}
	return err.Error()
}

// MaskPhone keeps the country and the last two digits: +1********43.
func MaskPhone(phone string) string {
	if len(phone) <= 5 {
		return phone
	}
	cc := 2
	if !strings.HasPrefix(phone, "+1") {
		cc = 3
	}
	return phone[:cc] + strings.Repeat("*", len(phone)-cc-2) + phone[len(phone)-2:]
}
