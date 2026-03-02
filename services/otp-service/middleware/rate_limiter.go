package middleware

import (
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
)

// RateLimiterConfig holds configuration for the global rate limiter middleware.
type RateLimiterConfig struct {
	// Max is the maximum number of requests allowed within the window.
	Max int
	// Window is the time window for rate limiting.
	Window time.Duration
}

type visitor struct {
	count    int
	resetAt  time.Time
}

// RateLimiter is a simple in-memory global rate limiter middleware.
// This is for global request-level protection (IP-based).
// Per-email rate limiting is handled in the OTP service layer via Redis.
type RateLimiter struct {
	cfg      RateLimiterConfig
	visitors map[string]*visitor
	mu       sync.Mutex
}

// NewRateLimiter creates a new RateLimiter middleware.
func NewRateLimiter(cfg RateLimiterConfig) fiber.Handler {
	rl := &RateLimiter{
		cfg:      cfg,
		visitors: make(map[string]*visitor),
	}

	// Periodically clean up expired entries
	go rl.cleanup()

	return rl.handler
}

func (rl *RateLimiter) handler(c *fiber.Ctx) error {
	ip := c.IP()

	rl.mu.Lock()
	v, exists := rl.visitors[ip]
	now := time.Now()

	if !exists || now.After(v.resetAt) {
		rl.visitors[ip] = &visitor{
			count:   1,
			resetAt: now.Add(rl.cfg.Window),
		}
		rl.mu.Unlock()
		return c.Next()
	}

	if v.count >= rl.cfg.Max {
		rl.mu.Unlock()
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
			"success": false,
			"error":   "too many requests, please try again later",
		})
	}

	v.count++
	rl.mu.Unlock()
	return c.Next()
}

func (rl *RateLimiter) cleanup() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		rl.mu.Lock()
		now := time.Now()
		for ip, v := range rl.visitors {
			if now.After(v.resetAt) {
				delete(rl.visitors, ip)
			}
		}
		rl.mu.Unlock()
	}
}
