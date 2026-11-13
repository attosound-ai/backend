package services

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"github.com/atto-sound/otp-service/config"
	"github.com/atto-sound/otp-service/providers"
	"github.com/atto-sound/otp-service/repository"
	"golang.org/x/crypto/bcrypt"
)

// OTPService handles the business logic for OTP operations.
type OTPService struct {
	cfg           *config.Config
	repo          *repository.RedisRepository
	smsDelivery   providers.DeliveryProvider // SMS (Twilio or console)
	emailDelivery providers.DeliveryProvider // Email (email-service HTTP or console)
	dispatcher    *MultiChannelDispatcher

	// smsVerifier, when set, sends and checks the codes of SMS only requests
	// (Twilio Verify). smsFallback lets smsDelivery send them instead when
	// Verify is unavailable.
	smsVerifier providers.SMSVerifier
	smsFallback bool
}

// verifyMarker prefixes what is stored in place of a hash when Twilio Verify
// holds the code: "verify:" + the verification SID. A bcrypt hash starts
// with "$2", so the two never mix up, and codes sent the old way before a
// switch keep working until they expire.
const verifyMarker = "verify:"

// WithSMSVerifier makes Twilio Verify send and check the codes asked for by
// phone only. A request with an email too keeps one code of ours for both
// channels, sent the old way.
func (s *OTPService) WithSMSVerifier(v providers.SMSVerifier, fallbackToLegacy bool) *OTPService {
	s.smsVerifier = v
	s.smsFallback = fallbackToLegacy
	return s
}

// NewOTPService creates a new OTPService.
// The internal MultiChannelDispatcher is created with a 5-second timeout per send.
func NewOTPService(cfg *config.Config, repo *repository.RedisRepository, delivery providers.DeliveryProvider, emailDelivery providers.DeliveryProvider) *OTPService {
	return &OTPService{
		cfg:           cfg,
		repo:          repo,
		smsDelivery:   delivery,
		emailDelivery: emailDelivery,
		dispatcher:    NewMultiChannelDispatcher(5 * time.Second),
	}
}

