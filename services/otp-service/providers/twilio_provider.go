package providers

import (
	"fmt"
	"log"

	"github.com/twilio/twilio-go"
	openapi "github.com/twilio/twilio-go/rest/api/v2010"
)

// TwilioSMSProvider sends OTP codes via Twilio SMS.
type TwilioSMSProvider struct {
	client    *twilio.RestClient
	fromPhone string
}

// NewTwilioSMSProvider creates a new TwilioSMSProvider.
func NewTwilioSMSProvider(accountSID, authToken, fromPhone string) *TwilioSMSProvider {
	client := twilio.NewRestClientWithParams(twilio.ClientParams{
		Username: accountSID,
		Password: authToken,
	})
	return &TwilioSMSProvider{
		client:    client,
		fromPhone: fromPhone,
	}
}

// Send sends an SMS message to the given phone number via Twilio.
func (p *TwilioSMSProvider) Send(destination, message string) error {
	params := &openapi.CreateMessageParams{}
	params.SetTo(destination)
	params.SetFrom(p.fromPhone)
	params.SetBody(message)

	resp, err := p.client.Api.CreateMessage(params)
	if err != nil {
		return fmt.Errorf("twilio SMS failed: %w", err)
	}

	log.Printf("[TWILIO] SMS sent to %s (SID: %s)", destination, *resp.Sid)
	return nil
}
