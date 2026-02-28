package models

import "time"

// Channel represents a channel within a server.
type Channel struct {
	ID              string
	ServerID        string
	Name            string
	Type            int
	Topic           string
	Position        int
	IsPrivate       bool
	SlowModeSeconds *int // NULL=off, 0=read-only, >0=interval seconds
	IsDefault       bool
	ChannelGroupID  string
	DMStatus        string // "active", "pending", "declined" (DM channels only)
	DMInitiatorID   string // user who initiated the DM request (DM channels only)
	CreatedAt       time.Time
}

// DMChannelWithParticipants holds a DM channel and its participant users.
type DMChannelWithParticipants struct {
	Channel      Channel
	Participants []User
}
