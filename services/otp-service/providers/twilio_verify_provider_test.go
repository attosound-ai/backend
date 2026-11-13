package providers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// What the client sends to Verify and how it reads the answers, against a
// fake of the API that answers the way the Verify v2 reference says it does.

const (
	testAccount = "ACtest"
	testToken   = "secret"
	testService = "VAtest"
)

type seen struct {
	path string
	form url.Values
}

func fakeVerify(t *testing.T, answer func(path string, form url.Values) (int, string)) (*TwilioVerify, *[]seen) {
	t.Helper()
	var calls []seen
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != testAccount || pass != testToken {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"code":20003,"message":"Authenticate","status":401}`))
			return
		}
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
			t.Errorf("unexpected request %s %s %s", r.Method, r.URL.Path, r.Header.Get("Content-Type"))
		}
		_ = r.ParseForm()
		calls = append(calls, seen{path: r.URL.Path, form: r.PostForm})
		status, body := answer(r.URL.Path, r.PostForm)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	v := NewTwilioVerify(testAccount, testToken, testService)
	v.BaseURL = srv.URL
	return v, &calls
}

func TestStartSendsAnSMSWithTheUsersLanguage(t *testing.T) {
	v, calls := fakeVerify(t, func(path string, form url.Values) (int, string) {
		return http.StatusCreated, `{"sid":"VE123","status":"pending","channel":"sms"}`
	})
	for _, c := range []struct{ app, want string }{
		{"en", "en"}, {"es", "es"}, {"pt-BR", "pt-BR"}, {"pt", "pt-BR"}, {"es-CO", "es"}, {"en_US", "en"}, {"pt-PT", "pt"}, {"", ""}, {"fr", ""},
	} {
		sid, err := v.Start(context.Background(), "+12025550143", c.app)
		if err != nil || sid != "VE123" {
			t.Fatalf("start (%q): sid %q, err %v", c.app, sid, err)
		}
		last := (*calls)[len(*calls)-1]
		if last.path != "/Services/VAtest/Verifications" {
			t.Fatalf("path %s", last.path)
		}
		if last.form.Get("To") != "+12025550143" || last.form.Get("Channel") != "sms" || last.form.Get("RiskCheck") != "enable" {
			t.Fatalf("form %v", last.form)
		}
		if got := last.form.Get("Locale"); got != c.want {
			t.Fatalf("app language %q sent as Locale %q, want %q", c.app, got, c.want)
		}
		if _, has := last.form["Locale"]; c.want == "" && has {
			t.Fatalf("an unknown language must leave Locale out, not send it empty")
		}
		if last.form.Get("CustomCode") != "" {
			t.Fatalf("Verify makes the code: no CustomCode")
		}
	}
}

func TestCheckReadsVerifyAnswers(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   CheckResult
		err    bool
	}{
		{"right code", 200, `{"status":"approved","valid":true}`, CheckApproved, false},
		{"wrong code", 200, `{"status":"pending","valid":false}`, CheckWrongCode, false},
		{"expired or already used", 404, `{"code":20404,"message":"The requested resource /Services/VAtest/VerificationCheck was not found","status":404}`, CheckGone, false},
		{"Verify's own attempt limit", 429, `{"code":60202,"message":"Max check attempts reached","status":429}`, CheckTooManyAttempts, false},
		{"status max_attempts_reached", 200, `{"status":"max_attempts_reached"}`, CheckTooManyAttempts, false},
		{"canceled", 200, `{"status":"canceled"}`, CheckGone, false},
		{"Verify down", 503, `{"code":20500,"message":"Internal Server Error","status":503}`, CheckGone, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v, calls := fakeVerify(t, func(path string, form url.Values) (int, string) { return c.status, c.body })
			got, err := v.Check(context.Background(), "+12025550143", "123456")
			if (err != nil) != c.err {
				t.Fatalf("err %v, want error %v", err, c.err)
			}
			if !c.err && got != c.want {
				t.Fatalf("result %v, want %v", got, c.want)
			}
			last := (*calls)[0]
			if last.path != "/Services/VAtest/VerificationCheck" || last.form.Get("To") != "+12025550143" || last.form.Get("Code") != "123456" {
				t.Fatalf("request %s %v", last.path, last.form)
			}
		})
	}
}

func TestWhichFailuresMayFallBack(t *testing.T) {
	cases := []struct {
		name        string
		status      int
		body        string
		unavailable bool
		tooMany     bool
	}{
		{"Verify down", 503, `{"code":20500,"status":503}`, true, false},
		{"wrong credentials", 401, `{"code":20003,"status":401}`, true, false},
		{"wrong service SID", 404, `{"code":20404,"status":404}`, true, false},
		{"API throttled", 429, `{"code":20429,"status":429}`, true, false},
		{"Fraud Guard blocked the prefix", 403, `{"code":60410,"status":403}`, false, false},
		{"geo permissions", 403, `{"code":60605,"status":403}`, false, false},
		{"invalid number", 400, `{"code":60200,"status":400}`, false, false},
		{"landline", 400, `{"code":60205,"status":400}`, false, false},
		{"too many codes for this number", 429, `{"code":60203,"message":"Max send attempts reached","status":429}`, false, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v, _ := fakeVerify(t, func(path string, form url.Values) (int, string) { return c.status, c.body })
			_, err := v.Start(context.Background(), "+12025550143", "en")
			var ve *VerifyError
			if !errors.As(err, &ve) {
				t.Fatalf("err %v is not a VerifyError", err)
			}
			if IsUnavailable(err) != c.unavailable || ve.TooManySends() != c.tooMany {
				t.Fatalf("unavailable %v tooMany %v, want %v %v", IsUnavailable(err), ve.TooManySends(), c.unavailable, c.tooMany)
			}
			// The handler picks the status from words in the error: Twilio's
			// own words must not reach it.
			if strings.Contains(err.Error(), "invalid") || strings.Contains(err.Error(), "expired") || strings.Contains(err.Error(), "limit") {
				t.Fatalf("error text %q would be read as a refusal by the handler", err.Error())
			}
		})
	}

	t.Run("Twilio not reached", func(t *testing.T) {
		v := NewTwilioVerify(testAccount, testToken, testService)
		v.BaseURL = "http://127.0.0.1:1" // nothing listens there
		_, err := v.Start(context.Background(), "+12025550143", "en")
		if !IsUnavailable(err) {
			t.Fatalf("an unreachable Verify must count as unavailable: %v", err)
		}
	})
}

func TestCancel(t *testing.T) {
	v, calls := fakeVerify(t, func(path string, form url.Values) (int, string) {
		if path == "/Services/VAtest/Verifications/VEgone" {
			return 404, `{"code":20404,"status":404}`
		}
		return 200, `{"sid":"VE123","status":"canceled"}`
	})
	if err := v.Cancel(context.Background(), "VE123"); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if c := (*calls)[0]; c.path != "/Services/VAtest/Verifications/VE123" || c.form.Get("Status") != "canceled" {
		t.Fatalf("request %s %v", c.path, c.form)
	}
	if err := v.Cancel(context.Background(), "VEgone"); err != nil {
		t.Fatalf("a verification that is already over is not an error: %v", err)
	}
}

func TestMaskPhone(t *testing.T) {
	for in, want := range map[string]string{
		"+12025550143":   "+1********43",
		"+573001234567":  "+57********67",
		"+5511987654321": "+55*********21",
	} {
		if got := MaskPhone(in); got != want {
			t.Fatalf("MaskPhone(%s) = %s, want %s", in, got, want)
		}
	}
}
