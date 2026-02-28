package models

import (
	"encoding/json"
	"time"
)

// AuditLogEntry represents a single moderation action in the audit log.
type AuditLogEntry struct {
	ID         string
	ServerID   string
	Action     string
	ActorID    string
	TargetID   *string
	TargetType *string
	Metadata   json.RawMessage
	CreatedAt  time.Time
}
