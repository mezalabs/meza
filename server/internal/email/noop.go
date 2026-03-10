package email

import (
	"context"
	"log/slog"
)

// NoopSender logs emails instead of sending them. Used in development.
type NoopSender struct{}

func NewNoopSender() *NoopSender {
	return &NoopSender{}
}

func (s *NoopSender) SendOTP(_ context.Context, to string, _ string) error {
	slog.Info("OTP email (noop)", "to", "[redacted]")
	return nil
}
