package repository

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	otpPrefix       = "otp:"
	attemptsPrefix  = "otp:attempts:"
	rateLimitPrefix = "otp:ratelimit:"
	hourlyPrefix    = "otp:hourly:"
	dailyPrefix     = "otp:daily:"
	ipHourlyPrefix  = "otp:hourly:ip:"
	blockedPrefix   = "otp:blocked:"
	failuresPrefix  = "otp:failures:"
)

// RedisRepository handles OTP storage in Redis.
type RedisRepository struct {
	client *redis.Client
}

// NewRedisRepository creates a new RedisRepository.
func NewRedisRepository(client *redis.Client) *RedisRepository {
	return &RedisRepository{client: client}
}

// StoreOTP stores a hashed OTP for the given phone with a TTL.
func (r *RedisRepository) StoreOTP(ctx context.Context, phone, hashedCode string, expiry time.Duration) error {
	pipe := r.client.Pipeline()
	pipe.Set(ctx, otpPrefix+phone, hashedCode, expiry)
	pipe.Set(ctx, attemptsPrefix+phone, "0", expiry)
	_, err := pipe.Exec(ctx)
	return err
}

// GetOTP retrieves the hashed OTP and attempt count for the given phone.
func (r *RedisRepository) GetOTP(ctx context.Context, phone string) (string, int, error) {
	hashedCode, err := r.client.Get(ctx, otpPrefix+phone).Result()
	if err == redis.Nil {
		return "", 0, fmt.Errorf("otp not found or expired")
	}
	if err != nil {
		return "", 0, err
	}

	attemptsStr, err := r.client.Get(ctx, attemptsPrefix+phone).Result()
	if err != nil && err != redis.Nil {
		return "", 0, err
	}
	attempts := 0
	if attemptsStr != "" {
		attempts, _ = strconv.Atoi(attemptsStr)
	}

	return hashedCode, attempts, nil
}

// IncrementAttempts increments the verification attempt counter for the given phone.
func (r *RedisRepository) IncrementAttempts(ctx context.Context, phone string) error {
	return r.client.Incr(ctx, attemptsPrefix+phone).Err()
}

// DeleteOTP removes the OTP and attempt counter for the given phone.
func (r *RedisRepository) DeleteOTP(ctx context.Context, phone string) error {
	pipe := r.client.Pipeline()
	pipe.Del(ctx, otpPrefix+phone)
	pipe.Del(ctx, attemptsPrefix+phone)
	_, err := pipe.Exec(ctx)
	return err
}

// CheckRateLimit returns true if the phone is rate-limited (cooldown between sends).
func (r *RedisRepository) CheckRateLimit(ctx context.Context, phone string) (bool, error) {
	exists, err := r.client.Exists(ctx, rateLimitPrefix+phone).Result()
	if err != nil {
		return false, err
	}
	return exists > 0, nil
}

// SetRateLimit marks the phone as rate-limited for the specified duration.
func (r *RedisRepository) SetRateLimit(ctx context.Context, phone string, duration time.Duration) error {
	return r.client.Set(ctx, rateLimitPrefix+phone, "1", duration).Err()
}

// ── Multi-layer rate limiting ──

// CheckHourlyLimit returns true if the phone has exceeded the hourly OTP send limit.
func (r *RedisRepository) CheckHourlyLimit(ctx context.Context, phone string, max int) (bool, error) {
	return r.checkCounter(ctx, hourlyPrefix+phone, max, time.Hour)
}

// CheckDailyLimit returns true if the phone has exceeded the daily OTP send limit.
func (r *RedisRepository) CheckDailyLimit(ctx context.Context, phone string, max int) (bool, error) {
	return r.checkCounter(ctx, dailyPrefix+phone, max, 24*time.Hour)
}

// CheckIPHourlyLimit returns true if the IP has exceeded the hourly OTP send limit.
func (r *RedisRepository) CheckIPHourlyLimit(ctx context.Context, ip string, max int) (bool, error) {
	return r.checkCounter(ctx, ipHourlyPrefix+ip, max, time.Hour)
}

// IncrementHourly increments the hourly send counter for a phone.
func (r *RedisRepository) IncrementHourly(ctx context.Context, phone string) error {
	return r.incrementCounter(ctx, hourlyPrefix+phone, time.Hour)
}

// IncrementDaily increments the daily send counter for a phone.
func (r *RedisRepository) IncrementDaily(ctx context.Context, phone string) error {
	return r.incrementCounter(ctx, dailyPrefix+phone, 24*time.Hour)
}

// IncrementIPHourly increments the hourly send counter for an IP.
func (r *RedisRepository) IncrementIPHourly(ctx context.Context, ip string) error {
	return r.incrementCounter(ctx, ipHourlyPrefix+ip, time.Hour)
}

// IsBlocked returns true if the phone is temporarily blocked.
func (r *RedisRepository) IsBlocked(ctx context.Context, phone string) (bool, error) {
	exists, err := r.client.Exists(ctx, blockedPrefix+phone).Result()
	if err != nil {
		return false, err
	}
	return exists > 0, nil
}

// BlockPhone blocks a phone number for the specified duration.
func (r *RedisRepository) BlockPhone(ctx context.Context, phone string, duration time.Duration) error {
	return r.client.Set(ctx, blockedPrefix+phone, "1", duration).Err()
}

// IncrementFailures increments the consecutive failure counter and returns the new count.
func (r *RedisRepository) IncrementFailures(ctx context.Context, phone string) (int, error) {
	key := failuresPrefix + phone
	val, err := r.client.Incr(ctx, key).Result()
	if err != nil {
		return 0, err
	}
	// Set TTL on first increment
	if val == 1 {
		r.client.Expire(ctx, key, time.Hour)
	}
	return int(val), nil
}

// ClearFailures resets the failure counter (called on successful verification).
func (r *RedisRepository) ClearFailures(ctx context.Context, phone string) error {
	return r.client.Del(ctx, failuresPrefix+phone).Err()
}

// ── helpers ──

func (r *RedisRepository) checkCounter(ctx context.Context, key string, max int, _ time.Duration) (bool, error) {
	val, err := r.client.Get(ctx, key).Result()
	if err == redis.Nil {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	count, _ := strconv.Atoi(val)
	return count >= max, nil
}

func (r *RedisRepository) incrementCounter(ctx context.Context, key string, ttl time.Duration) error {
	val, err := r.client.Incr(ctx, key).Result()
	if err != nil {
		return err
	}
	// Set TTL on first increment
	if val == 1 {
		r.client.Expire(ctx, key, ttl)
	}
	return nil
}
