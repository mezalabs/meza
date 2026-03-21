package models

import "time"

// BotToken represents a hashed API token for a bot user.
type BotToken struct {
	ID         string
	BotUserID  string
	TokenHash  []byte
	CreatedAt  time.Time
	LastUsedAt *time.Time
	Revoked    bool
}

// BotWebhook represents an outgoing webhook configuration for a bot.
type BotWebhook struct {
	ID        string
	BotUserID string
	ServerID  string
	URL       string
	Secret    []byte
	CreatedAt time.Time
}
