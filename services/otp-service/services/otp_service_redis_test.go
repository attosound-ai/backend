package services

import (
	"context"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/atto-sound/otp-service/config"
	"github.com/atto-sound/otp-service/repository"
	"github.com/redis/go-redis/v9"
)

// Sending and checking codes against a real Redis: what a code is worth is
// decided by what is stored there, so a double of the store would only repeat
// what the test already believes.
//
//	redis-server --port 56390 --save "" --appendonly no &
//	OTP_TEST_REDIS_URL=redis://127.0.0.1:56390/0 go test ./...
//
// Without OTP_TEST_REDIS_URL these tests are skipped. They empty the database
// they are given, so they refuse anything that is not on this machine.
func testRedis(t *testing.T) *repository.RedisRepository {
	t.Helper()
	url := os.Getenv("OTP_TEST_REDIS_URL")
	if url == "" {
		t.Skip("OTP_TEST_REDIS_URL not set")
	}
	if !regexp.MustCompile(`^redis://(:[^@]*@)?(127\.0\.0\.1|localhost)[:/]`).MatchString(url) {
		t.Fatalf("refusing a Redis that is not on this machine")
	}
	opts, err := redis.ParseURL(url)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	client := redis.NewClient(opts)
	if err := client.FlushDB(context.Background()).Err(); err != nil {
		t.Fatalf("empty the test database: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return repository.NewRedisRepository(client)
}

// inbox keeps what would have been sent, the way a phone or a mailbox would.
type inbox struct {
	mu       sync.Mutex
	messages map[string][]string
}

func (i *inbox) Send(destination, message, locale, emailTemplate string) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.messages == nil {
		i.messages = map[string][]string{}
	}
	i.messages[destination] = append(i.messages[destination], message)
	return nil
}

func (i *inbox) lastCode(t *testing.T, destination string) string {
	t.Helper()
	i.mu.Lock()
	defer i.mu.Unlock()
	all := i.messages[destination]
	if len(all) == 0 {
		t.Fatalf("nothing was sent to %s", destination)
	}
	code := regexp.MustCompile(`\b\d{6}\b`).FindString(all[len(all)-1])
	if code == "" {
		t.Fatalf("no code in %q", all[len(all)-1])
	}
	return code
}

// production is the configuration found on Oct 7 2026: BYPASS_OTP=true on
// Railway with real delivery.
func production(t *testing.T) *config.Config {
	t.Helper()
	t.Setenv("BYPASS_OTP", "true")
	t.Setenv("DELIVERY_PROVIDER", "twilio")
	t.Setenv("RAILWAY_ENVIRONMENT_NAME", "production")
	t.Setenv("OTP_SKIP_SEND_LIMITS", "")
	return config.Load()
}

func laptop(t *testing.T) *config.Config {
	t.Helper()
	for _, key := range []string{"RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT", "RAILWAY_SERVICE_ID", "RAILWAY_PROJECT_ID", "OTP_SKIP_SEND_LIMITS"} {
		t.Setenv(key, "")
	}
	t.Setenv("BYPASS_OTP", "true")
	t.Setenv("DELIVERY_PROVIDER", "console")
	return config.Load()
}

const (
	mail  = "someone@atto.test"
	phone = "+12025550143"
)

func wrongCode(real string) string {
	if real == "111111" {
		return "222222"
	}
	return "111111"
}

func TestFixedCodeIsWorthNothingInProduction(t *testing.T) {
	ctx := context.Background()

	t.Run("with no code ever asked for (the password reset of Oct 7 2026)", func(t *testing.T) {
		svc := NewOTPService(production(t), testRedis(t), &inbox{}, &inbox{})
		for _, who := range []string{mail, phone} {
			err := svc.VerifyCode(ctx, who, "000000")
			if err == nil {
				t.Fatalf("000000 was accepted for %s", who)
			}
			if !strings.Contains(err.Error(), "invalid or expired code") {
				t.Fatalf("unexpected refusal for %s: %v", who, err)
			}
		}
	})

	t.Run("with a real code waiting", func(t *testing.T) {
		box := &inbox{}
		svc := NewOTPService(production(t), testRedis(t), box, box)
		if err := svc.SendOTP(ctx, "", mail, "en", "", "10.0.0.1"); err != nil {
			t.Fatalf("send: %v", err)
		}
		real := box.lastCode(t, mail)
		if real == "000000" {
			t.Skip("the generated code happened to be 000000 (one in a million)")
		}
		err := svc.VerifyCode(ctx, mail, "000000")
		if err == nil {
			t.Fatalf("000000 was accepted while %s was the code", real)
		}
		if !strings.Contains(err.Error(), "invalid code, 4 attempts remaining") {
			t.Fatalf("unexpected refusal: %v", err)
		}
		if err := svc.VerifyCode(ctx, mail, real); err != nil {
			t.Fatalf("the real code stopped working after 000000 was tried: %v", err)
		}
	})
}

func TestARealCodeStillWorksInProduction(t *testing.T) {
	ctx := context.Background()
	sms, email := &inbox{}, &inbox{}
	svc := NewOTPService(production(t), testRedis(t), sms, email)

	if err := svc.SendOTP(ctx, phone, "", "en", "", "10.0.0.1"); err != nil {
		t.Fatalf("send by sms: %v", err)
	}
	if err := svc.SendOTP(ctx, "", mail, "en", "", "10.0.0.1"); err != nil {
		t.Fatalf("send by email: %v", err)
	}
	phoneCode, mailCode := sms.lastCode(t, phone), email.lastCode(t, mail)

	if err := svc.VerifyCode(ctx, phone, wrongCode(phoneCode)); err == nil {
		t.Fatalf("a wrong code was accepted")
	}
	if err := svc.VerifyCode(ctx, phone, phoneCode); err != nil {
		t.Fatalf("the code sent by sms was refused: %v", err)
	}
	if err := svc.VerifyCode(ctx, mail, mailCode); err != nil {
		t.Fatalf("the code sent by email was refused: %v", err)
	}
	// A code is good once.
	if err := svc.VerifyCode(ctx, mail, mailCode); err == nil {
		t.Fatalf("the same code was accepted twice")
	}
	// One person's code is not another's.
	if err := svc.SendOTP(ctx, "", mail, "en", "", "10.0.0.1"); err != nil {
		t.Fatalf("second send: %v", err)
	}
	if err := svc.VerifyCode(ctx, "other@atto.test", email.lastCode(t, mail)); err == nil {
		t.Fatalf("a code sent to one address opened another")
	}
}

func TestSendLimitsDoNotChangeInProduction(t *testing.T) {
	ctx := context.Background()

	t.Run("production keeps sending without waiting, as before", func(t *testing.T) {
		box := &inbox{}
		svc := NewOTPService(production(t), testRedis(t), box, box)
		for i := 0; i < 12; i++ { // past the hourly (5), daily (10) and per address (10) limits
			if err := svc.SendOTP(ctx, "", mail, "en", "", "10.0.0.1"); err != nil {
				t.Fatalf("send %d was limited: %v", i+1, err)
			}
		}
		if err := svc.VerifyCode(ctx, mail, box.lastCode(t, mail)); err != nil {
			t.Fatalf("the last code sent was refused: %v", err)
		}
	})

	t.Run("limits come back with OTP_SKIP_SEND_LIMITS=false", func(t *testing.T) {
		production(t)
		t.Setenv("OTP_SKIP_SEND_LIMITS", "false")
		box := &inbox{}
		svc := NewOTPService(config.Load(), testRedis(t), box, box)
		if err := svc.SendOTP(ctx, "", mail, "en", "", "10.0.0.1"); err != nil {
			t.Fatalf("first send: %v", err)
		}
		err := svc.SendOTP(ctx, "", mail, "en", "", "10.0.0.1")
		if err == nil || !strings.Contains(err.Error(), "rate limited") {
			t.Fatalf("a second code within the minute was not limited: %v", err)
		}
	})
}

func TestWrongCodesStillRunOutInProduction(t *testing.T) {
	ctx := context.Background()
	box := &inbox{}
	cfg := production(t)
	svc := NewOTPService(cfg, testRedis(t), box, box)
	if err := svc.SendOTP(ctx, "", mail, "en", "", "10.0.0.1"); err != nil {
		t.Fatalf("send: %v", err)
	}
	real := box.lastCode(t, mail)

	var last error
	for i := 0; i < cfg.MaxConsecFailures; i++ {
		last = svc.VerifyCode(ctx, mail, wrongCode(real))
		if last == nil {
			t.Fatalf("wrong code %d was accepted", i+1)
		}
	}
	if !strings.Contains(last.Error(), "temporarily blocked") {
		t.Fatalf("after %d wrong codes: %v", cfg.MaxConsecFailures, last)
	}
	// Blocked means blocked: not the real code, and not 000000 either.
	for _, code := range []string{real, "000000"} {
		if err := svc.VerifyCode(ctx, mail, code); err == nil {
			t.Fatalf("%s was accepted while blocked", code)
		}
	}
}

func TestFixedCodeOnALaptop(t *testing.T) {
	ctx := context.Background()
	box := &inbox{}
	svc := NewOTPService(laptop(t), testRedis(t), box, box)
	if err := svc.VerifyCode(ctx, mail, "000000"); err != nil {
		t.Fatalf("the fixed code was refused on a laptop: %v", err)
	}
	if err := svc.VerifyCode(ctx, mail, "000001"); err == nil {
		t.Fatalf("only 000000 is the fixed code")
	}
}
