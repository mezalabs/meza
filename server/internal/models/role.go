package models

import "time"

// Role represents a server role with permissions.
type Role struct {
	ID               string
	ServerID         string
	Name             string
	Permissions      int64
	Color            int
	Position         int
	IsSelfAssignable bool
	CreatedAt        time.Time
}
