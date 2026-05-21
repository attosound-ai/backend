package providers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"time"
)

// HttpEmailProvider sends OTP emails via the centralized email-service.
type HttpEmailProvider struct {
	emailServiceURL string
	httpClient      *http.Client
}

// NewHttpEmailProvider creates a new HttpEmailProvider.
func NewHttpEmailProvider(emailServiceURL string) *HttpEmailProvider {
	return &HttpEmailProvider{
		emailServiceURL: emailServiceURL,
		httpClient: &http.Client{
			// Resend (downstream of email-service) routinely takes 5–8 s on
			// cold paths. A 5 s budget here surfaces the request to the user
			// as "verification failed" even when the email is *actually*
			// delivered moments later. 20 s gives Resend headroom without
			// pinning the request handler indefinitely.
			Timeout: 20 * time.Second,
		},
	}
}

// codeRegex extracts a 4-8 digit code from the OTP message.
var codeRegex = regexp.MustCompile(`\b(\d{4,8})\b`)

// Send sends an OTP email by calling the appropriate endpoint on the email-service.
// When emailTemplate is "password-reset", it calls /internal/email/password-reset;
// otherwise it calls /internal/email/otp.
func (p *HttpEmailProvider) Send(destination, message, locale, emailTemplate string) error {
	if locale == "" {
		locale = "en"
	}
	// Extract the OTP code from the message
	code := ""
	matches := codeRegex.FindStringSubmatch(message)
	if len(matches) > 1 {
		code = matches[1]
	}
	if code == "" {
		return fmt.Errorf("could not extract OTP code from message")
	}

	payload := map[string]interface{}{
		"to":             destination,
		"code":           code,
		"expiresMinutes": 10,
		"locale":         locale,
	}
	if emailTemplate != "" && emailTemplate != "password-reset" {
		payload["purpose"] = emailTemplate
	}
	jsonBody, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal email request: %w", err)
	}

	endpoint := "/internal/email/otp"
	if emailTemplate == "password-reset" {
		endpoint = "/internal/email/password-reset"
	}
	url := fmt.Sprintf("%s%s", p.emailServiceURL, endpoint)
	resp, err := p.httpClient.Post(url, "application/json", bytes.NewReader(jsonBody))
	if err != nil {
		return fmt.Errorf("email-service request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("email-service returned status %d", resp.StatusCode)
	}

	log.Printf("[EMAIL-HTTP] OTP email sent to %s via email-service", destination)
	return nil
}
