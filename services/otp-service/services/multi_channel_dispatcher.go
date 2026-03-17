package services

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/atto-sound/otp-service/providers"
)

// DeliveryTarget describes a single channel delivery attempt.
type DeliveryTarget struct {
	ChannelName string
	Provider    providers.DeliveryProvider
	Destination string
}

// OTPTarget is the resolved delivery plan for a multi-channel OTP request.
// PrimaryIdentifier is the Redis key owner (for rate-limit + OTP storage).
// Targets is the list of channels to send to concurrently.
type OTPTarget struct {
	PrimaryIdentifier string
	Targets           []DeliveryTarget
}

// dispatchResult holds the outcome of a single channel delivery.
type dispatchResult struct {
	channelName string
	err         error
}

// MultiChannelDispatcher fans out OTP delivery to all configured channels concurrently.
// At-least-one-success semantics: returns nil if any channel succeeds.
type MultiChannelDispatcher struct {
	timeout time.Duration
}

// NewMultiChannelDispatcher creates a dispatcher with the given per-request timeout.
func NewMultiChannelDispatcher(timeout time.Duration) *MultiChannelDispatcher {
	return &MultiChannelDispatcher{timeout: timeout}
}

// Send delivers message to all targets concurrently.
// Returns nil if at least one channel succeeds.
// Returns a combined error if ALL channels fail.
func (d *MultiChannelDispatcher) Send(ctx context.Context, targets []DeliveryTarget, message, locale, emailTemplate string) error {
	if len(targets) == 0 {
		return fmt.Errorf("no delivery targets configured")
	}

	// Single target: synchronous fast path, no goroutine overhead.
	if len(targets) == 1 {
		t := targets[0]
		if err := t.Provider.Send(t.Destination, message, locale, emailTemplate); err != nil {
			return fmt.Errorf("failed to send OTP: %w", err)
		}
		return nil
	}

	// Multi-target: fan-out with per-request timeout.
	ctx, cancel := context.WithTimeout(ctx, d.timeout)
	defer cancel()

	results := make(chan dispatchResult, len(targets))
	var wg sync.WaitGroup

	for _, t := range targets {
		wg.Add(1)
		go func(target DeliveryTarget) {
			defer wg.Done()
			err := target.Provider.Send(target.Destination, message, locale, emailTemplate)
			if err != nil {
				log.Printf("[DISPATCH] Channel %s failed for %s: %v", target.ChannelName, target.Destination, err)
			} else {
				log.Printf("[DISPATCH] Channel %s succeeded for %s", target.ChannelName, target.Destination)
			}
			results <- dispatchResult{channelName: target.ChannelName, err: err}
		}(t)
	}

	// Close the results channel once all goroutines finish.
	go func() {
		wg.Wait()
		close(results)
	}()

	var failedChannels []string
	successCount := 0

	for r := range results {
		if r.err != nil {
			failedChannels = append(failedChannels, fmt.Sprintf("%s: %v", r.channelName, r.err))
		} else {
			successCount++
		}
	}

	if successCount > 0 {
		if len(failedChannels) > 0 {
			// Partial success: log failures but don't propagate to caller.
			log.Printf("[DISPATCH] %d channel(s) failed (non-fatal): %s", len(failedChannels), strings.Join(failedChannels, "; "))
		}
		return nil
	}

	// All channels failed.
	return fmt.Errorf("all delivery channels failed: %s", strings.Join(failedChannels, "; "))
}
