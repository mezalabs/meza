package email

import (
	"context"
	"fmt"

	"github.com/wneessen/go-mail"
)

// SMTPSender sends emails via SMTP using go-mail.
type SMTPSender struct {
	host     string
	port     int
	from     string
	username string
	password string
}

// NewSMTPSender creates a new SMTP email sender.
func NewSMTPSender(host string, port int, from, username, password string) *SMTPSender {
	return &SMTPSender{
		host:     host,
		port:     port,
		from:     from,
		username: username,
		password: password,
	}
}

func (s *SMTPSender) SendOTP(ctx context.Context, to string, code string) error {
	m := mail.NewMsg()
	if err := m.From(s.from); err != nil {
		return fmt.Errorf("set from: %w", err)
	}
	if err := m.To(to); err != nil {
		return fmt.Errorf("set to: %w", err)
	}
	m.Subject("Your Meza verification code")
	m.SetBodyString(mail.TypeTextPlain, fmt.Sprintf(
		"Your Meza verification code is: %s\n\nThis code expires in 5 minutes.\n\nIf you didn't request this, you can safely ignore this email.",
		code,
	))

	// Connect and send with context timeout
	c, err := mail.NewClient(s.host,
		mail.WithPort(s.port),
		mail.WithSMTPAuth(mail.SMTPAuthPlain),
		mail.WithUsername(s.username),
		mail.WithPassword(s.password),
		mail.WithTLSPolicy(mail.TLSOpportunistic),
	)
	if err != nil {
		return fmt.Errorf("create mail client: %w", err)
	}

	if err := c.DialAndSendWithContext(ctx, m); err != nil {
		return fmt.Errorf("send email: %w", err)
	}
	return nil
}
