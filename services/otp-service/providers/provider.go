package providers

import (
	"log"

	"github.com/atto-sound/otp-service/config"
)

// DeliveryProvider sends OTP codes to a destination (phone number or console).
type DeliveryProvider interface {
	Send(destination, message string) error
}

// ── Console Provider (Development) ──

// ConsoleProvider logs OTP messages to stdout instead of sending them.
// Intended for development and testing.
type ConsoleProvider struct{}

// NewConsoleProvider creates a new ConsoleProvider.
func NewConsoleProvider() *ConsoleProvider {
	return &ConsoleProvider{}
}

// Send logs the SMS details to the console.
func (p *ConsoleProvider) Send(destination, message string) error {
	log.Printf("[SMS-CONSOLE] To: %s", destination)
	log.Printf("[SMS-CONSOLE] Message:\n%s", message)
	return nil
}

// NewDeliveryProvider creates the appropriate DeliveryProvider based on configuration.
func NewDeliveryProvider(cfg *config.Config) DeliveryProvider {
	switch cfg.DeliveryProvider {
	case "twilio":
		log.Println("[DELIVERY] Using Twilio SMS provider")
		return NewTwilioSMSProvider(cfg.TwilioAccountSID, cfg.TwilioAuthToken, cfg.TwilioFromPhone)
	default:
		log.Println("[DELIVERY] Using console provider (development mode)")
		return NewConsoleProvider()
	}
}
