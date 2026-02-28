package models

import "time"

// Member represents a server member with their role assignments.
type Member struct {
	UserID                string
	ServerID              string
	RoleIDs               []string
	Nickname              string
	JoinedAt              time.Time
	TimedOutUntil         *time.Time
	OnboardingCompletedAt *time.Time
	RulesAcknowledgedAt   *time.Time
}
