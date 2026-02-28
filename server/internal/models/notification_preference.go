package models

import "time"

// NotificationPreference stores a user's notification level for a scope.
type NotificationPreference struct {
	UserID    string
	ScopeType string // "global", "server", "channel"
	ScopeID   string // empty for global, server_id or channel_id
	Level     string // "all", "mentions_only", "nothing"
	UpdatedAt time.Time
}
