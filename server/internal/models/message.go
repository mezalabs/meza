package models

import "time"

// Message represents a chat message stored in ScyllaDB.
type Message struct {
	ChannelID        string
	MessageID        string
	AuthorID         string
	EncryptedContent []byte
	AttachmentIDs    []string
	ReplyToID        string // empty string means "not a reply"
	MentionedUserIDs []string
	MentionedRoleIDs []string
	MentionEveryone  bool
	CreatedAt        time.Time
	EditedAt         time.Time
	Deleted          bool
	KeyVersion       uint32 // Static channel key version (0 = unencrypted)
	MessageType      uint32 // 0=user, 1=system
}

const (
	MessageTypeUser   uint32 = 0
	MessageTypeSystem uint32 = 1
)

// ReplyEntry represents a single reply in the message_replies index table.
type ReplyEntry struct {
	MessageID string
	AuthorID  string
	CreatedAt time.Time
}
