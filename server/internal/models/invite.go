package models

import "time"

// Invite represents a server invite code.
type Invite struct {
	Code                 string
	ServerID             string
	CreatorID            string
	MaxUses              int
	UseCount             int
	ExpiresAt            *time.Time // nil = never expires
	Revoked              bool
	CreatedAt            time.Time
	EncryptedChannelKeys []byte // AES-256-GCM encrypted key bundle (optional)
	ChannelKeysIV        []byte // 12-byte IV for decryption (optional)
}
