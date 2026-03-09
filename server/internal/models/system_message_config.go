package models

import "time"

// ServerSystemMessageConfig stores per-server system message routing and template settings.
type ServerSystemMessageConfig struct {
	ServerID         string
	WelcomeChannelID *string
	ModLogChannelID  *string
	JoinEnabled      bool
	JoinTemplate     *string
	LeaveEnabled     bool
	LeaveTemplate    *string
	KickEnabled      bool
	KickTemplate     *string
	BanEnabled       bool
	BanTemplate      *string
	TimeoutEnabled   bool
	TimeoutTemplate  *string
	UpdatedAt        time.Time
}
