package models

import "time"

// SoundboardSound represents a personal or server soundboard sound.
type SoundboardSound struct {
	ID           string
	UserID       string
	ServerID     string // empty for personal sounds
	Name         string
	AttachmentID string
	CreatedAt    time.Time
}
