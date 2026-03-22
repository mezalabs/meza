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

// BotInvite represents a bot invite link with requested permissions.
type BotInvite struct {
	Code                 string
	BotID                string
	RequestedPermissions int64
	CreatorID            string
	CreatedAt            time.Time
	ExpiresAt            time.Time
}

// IncomingWebhook represents a channel-bound incoming webhook for a bot.
type IncomingWebhook struct {
	ID         string
	BotUserID  string
	ServerID   string
	ChannelID  string
	SecretHash []byte
	CreatorID  string
	CreatedAt  time.Time
}
