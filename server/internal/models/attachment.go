package models

import "time"

// Attachment represents a file upload record.
type Attachment struct {
	ID                  string
	UploaderID          string
	UploadPurpose       string
	ObjectKey           string
	ThumbnailKey        string
	Filename            string
	ContentType         string
	OriginalContentType string
	SizeBytes           int64
	Width               int
	Height              int
	Status              string
	MicroThumbnailData  string
	EncryptedKey        []byte
	IsSpoiler           bool
	ChannelID           *string // set when a chat_attachment is linked to a message
	CreatedAt           time.Time
	UpdatedAt           time.Time
	CompletedAt         *time.Time
	ExpiresAt           *time.Time
	LinkedAt            *time.Time
}

const (
	AttachmentStatusPending    = "pending"
	AttachmentStatusProcessing = "processing"
	AttachmentStatusCompleted  = "completed"
)
