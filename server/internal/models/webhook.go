package models

import "time"

// Webhook represents an incoming webhook that can post messages to a channel.
type Webhook struct {
	ID        string
	ChannelID string
	ServerID  string
	Name      string
	AvatarURL string
	TokenHash []byte // SHA-256
	CreatedBy string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// WebhookDelivery records a single webhook POST attempt for debugging.
type WebhookDelivery struct {
	ID                 string
	WebhookID          string
	Success            bool
	ErrorCode          string
	RequestBodyPreview string
	MessageID          string
	SourceIP           string
	LatencyMs          int
	CreatedAt          time.Time
}
