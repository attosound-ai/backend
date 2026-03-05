package providers

import (
	"fmt"
	"log"
	"net/smtp"
)

// EmailProvider sends OTP codes via SMTP email.
type EmailProvider struct {
	host     string
	port     string
	user     string
	password string
	from     string
}

// NewEmailProvider creates a new EmailProvider.
func NewEmailProvider(host, port, user, password, from string) *EmailProvider {
	return &EmailProvider{
		host:     host,
		port:     port,
		user:     user,
		password: password,
		from:     from,
	}
}

// Send sends an email message to the given address via SMTP.
func (p *EmailProvider) Send(destination, message string) error {
	auth := smtp.PlainAuth("", p.user, p.password, p.host)
	subject := "Your Atto Sound Verification Code"
	body := fmt.Sprintf(
		"From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n%s",
		p.from, destination, subject, message,
	)
	addr := p.host + ":" + p.port
	if err := smtp.SendMail(addr, auth, p.from, []string{destination}, []byte(body)); err != nil {
		return fmt.Errorf("email send failed: %w", err)
	}
	log.Printf("[EMAIL] Verification code sent to %s", destination)
	return nil
}
