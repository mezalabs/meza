package models

import "time"

// Emoji represents a custom emoji (server-scoped or personal).
type Emoji struct {
	ID           string
	ServerID     string // empty for personal emojis
	UserID       string // owner
	Name         string
	AttachmentID string
	Animated     bool
	CreatorID    string
	CreatedAt    time.Time
}
