package models

import "time"

// Reaction represents a single user's reaction to a message.
type Reaction struct {
	ChannelID string
	MessageID string
	UserID    string
	Emoji     string
	CreatedAt time.Time
}

// ReactionGroup is the aggregated view of reactions for a single emoji on a message.
type ReactionGroup struct {
	Emoji   string
	Me      bool
	UserIDs []string
}
