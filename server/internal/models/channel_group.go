package models

import "time"

// ChannelGroup represents a channel category within a server.
type ChannelGroup struct {
	ID        string
	ServerID  string
	Name      string
	Position  int
	CreatedAt time.Time
}
