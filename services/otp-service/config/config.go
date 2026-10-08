package config

import (
	"os"
	"strconv"
	"time"
)

// Config holds all configuration for the OTP service.
type Config struct {
	HTTPPort         string
	RedisURL         string
	OTPLength        int
	OTPExpiry        time.Duration
	RateLimitSeconds time.Duration
	MaxAttempts      int

	// Delivery provider
	DeliveryProvider string // "twilio" | "console"

	// Twilio SMS
	TwilioAccountSID string
	TwilioAuthToken  string
	TwilioFromPhone  string

	// Rate limiting (multi-layer)
	MaxOTPPerHour     int
	MaxOTPPerDay      int
	MaxOTPPerIPHour   int
	BlockDuration     time.Duration
	MaxConsecFailures int

	// SMTP for email OTP delivery (legacy, fallback)
	SMTPHost     string
	SMTPPort     string
	SMTPUser     string
	SMTPPassword string
	SMTPFrom     string

	// Email service (preferred over SMTP)
	EmailServiceURL string

	// The fixed code "000000" stands in for a real one. Only ever true where
	// no code is really sent (see fixedCodeAllowed), whatever BYPASS_OTP says.
	BypassOTP bool

	// BYPASS_OTP=true was asked for where the fixed code is refused.
	BypassRefused bool

	// The limits on asking for codes (wait between two, per hour, per day,
	// per address) are skipped.
	SkipSendLimits bool
}

// deployed is true on any Railway environment: Railway sets these itself.
func deployed() bool {
	for _, key := range []string{"RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT", "RAILWAY_SERVICE_ID", "RAILWAY_PROJECT_ID"} {
		if os.Getenv(key) != "" {
			return true
		}
	}
	return false
}

// fixedCodeAllowed says whether "000000" may stand in for a real code.
//
// On Oct 7 2026 production was found running with BYPASS_OTP=true: with
// nothing but a public username, POST /auth/reset-password {otp: "000000"}
// set a new password on any account, and the same code opened a signup or a
// login by phone. The switch was written for a laptop, where codes are
// printed to the console instead of sent. So that is the only place it works:
// asked for explicitly, not on a deployment, and with no real delivery.
func fixedCodeAllowed(asked bool, deliveryProvider string, isDeployed bool) bool {
	return asked && !isDeployed && deliveryProvider == "console"
}

// Load reads configuration from environment variables with sensible defaults.
func Load() *Config {
	cfg := &Config{
		HTTPPort:         getEnv("HTTP_PORT", "8000"),
		RedisURL:         getEnv("REDIS_URL", "redis://localhost:6379"),
		OTPLength:        getEnvInt("OTP_LENGTH", 6),
		OTPExpiry:        time.Duration(getEnvInt("OTP_EXPIRY_SECONDS", 600)) * time.Second,
		RateLimitSeconds: time.Duration(getEnvInt("RATE_LIMIT_SECONDS", 60)) * time.Second,
		MaxAttempts:      getEnvInt("MAX_ATTEMPTS", 5),

		DeliveryProvider: getEnv("DELIVERY_PROVIDER", "console"),
		TwilioAccountSID: getEnv("TWILIO_ACCOUNT_SID", ""),
		TwilioAuthToken:  getEnv("TWILIO_AUTH_TOKEN", ""),
		TwilioFromPhone:  getEnv("TWILIO_FROM_PHONE", ""),

		MaxOTPPerHour:     getEnvInt("MAX_OTP_PER_HOUR", 5),
		MaxOTPPerDay:      getEnvInt("MAX_OTP_PER_DAY", 10),
		MaxOTPPerIPHour:   getEnvInt("MAX_OTP_PER_IP_HOUR", 10),
		BlockDuration:     time.Duration(getEnvInt("BLOCK_DURATION_MINUTES", 30)) * time.Minute,
		MaxConsecFailures: getEnvInt("MAX_CONSEC_FAILURES", 3),

		SMTPHost:     getEnv("SMTP_HOST", ""),
		SMTPPort:     getEnv("SMTP_PORT", "587"),
		SMTPUser:     getEnv("SMTP_USER", ""),
		SMTPPassword: getEnv("SMTP_PASSWORD", ""),
		SMTPFrom:     getEnv("SMTP_FROM", "noreply@attosound.com"),

		EmailServiceURL: getEnv("EMAIL_SERVICE_URL", "http://email-service:3005"),
	}

	bypassAsked := getEnv("BYPASS_OTP", "false") == "true"
	cfg.BypassOTP = fixedCodeAllowed(bypassAsked, cfg.DeliveryProvider, deployed())
	cfg.BypassRefused = bypassAsked && !cfg.BypassOTP
	// Production has sent codes without limits for as long as BYPASS_OTP has
	// been on there. Refusing the fixed code must not switch the limits on by
	// surprise: the per address one counts the address of the service that
	// calls this one, so every user would share it. They keep following
	// BYPASS_OTP until OTP_SKIP_SEND_LIMITS says otherwise.
	cfg.SkipSendLimits = getEnv("OTP_SKIP_SEND_LIMITS", strconv.FormatBool(bypassAsked)) == "true"
	return cfg
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return fallback
}
