package models

import (
	"encoding/json"
	"time"
)

// Report categories. Mirrors the ReportCategory enum in chat.proto and the
// CHECK constraint in the reports table.
const (
	ReportCategorySpam       = "spam"
	ReportCategoryHarassment = "harassment"
	ReportCategoryHate       = "hate"
	ReportCategorySexual     = "sexual"
	ReportCategoryViolence   = "violence"
	ReportCategorySelfHarm   = "self_harm"
	ReportCategoryIllegal    = "illegal"
	ReportCategoryOther      = "other"
)

// Report statuses.
const (
	ReportStatusOpen      = "open"
	ReportStatusResolved  = "resolved"
	ReportStatusDismissed = "dismissed"
)

// Resolution actions.
const (
	ReportActionResolved  = "resolved"
	ReportActionDismissed = "dismissed"
	ReportActionReopen    = "reopen"
)

// Report represents an in-app content report row.
//
// Snapshot fields are captured at report-submit time so that the report stays
// reviewable even if the underlying message is later deleted by the author,
// retention, or a moderator. Privacy-sensitive: ReporterID is never exposed
// to anyone except the reporter themselves and holders of MANAGE_REPORTS in
// the routing server (or platform admins for null-server reports).
type Report struct {
	ID                        string
	ReporterID                *string // nullable: SET NULL on user deletion
	TargetUserID              *string // nullable: SET NULL on user deletion
	TargetMessageID           *string // ScyllaDB ULID; no FK
	TargetChannelID           *string // nullable: SET NULL on channel deletion
	ServerID                  *string // nullable: NULL means platform queue
	SnapshotContent           string
	SnapshotAuthorUsername    string
	SnapshotAuthorDisplayName string
	SnapshotAttachments       json.RawMessage
	SnapshotMessageEditedAt   *time.Time
	SnapshotPurgedAt          *time.Time
	Category                  string
	Reason                    *string
	Status                    string
	ClaimedBy                 *string
	ClaimedAt                 *time.Time
	AcknowledgedAt            *time.Time
	IdempotencyKey            *string
	CreatedAt                 time.Time
}

// ReportResolution represents a single mod action against a report.
// Append-only — resolve, dismiss, and reopen all create a new row.
type ReportResolution struct {
	ID          string
	ReportID    string
	ModeratorID *string // nullable: SET NULL on user deletion
	Action      string
	Note        *string
	CreatedAt   time.Time
}
