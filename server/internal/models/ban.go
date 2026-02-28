package models

import "time"

// Ban represents a server ban record.
type Ban struct {
	ServerID  string
	UserID    string
	Reason    string
	BannedBy  *string // nullable: ON DELETE SET NULL when banning admin is deleted
	CreatedAt time.Time
}
