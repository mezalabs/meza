package models

import "time"

// Server represents a chat server (guild).
type Server struct {
	ID                     string
	Name                   string
	IconURL                *string
	OwnerID                string
	CreatedAt              time.Time
	WelcomeMessage         *string
	Rules                  *string
	OnboardingEnabled      bool
	RulesRequired          bool
	DefaultChannelPrivacy  bool
	JoinMessageEnabled     bool
	JoinMessageTemplate    string
	JoinMessageChannelID   *string
}
