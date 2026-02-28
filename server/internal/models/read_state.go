package models

import "time"

// ReadState tracks how far a user has read in a channel.
type ReadState struct {
	UserID            string
	ChannelID         string
	LastReadMessageID string
	UpdatedAt         time.Time
}
