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

	// SMTP for email OTP delivery
	SMTPHost     string
	SMTPPort     string
	SMTPUser     string
	SMTPPassword string
	SMTPFrom     string

	// Dev-only: accept "000000" as valid OTP
	BypassOTP bool
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

		BypassOTP: getEnv("BYPASS_OTP", "false") == "true",
	}
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
