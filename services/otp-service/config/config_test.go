package config

import "testing"

// The variables Railway sets on every deployment. Cleared before each case so
// the result does not depend on where the tests run.
var railwayKeys = []string{"RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT", "RAILWAY_SERVICE_ID", "RAILWAY_PROJECT_ID"}

func setEnv(t *testing.T, env map[string]string) {
	t.Helper()
	for _, key := range append([]string{"BYPASS_OTP", "DELIVERY_PROVIDER", "OTP_SKIP_SEND_LIMITS"}, railwayKeys...) {
		t.Setenv(key, "")
	}
	for key, value := range env {
		t.Setenv(key, value)
	}
}

func TestFixedCodeOnlyWhereNoCodeIsReallySent(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{
			name: "production as it was found on Oct 7 2026",
			env:  map[string]string{"BYPASS_OTP": "true", "DELIVERY_PROVIDER": "twilio", "RAILWAY_ENVIRONMENT_NAME": "production", "RAILWAY_ENVIRONMENT": "production"},
			want: false,
		},
		{
			name: "a laptop with the compose file",
			env:  map[string]string{"BYPASS_OTP": "true", "DELIVERY_PROVIDER": "console"},
			want: true,
		},
		{
			name: "a laptop that never set a delivery provider",
			env:  map[string]string{"BYPASS_OTP": "true"},
			want: true,
		},
		{
			name: "a deployment that prints codes to the console",
			env:  map[string]string{"BYPASS_OTP": "true", "DELIVERY_PROVIDER": "console", "RAILWAY_SERVICE_ID": "abc"},
			want: false,
		},
		{
			name: "a staging environment on Railway",
			env:  map[string]string{"BYPASS_OTP": "true", "DELIVERY_PROVIDER": "console", "RAILWAY_ENVIRONMENT_NAME": "staging"},
			want: false,
		},
		{
			name: "real SMS outside Railway",
			env:  map[string]string{"BYPASS_OTP": "true", "DELIVERY_PROVIDER": "twilio"},
			want: false,
		},
		{
			name: "a laptop that did not ask for it",
			env:  map[string]string{"DELIVERY_PROVIDER": "console"},
			want: false,
		},
		{
			name: "anything but the exact word true",
			env:  map[string]string{"BYPASS_OTP": "1", "DELIVERY_PROVIDER": "console"},
			want: false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			setEnv(t, c.env)
			cfg := Load()
			if cfg.BypassOTP != c.want {
				t.Fatalf("fixed code accepted = %v, want %v", cfg.BypassOTP, c.want)
			}
			asked := c.env["BYPASS_OTP"] == "true"
			if cfg.BypassRefused != (asked && !c.want) {
				t.Fatalf("refusal reported = %v, asked %v, accepted %v", cfg.BypassRefused, asked, cfg.BypassOTP)
			}
		})
	}
}

func TestSendLimitsStayAsTheyWere(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want bool // limits skipped
	}{
		{
			name: "production keeps sending without limits while BYPASS_OTP stays on",
			env:  map[string]string{"BYPASS_OTP": "true", "DELIVERY_PROVIDER": "twilio", "RAILWAY_ENVIRONMENT_NAME": "production"},
			want: true,
		},
		{
			name: "limits apply when nothing is set",
			env:  map[string]string{"DELIVERY_PROVIDER": "twilio", "RAILWAY_ENVIRONMENT_NAME": "production"},
			want: false,
		},
		{
			name: "limits can be switched on without touching BYPASS_OTP",
			env:  map[string]string{"BYPASS_OTP": "true", "OTP_SKIP_SEND_LIMITS": "false", "DELIVERY_PROVIDER": "twilio", "RAILWAY_ENVIRONMENT_NAME": "production"},
			want: false,
		},
		{
			name: "limits can be switched off on their own",
			env:  map[string]string{"OTP_SKIP_SEND_LIMITS": "true", "DELIVERY_PROVIDER": "twilio", "RAILWAY_ENVIRONMENT_NAME": "production"},
			want: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			setEnv(t, c.env)
			cfg := Load()
			if cfg.SkipSendLimits != c.want {
				t.Fatalf("limits skipped = %v, want %v", cfg.SkipSendLimits, c.want)
			}
			if cfg.BypassOTP {
				t.Fatalf("the fixed code must stay refused on a deployment")
			}
		})
	}
}
