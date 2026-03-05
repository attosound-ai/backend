package services

import (
	"context"
	"crypto/rand"
	"fmt"
	"log"
	"math/big"

	"github.com/atto-sound/otp-service/config"
	"github.com/atto-sound/otp-service/providers"
	"github.com/atto-sound/otp-service/repository"
	"golang.org/x/crypto/bcrypt"
)

// OTPService handles the business logic for OTP operations.
type OTPService struct {
	cfg           *config.Config
	repo          *repository.RedisRepository
	delivery      providers.DeliveryProvider // SMS
	emailDelivery providers.DeliveryProvider // Email
}

// NewOTPService creates a new OTPService.
func NewOTPService(cfg *config.Config, repo *repository.RedisRepository, delivery providers.DeliveryProvider, emailDelivery providers.DeliveryProvider) *OTPService {
	return &OTPService{
		cfg:           cfg,
		repo:          repo,
		delivery:      delivery,
		emailDelivery: emailDelivery,
	}
}

// GenerateOTP generates a cryptographically secure random numeric OTP of the given length.
func GenerateOTP(length int) (string, error) {
	if length <= 0 {
		length = 6
	}

	otp := make([]byte, length)
	for i := 0; i < length; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", fmt.Errorf("failed to generate OTP: %w", err)
		}
		otp[i] = byte('0' + n.Int64())
	}
	return string(otp), nil
}

// HashOTP creates a bcrypt hash of the given OTP code.
func HashOTP(code string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(code), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("failed to hash OTP: %w", err)
	}
	return string(hash), nil
}

// VerifyOTP compares a plain OTP code against a bcrypt hash.
func VerifyOTP(code, hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(code)) == nil
}

const errBlocked = "temporarily blocked: too many failed attempts, try again later"

// checkSendLimits validates all rate-limiting layers before allowing an OTP send.
func (s *OTPService) checkSendLimits(ctx context.Context, phone, clientIP string) error {
	blocked, err := s.repo.IsBlocked(ctx, phone)
	if err != nil {
		return fmt.Errorf("failed to check block status: %w", err)
	}
	if blocked {
		return fmt.Errorf(errBlocked)
	}

	rateLimited, err := s.repo.CheckRateLimit(ctx, phone)
	if err != nil {
		return fmt.Errorf("failed to check rate limit: %w", err)
	}
	if rateLimited {
		return fmt.Errorf("rate limited: please wait before requesting a new code")
	}

	hourlyLimited, err := s.repo.CheckHourlyLimit(ctx, phone, s.cfg.MaxOTPPerHour)
	if err != nil {
		return fmt.Errorf("failed to check hourly limit: %w", err)
	}
	if hourlyLimited {
		return fmt.Errorf("hourly limit exceeded: too many codes requested this hour")
	}

	dailyLimited, err := s.repo.CheckDailyLimit(ctx, phone, s.cfg.MaxOTPPerDay)
	if err != nil {
		return fmt.Errorf("failed to check daily limit: %w", err)
	}
	if dailyLimited {
		return fmt.Errorf("daily limit exceeded: too many codes requested today")
	}

	if clientIP != "" {
		ipLimited, err := s.repo.CheckIPHourlyLimit(ctx, clientIP, s.cfg.MaxOTPPerIPHour)
		if err != nil {
			return fmt.Errorf("failed to check IP limit: %w", err)
		}
		if ipLimited {
			return fmt.Errorf("ip limit exceeded: too many codes requested from this address")
		}
	}

	return nil
}

