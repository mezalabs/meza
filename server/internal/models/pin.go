package models

import "time"

// PinnedMessage represents a pinned message reference in PostgreSQL.
type PinnedMessage struct {
	ChannelID string
	MessageID string
	PinnedBy  *string // nil if pinner's account was deleted
	PinnedAt  time.Time
}
