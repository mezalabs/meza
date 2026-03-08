package email

import (
	"context"
)

// Sender sends transactional emails.
type Sender interface {
	SendOTP(ctx context.Context, to string, code string) error
}