// resolveTarget builds the OTPTarget from validated handler inputs.
// phone must be E.164 or empty; email must be trimmed or empty.
// When both are present, email is the primary identifier (Redis key owner).
func (s *OTPService) resolveTarget(phone, email string) OTPTarget {
	hasSMS := phone != ""
	hasEmail := email != ""

	switch {
	case hasSMS && hasEmail:
		return OTPTarget{
			PrimaryIdentifier: email,
			Targets: []DeliveryTarget{
				{ChannelName: "email", Provider: s.emailDelivery, Destination: email},
				{ChannelName: "sms", Provider: s.smsDelivery, Destination: phone},
			},
		}
	case hasEmail:
		return OTPTarget{
			PrimaryIdentifier: email,
			Targets: []DeliveryTarget{
				{ChannelName: "email", Provider: s.emailDelivery, Destination: email},
			},
		}
	default: // SMS only
		return OTPTarget{
			PrimaryIdentifier: phone,
			Targets: []DeliveryTarget{
				{ChannelName: "sms", Provider: s.smsDelivery, Destination: phone},
			},
		}
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

// SendOTP generates an OTP and delivers it to all available channels concurrently.
// phone is E.164 or empty; email is address or empty; at least one must be non-empty.
func (s *OTPService) SendOTP(ctx context.Context, phone, email, locale, emailTemplate, clientIP string) error {
	target := s.resolveTarget(phone, email)

	if !s.cfg.SkipSendLimits {
		if err := s.checkSendLimits(ctx, target.PrimaryIdentifier, clientIP); err != nil {
			return err
		}
	}

	if s.smsVerifier != nil && len(target.Targets) == 1 && target.Targets[0].ChannelName == "sms" {
		s.countSend(ctx, target.PrimaryIdentifier, clientIP)
		sid, err := s.smsVerifier.Start(ctx, phone, locale)
		if err == nil {
			marker := verifyMarker + sid
			if err := s.repo.StoreOTP(ctx, target.PrimaryIdentifier, marker, s.cfg.OTPExpiry); err != nil {
				return fmt.Errorf("failed to store OTP: %w", err)
			}
			log.Printf("[OTP] Code sent to %s via Twilio Verify", providers.MaskPhone(phone))
			return nil
		}
		var ve *providers.VerifyError
		if errors.As(err, &ve) && ve.TooManySends() {
			return fmt.Errorf("rate limited: please wait before requesting a new code")
		}
		if !(s.smsFallback && providers.IsUnavailable(err)) {
			_ = s.repo.DeleteOTP(ctx, target.PrimaryIdentifier)
			return fmt.Errorf("failed to send OTP: %w", err)
		}
		log.Printf("[OTP] Twilio Verify unavailable (%v), sending to %s the old way", err, providers.MaskPhone(phone))
		return s.sendOwnCode(ctx, target, locale, emailTemplate)
	}

	s.countSend(ctx, target.PrimaryIdentifier, clientIP)
	return s.sendOwnCode(ctx, target, locale, emailTemplate)
}

// countSend starts the wait before the next code and counts this one, once,
// on the primary identifier.
func (s *OTPService) countSend(ctx context.Context, identifier, clientIP string) {
	if err := s.repo.SetRateLimit(ctx, identifier, s.cfg.RateLimitSeconds); err != nil {
		log.Printf("[OTP] Warning: failed to set rate limit for %s: %v", identifier, err)
	}
	_ = s.repo.IncrementHourly(ctx, identifier)
	_ = s.repo.IncrementDaily(ctx, identifier)
	if clientIP != "" {
		_ = s.repo.IncrementIPHourly(ctx, clientIP)
	}
}

// sendOwnCode makes a code here, keeps its hash and sends it to every target.
func (s *OTPService) sendOwnCode(ctx context.Context, target OTPTarget, locale, emailTemplate string) error {
	code, err := GenerateOTP(s.cfg.OTPLength)
	if err != nil {
		return err
	}

	hashedCode, err := HashOTP(code)
	if err != nil {
		return err
	}

	// Store hashed OTP in Redis under the primary identifier
	if err := s.repo.StoreOTP(ctx, target.PrimaryIdentifier, hashedCode, s.cfg.OTPExpiry); err != nil {
		return fmt.Errorf("failed to store OTP: %w", err)
	}

	message := fmt.Sprintf(
		"Your Atto Sound code is: %s. Expires in %d min.",
		code,
		int(s.cfg.OTPExpiry.Minutes()),
	)

	if err := s.dispatcher.Send(ctx, target.Targets, message, locale, emailTemplate); err != nil {
		_ = s.repo.DeleteOTP(ctx, target.PrimaryIdentifier)
		return fmt.Errorf("failed to send OTP: %w", err)
	}

	log.Printf("[OTP] Code sent to %s via %d channel(s)", target.PrimaryIdentifier, len(target.Targets))
	return nil
}

// VerifyCode verifies the OTP code for the given phone number.
func (s *OTPService) VerifyCode(ctx context.Context, phone, code string) error {
	// Laptop only: "000000" stands in for the code (before block and limits).
	// cfg.BypassOTP is never true where codes are really sent.
	if s.cfg.BypassOTP && code == "000000" {
		log.Printf("[OTP] Bypass code accepted for %s (dev mode)", phone)
		_ = s.repo.DeleteOTP(ctx, phone)
		_ = s.repo.ClearFailures(ctx, phone)
		return nil
	}

	// Check if phone is blocked
	blocked, err := s.repo.IsBlocked(ctx, phone)
	if err != nil {
		return fmt.Errorf("failed to check block status: %w", err)
	}
	if blocked {
		return fmt.Errorf(errBlocked)
	}

	// Retrieve hashed OTP and attempt count from Redis
	stored, attempts, err := s.repo.GetOTP(ctx, phone)
	if err != nil {
		return fmt.Errorf("invalid or expired code")
	}

	// Check max attempts per code
	if attempts >= s.cfg.MaxAttempts {
		s.forget(ctx, phone, stored)
		return fmt.Errorf("maximum verification attempts exceeded")
	}

	var matched bool
	if strings.HasPrefix(stored, verifyMarker) {
		if s.smsVerifier == nil {
			// Sent by Verify, which has been switched off since.
			_ = s.repo.DeleteOTP(ctx, phone)
			return fmt.Errorf("invalid or expired code")
		}
		result, err := s.smsVerifier.Check(ctx, phone, code)
		if err != nil {
			// Nothing is known about the code: not counted as a wrong one.
			return fmt.Errorf("sms verification unavailable: %w", err)
		}
		switch result {
		case providers.CheckGone:
			_ = s.repo.DeleteOTP(ctx, phone)
			return fmt.Errorf("invalid or expired code")
		case providers.CheckTooManyAttempts:
			_ = s.repo.DeleteOTP(ctx, phone)
			return fmt.Errorf("maximum verification attempts exceeded")
		}
		matched = result == providers.CheckApproved
	}

	// Increment attempt counter
	if err := s.repo.IncrementAttempts(ctx, phone); err != nil {
		log.Printf("[OTP] Warning: failed to increment attempts for %s: %v", phone, err)
	}

	// Compare OTP
	if !strings.HasPrefix(stored, verifyMarker) {
		matched = VerifyOTP(code, stored)
	}
	if !matched {
		remaining := s.cfg.MaxAttempts - attempts - 1
		if remaining <= 0 {
			s.forget(ctx, phone, stored)
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
			s.forget(ctx, phone, stored)
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

// forget drops a code that may no longer be used (too many attempts, a
// block). When Verify holds it, the verification is canceled too, or Verify
// would send that same code again on the next request within its 10 minutes.
func (s *OTPService) forget(ctx context.Context, identifier, stored string) {
	_ = s.repo.DeleteOTP(ctx, identifier)
	if s.smsVerifier == nil || !strings.HasPrefix(stored, verifyMarker) {
		return
	}
	sid := strings.TrimPrefix(stored, verifyMarker)
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = s.smsVerifier.Cancel(cctx, sid)
}