// SendOTP generates an OTP, hashes it, stores it in Redis, and sends it via the given channel.
// Channel can be "sms" (default) or "email". Identifier is the phone (E.164) or email address.
func (s *OTPService) SendOTP(ctx context.Context, identifier, clientIP, channel string) error {
	if err := s.checkSendLimits(ctx, identifier, clientIP); err != nil {
		return err
	}

	// Generate OTP
	code, err := GenerateOTP(s.cfg.OTPLength)
	if err != nil {
		return err
	}

	// Hash OTP
	hashedCode, err := HashOTP(code)
	if err != nil {
		return err
	}

	// Store hashed OTP in Redis with TTL
	if err := s.repo.StoreOTP(ctx, identifier, hashedCode, s.cfg.OTPExpiry); err != nil {
		return fmt.Errorf("failed to store OTP: %w", err)
	}

	// Set rate limit cooldown
	if err := s.repo.SetRateLimit(ctx, identifier, s.cfg.RateLimitSeconds); err != nil {
		log.Printf("[OTP] Warning: failed to set rate limit for %s: %v", identifier, err)
	}

	// Increment counters
	_ = s.repo.IncrementHourly(ctx, identifier)
	_ = s.repo.IncrementDaily(ctx, identifier)
	if clientIP != "" {
		_ = s.repo.IncrementIPHourly(ctx, clientIP)
	}

	// Send via appropriate channel
	message := fmt.Sprintf(
		"Your Atto Sound code is: %s. Expires in %d min.",
		code,
		int(s.cfg.OTPExpiry.Minutes()),
	)

	var sendErr error
	if channel == "email" {
		sendErr = s.emailDelivery.Send(identifier, message)
	} else {
		sendErr = s.delivery.Send(identifier, message)
	}
	if sendErr != nil {
		_ = s.repo.DeleteOTP(ctx, identifier)
		return fmt.Errorf("failed to send OTP: %w", sendErr)
	}

	log.Printf("[OTP] Code sent to %s via %s", identifier, channel)
	return nil
}

// VerifyCode verifies the OTP code for the given phone number.
func (s *OTPService) VerifyCode(ctx context.Context, phone, code string) error {
	// Check if phone is blocked
	blocked, err := s.repo.IsBlocked(ctx, phone)
	if err != nil {
		return fmt.Errorf("failed to check block status: %w", err)
	}
	if blocked {
		return fmt.Errorf(errBlocked)
	}

	// Dev bypass: accept "000000" when BYPASS_OTP=true
	if s.cfg.BypassOTP && code == "000000" {
		log.Printf("[OTP] Bypass code accepted for %s (dev mode)", phone)
		_ = s.repo.DeleteOTP(ctx, phone)
		_ = s.repo.ClearFailures(ctx, phone)
		return nil
	}

	// Retrieve hashed OTP and attempt count from Redis
	hashedCode, attempts, err := s.repo.GetOTP(ctx, phone)
	if err != nil {
		return fmt.Errorf("invalid or expired code")
	}

	// Check max attempts per code
	if attempts >= s.cfg.MaxAttempts {
		_ = s.repo.DeleteOTP(ctx, phone)
		return fmt.Errorf("maximum verification attempts exceeded")
	}

	// Increment attempt counter
	if err := s.repo.IncrementAttempts(ctx, phone); err != nil {
		log.Printf("[OTP] Warning: failed to increment attempts for %s: %v", phone, err)
	}

	// Compare OTP
	if !VerifyOTP(code, hashedCode) {
		remaining := s.cfg.MaxAttempts - attempts - 1
		if remaining <= 0 {
			_ = s.repo.DeleteOTP(ctx, phone)
		}

		// Increment consecutive failure counter
		failures, err := s.repo.IncrementFailures(ctx, phone)
		if err != nil {
			log.Printf("[OTP] Warning: failed to increment failures for %s: %v", phone, err)
		}

		// Block phone if too many consecutive failures
		if failures >= s.cfg.MaxConsecFailures {
			if err := s.repo.BlockPhone(ctx, phone, s.cfg.BlockDuration); err != nil {
				log.Printf("[OTP] Warning: failed to block %s: %v", phone, err)
			}
			_ = s.repo.DeleteOTP(ctx, phone)
			return fmt.Errorf(errBlocked)
		}

		if remaining <= 0 {
			return fmt.Errorf("maximum verification attempts exceeded")
		}
		return fmt.Errorf("invalid code, %d attempts remaining", remaining)
	}

	// Success — delete OTP and clear failure counter
	if err := s.repo.DeleteOTP(ctx, phone); err != nil {
		log.Printf("[OTP] Warning: failed to delete OTP for %s after verification: %v", phone, err)
	}
	_ = s.repo.ClearFailures(ctx, phone)

	log.Printf("[OTP] Code verified for %s", phone)
	return nil
}
