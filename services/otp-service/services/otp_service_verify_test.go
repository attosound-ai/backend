package services

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/atto-sound/otp-service/config"
	"github.com/atto-sound/otp-service/providers"
)

// SMS codes through Twilio Verify (Nov 12 2026), against a fake of the Verify
// v2 API that keeps one pending verification per number the way Twilio does:
// the same code again on a resend within its life, gone once approved,
// canceled or expired, and its own limit of five checks.

type pendingVerification struct {
	sid    string
	code   string
	checks int
}

type fakeVerifyAPI struct {
	mu       sync.Mutex
	srv      *httptest.Server
	pending  map[string]*pendingVerification // by number
	next     int
	down     bool // answers 503 to everything
	refuse   int  // Twilio error code to answer on start (60410, 60203...)
	starts   int  // verifications asked for
	locales  []string
	canceled []string
}

func newFakeVerifyAPI(t *testing.T) *fakeVerifyAPI {
	t.Helper()
	f := &fakeVerifyAPI{pending: map[string]*pendingVerification{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeVerifyAPI) client() *providers.TwilioVerify {
	v := providers.NewTwilioVerify("ACtest", "secret", "VAtest")
	v.BaseURL = f.srv.URL
	return v
}

func answer(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func (f *fakeVerifyAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if user, pass, ok := r.BasicAuth(); !ok || user != "ACtest" || pass != "secret" {
		answer(w, 401, `{"code":20003,"status":401}`)
		return
	}
	if f.down {
		answer(w, 503, `{"code":20500,"message":"Service Unavailable","status":503}`)
		return
	}
	_ = r.ParseForm()
	to := r.PostForm.Get("To")
	switch {
	case r.URL.Path == "/Services/VAtest/Verifications":
		if f.refuse != 0 {
			status := 403
			if f.refuse == 60203 {
				status = 429
			}
			answer(w, status, fmt.Sprintf(`{"code":%d,"message":"refused","status":%d}`, f.refuse, status))
			return
		}
		f.starts++
		f.locales = append(f.locales, r.PostForm.Get("Locale"))
		p := f.pending[to]
		if p == nil {
			f.next++
			p = &pendingVerification{sid: fmt.Sprintf("VE%04d", f.next), code: fmt.Sprintf("%06d", 135790+f.next)}
			f.pending[to] = p
		}
		answer(w, 201, fmt.Sprintf(`{"sid":%q,"status":"pending","channel":"sms"}`, p.sid))
	case r.URL.Path == "/Services/VAtest/VerificationCheck":
		p := f.pending[to]
		if p == nil {
			answer(w, 404, `{"code":20404,"message":"not found","status":404}`)
			return
		}
		p.checks++
		if p.checks > 5 {
			delete(f.pending, to)
			answer(w, 429, `{"code":60202,"message":"Max check attempts reached","status":429}`)
			return
		}
		if r.PostForm.Get("Code") == p.code {
			delete(f.pending, to)
			answer(w, 200, `{"status":"approved","valid":true}`)
			return
		}
		answer(w, 200, `{"status":"pending","valid":false}`)
	case strings.HasPrefix(r.URL.Path, "/Services/VAtest/Verifications/"):
		sid := strings.TrimPrefix(r.URL.Path, "/Services/VAtest/Verifications/")
		for number, p := range f.pending {
			if p.sid == sid && r.PostForm.Get("Status") == "canceled" {
				delete(f.pending, number)
				f.canceled = append(f.canceled, sid)
				answer(w, 200, `{"status":"canceled"}`)
				return
			}
		}
		answer(w, 404, `{"code":20404,"status":404}`)
	default:
		answer(w, 404, `{"code":20404,"status":404}`)
	}
}

// codeFor is what the person reads on the phone.
func (f *fakeVerifyAPI) codeFor(t *testing.T, number string) string {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	p := f.pending[number]
	if p == nil {
		t.Fatalf("Verify has no code waiting for %s", number)
	}
	return p.code
}

// expire is Twilio forgetting the verification after its 10 minutes.
func (f *fakeVerifyAPI) expire(number string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.pending, number)
}

// production with Verify on: the settings to put on Railway.
func productionWithVerify(t *testing.T) *config.Config {
	t.Helper()
	production(t) // BYPASS_OTP=true and real delivery on Railway, as found on Oct 7
	t.Setenv("OTP_SMS_PROVIDER", "verify")
	t.Setenv("TWILIO_VERIFY_SERVICE_SID", "VAtest")
	t.Setenv("TWILIO_ACCOUNT_SID", "ACtest")
	t.Setenv("TWILIO_AUTH_TOKEN", "secret")
	t.Setenv("OTP_SKIP_SEND_LIMITS", "false")
	cfg := config.Load()
	if ready, why := cfg.VerifyReady(); !ready {
		t.Fatalf("Verify not ready: %s", why)
	}
	if cfg.BypassOTP {
		t.Fatalf("the fixed code must stay refused with Verify on")
	}
	return cfg
}

func TestVerifySendsAndChecksTheCode(t *testing.T) {
	ctx := context.Background()
	api := newFakeVerifyAPI(t)
	old := &inbox{}
	svc := NewOTPService(productionWithVerify(t), testRedis(t), old, &inbox{}).WithSMSVerifier(api.client(), false)

	if err := svc.SendOTP(ctx, phone, "", "pt-BR", "", "10.0.0.1"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if api.starts != 1 || api.locales[0] != "pt-BR" {
		t.Fatalf("Verify starts %d, locales %v", api.starts, api.locales)
	}
	if len(old.messages) != 0 {
		t.Fatalf("the old number sent too: %v", old.messages)
	}
	code := api.codeFor(t, phone)

	// A wrong code, with the same words as before.
	err := svc.VerifyCode(ctx, phone, wrongCode(code))
	if err == nil || err.Error() != "invalid code, 4 attempts remaining" {
		t.Fatalf("wrong code: %v", err)
	}
	// The right one.
	if err := svc.VerifyCode(ctx, phone, code); err != nil {
		t.Fatalf("right code refused: %v", err)
	}
	// Good once.
	if err := svc.VerifyCode(ctx, phone, code); err == nil || err.Error() != "invalid or expired code" {
		t.Fatalf("the same code twice: %v", err)
	}
	// "000000" means nothing here.
	if err := svc.VerifyCode(ctx, phone, "000000"); err == nil {
		t.Fatalf("000000 was accepted")
	}
}

func TestVerifyExpiredCode(t *testing.T) {
	ctx := context.Background()

	t.Run("Twilio forgot it (its 10 minutes)", func(t *testing.T) {
		api := newFakeVerifyAPI(t)
		svc := NewOTPService(productionWithVerify(t), testRedis(t), &inbox{}, &inbox{}).WithSMSVerifier(api.client(), false)
		if err := svc.SendOTP(ctx, phone, "", "en", "", "10.0.0.1"); err != nil {
			t.Fatalf("send: %v", err)
		}
		code := api.codeFor(t, phone)
		api.expire(phone)
		if err := svc.VerifyCode(ctx, phone, code); err == nil || err.Error() != "invalid or expired code" {
			t.Fatalf("expired code: %v", err)
		}
	})

	t.Run("our own expiry (OTP_EXPIRY_SECONDS)", func(t *testing.T) {
		api := newFakeVerifyAPI(t)
		cfg := productionWithVerify(t)
		cfg.OTPExpiry = time.Second
		svc := NewOTPService(cfg, testRedis(t), &inbox{}, &inbox{}).WithSMSVerifier(api.client(), false)
		if err := svc.SendOTP(ctx, phone, "", "en", "", "10.0.0.1"); err != nil {
			t.Fatalf("send: %v", err)
		}
		code := api.codeFor(t, phone)
		time.Sleep(1200 * time.Millisecond)
		if err := svc.VerifyCode(ctx, phone, code); err == nil || err.Error() != "invalid or expired code" {
			t.Fatalf("expired code: %v", err)
		}
	})
}

func TestVerifyWrongCodesRunOut(t *testing.T) {
	ctx := context.Background()
	api := newFakeVerifyAPI(t)
	cfg := productionWithVerify(t)
	svc := NewOTPService(cfg, testRedis(t), &inbox{}, &inbox{}).WithSMSVerifier(api.client(), false)
	if err := svc.SendOTP(ctx, phone, "", "es", "", "10.0.0.1"); err != nil {
		t.Fatalf("send: %v", err)
	}
	code := api.codeFor(t, phone)

	var last error
	for i := 0; i < cfg.MaxConsecFailures; i++ {
		last = svc.VerifyCode(ctx, phone, wrongCode(code))
		if last == nil {
			t.Fatalf("wrong code %d accepted", i+1)
		}
	}
	if last.Error() != errBlocked {
		t.Fatalf("after %d wrong codes: %v", cfg.MaxConsecFailures, last)
	}
	// Blocked means blocked, even with the right code.
	if err := svc.VerifyCode(ctx, phone, code); err == nil || err.Error() != errBlocked {
		t.Fatalf("right code while blocked: %v", err)
	}
	// And the verification was canceled at Twilio, so the next code is a new one.
	if len(api.canceled) != 1 {
		t.Fatalf("verification not canceled at Twilio: %v", api.canceled)
	}
}

func TestVerifyAttemptLimitPerCode(t *testing.T) {
	ctx := context.Background()
	api := newFakeVerifyAPI(t)
	cfg := productionWithVerify(t)
	cfg.MaxConsecFailures = 100 // only the per code limit (MAX_ATTEMPTS) in play
	svc := NewOTPService(cfg, testRedis(t), &inbox{}, &inbox{}).WithSMSVerifier(api.client(), false)
	if err := svc.SendOTP(ctx, phone, "", "en", "", "10.0.0.1"); err != nil {
		t.Fatalf("send: %v", err)
	}
	code := api.codeFor(t, phone)
	for i := 1; i < cfg.MaxAttempts; i++ {
		want := fmt.Sprintf("invalid code, %d attempts remaining", cfg.MaxAttempts-i)
		if err := svc.VerifyCode(ctx, phone, wrongCode(code)); err == nil || err.Error() != want {
			t.Fatalf("wrong code %d: %v, want %q", i, err, want)
		}
	}
	if err := svc.VerifyCode(ctx, phone, wrongCode(code)); err == nil || err.Error() != "maximum verification attempts exceeded" {
		t.Fatalf("last wrong code: %v", err)
	}
	if err := svc.VerifyCode(ctx, phone, code); err == nil || err.Error() != "invalid or expired code" {
		t.Fatalf("right code after the limit: %v", err)
	}
	if len(api.canceled) != 1 {
		t.Fatalf("verification not canceled at Twilio: %v", api.canceled)
	}

	t.Run("Verify's own limit reads the same", func(t *testing.T) {
		api := newFakeVerifyAPI(t)
		cfg := productionWithVerify(t)
		cfg.MaxConsecFailures, cfg.MaxAttempts = 100, 100
		svc := NewOTPService(cfg, testRedis(t), &inbox{}, &inbox{}).WithSMSVerifier(api.client(), false)
		if err := svc.SendOTP(ctx, phone, "", "en", "", "10.0.0.1"); err != nil {
			t.Fatalf("send: %v", err)
		}
		code := api.codeFor(t, phone)
		for i := 0; i < 5; i++ {
			_ = svc.VerifyCode(ctx, phone, wrongCode(code))
		}
		if err := svc.VerifyCode(ctx, phone, code); err == nil || err.Error() != "maximum verification attempts exceeded" {
			t.Fatalf("sixth check: %v", err)
		}
	})
}

func TestVerifyDownFallsBackOnlyWhenAskedTo(t *testing.T) {
	ctx := context.Background()

	t.Run("OTP_SMS_FALLBACK=messages: the old number sends our own code", func(t *testing.T) {
		api := newFakeVerifyAPI(t)
		api.down = true
		t.Setenv("OTP_SMS_FALLBACK", "messages")
		cfg := productionWithVerify(t)
		if cfg.SMSFallback != config.SMSFallbackMessages {
			t.Fatalf("fallback %q", cfg.SMSFallback)
		}
		old := &inbox{}
		svc := NewOTPService(cfg, testRedis(t), old, &inbox{}).WithSMSVerifier(api.client(), true)
		if err := svc.SendOTP(ctx, phone, "", "en", "", "10.0.0.1"); err != nil {
			t.Fatalf("send with Verify down: %v", err)
		}
		code := old.lastCode(t, phone)
		// Verify is still down: the code is ours and is checked here.
		if err := svc.VerifyCode(ctx, phone, code); err != nil {
			t.Fatalf("fallback code refused: %v", err)
		}
	})

	t.Run("no fallback: the send fails as a failure (500), as before", func(t *testing.T) {
		api := newFakeVerifyAPI(t)
		api.down = true
		old := &inbox{}
		svc := NewOTPService(productionWithVerify(t), testRedis(t), old, &inbox{}).WithSMSVerifier(api.client(), false)
		err := svc.SendOTP(ctx, phone, "", "en", "", "10.0.0.1")
		if err == nil || !strings.HasPrefix(err.Error(), "failed to send OTP") {
			t.Fatalf("send with Verify down: %v", err)
		}
		if len(old.messages) != 0 {
			t.Fatalf("the old number sent without being asked to")
		}
	})

	t.Run("Fraud Guard refusing a number never falls back", func(t *testing.T) {
		api := newFakeVerifyAPI(t)
		api.refuse = 60410
		old := &inbox{}
		svc := NewOTPService(productionWithVerify(t), testRedis(t), old, &inbox{}).WithSMSVerifier(api.client(), true)
		err := svc.SendOTP(ctx, phone, "", "en", "", "10.0.0.1")
		if err == nil || !strings.HasPrefix(err.Error(), "failed to send OTP") {
			t.Fatalf("send refused by Fraud Guard: %v", err)
		}
		if len(old.messages) != 0 {
			t.Fatalf("the old number sent what Fraud Guard blocked")
		}
	})

	t.Run("a check with Verify down is not counted as a wrong code", func(t *testing.T) {
		api := newFakeVerifyAPI(t)
		cfg := productionWithVerify(t)
		svc := NewOTPService(cfg, testRedis(t), &inbox{}, &inbox{}).WithSMSVerifier(api.client(), true)
		if err := svc.SendOTP(ctx, phone, "", "en", "", "10.0.0.1"); err != nil {
			t.Fatalf("send: %v", err)
		}
		code := api.codeFor(t, phone)
		api.down = true
		for i := 0; i < cfg.MaxConsecFailures+1; i++ {
			err := svc.VerifyCode(ctx, phone, code)
			if err == nil || strings.Contains(err.Error(), "invalid") || strings.Contains(err.Error(), "blocked") || strings.Contains(err.Error(), "maximum") {
				t.Fatalf("check %d with Verify down: %v (must read as a failure, not a refusal)", i+1, err)
			}
		}
		api.down = false
		if err := svc.VerifyCode(ctx, phone, code); err != nil {
			t.Fatalf("right code once Verify is back: %v", err)
		}
	})
}

func TestVerifyKeepsTheSendLimits(t *testing.T) {
	ctx := context.Background()

	t.Run("our wait between two codes", func(t *testing.T) {
		api := newFakeVerifyAPI(t)
		svc := NewOTPService(productionWithVerify(t), testRedis(t), &inbox{}, &inbox{}).WithSMSVerifier(api.client(), false)
		if err := svc.SendOTP(ctx, phone, "", "en", "", "10.0.0.1"); err != nil {
			t.Fatalf("first send: %v", err)
		}
		err := svc.SendOTP(ctx, phone, "", "en", "", "10.0.0.1")
		if err == nil || !strings.Contains(err.Error(), "rate limited") {
			t.Fatalf("second code within the minute: %v", err)
		}
		if api.starts != 1 {
			t.Fatalf("Verify was asked %d times", api.starts)
		}
	})

	t.Run("Verify's own limit reads as ours (429)", func(t *testing.T) {
		api := newFakeVerifyAPI(t)
		api.refuse = 60203
		svc := NewOTPService(productionWithVerify(t), testRedis(t), &inbox{}, &inbox{}).WithSMSVerifier(api.client(), true)
		err := svc.SendOTP(ctx, phone, "", "en", "", "10.0.0.1")
		if err == nil || !strings.HasPrefix(err.Error(), "rate limited") {
			t.Fatalf("Verify's max send attempts: %v", err)
		}
	})
}

func TestVerifyLeavesEmailAndOldCodesAlone(t *testing.T) {
	ctx := context.Background()

	t.Run("email only: our code, by email, Verify untouched", func(t *testing.T) {
		api := newFakeVerifyAPI(t)
		email := &inbox{}
		svc := NewOTPService(productionWithVerify(t), testRedis(t), &inbox{}, email).WithSMSVerifier(api.client(), false)
		if err := svc.SendOTP(ctx, "", mail, "es", "", "10.0.0.1"); err != nil {
			t.Fatalf("send: %v", err)
		}
		if err := svc.VerifyCode(ctx, mail, email.lastCode(t, mail)); err != nil {
			t.Fatalf("email code: %v", err)
		}
		if api.starts != 0 {
			t.Fatalf("Verify was used for an email")
		}
	})

	t.Run("phone and email together: one code of ours for both", func(t *testing.T) {
		api := newFakeVerifyAPI(t)
		sms, email := &inbox{}, &inbox{}
		svc := NewOTPService(productionWithVerify(t), testRedis(t), sms, email).WithSMSVerifier(api.client(), false)
		if err := svc.SendOTP(ctx, phone, mail, "en", "", "10.0.0.1"); err != nil {
			t.Fatalf("send: %v", err)
		}
		if sms.lastCode(t, phone) != email.lastCode(t, mail) || api.starts != 0 {
			t.Fatalf("both channels must carry the same code of ours")
		}
	})

	t.Run("a code sent the old way before the switch still works", func(t *testing.T) {
		repo := testRedis(t)
		old := &inbox{}
		before := NewOTPService(production(t), repo, old, &inbox{})
		if err := before.SendOTP(ctx, phone, "", "en", "", "10.0.0.1"); err != nil {
			t.Fatalf("send before: %v", err)
		}
		api := newFakeVerifyAPI(t)
		after := NewOTPService(productionWithVerify(t), repo, &inbox{}, &inbox{}).WithSMSVerifier(api.client(), false)
		if err := after.VerifyCode(ctx, phone, old.lastCode(t, phone)); err != nil {
			t.Fatalf("old code after the switch: %v", err)
		}
	})

	t.Run("a Verify code after Verify is switched off reads as expired", func(t *testing.T) {
		repo := testRedis(t)
		api := newFakeVerifyAPI(t)
		on := NewOTPService(productionWithVerify(t), repo, &inbox{}, &inbox{}).WithSMSVerifier(api.client(), false)
		if err := on.SendOTP(ctx, phone, "", "en", "", "10.0.0.1"); err != nil {
			t.Fatalf("send: %v", err)
		}
		off := NewOTPService(production(t), repo, &inbox{}, &inbox{})
		if err := off.VerifyCode(ctx, phone, api.codeFor(t, phone)); err == nil || err.Error() != "invalid or expired code" {
			t.Fatalf("after switching off: %v", err)
		}
	})
}
