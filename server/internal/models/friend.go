package models

import "time"

// FriendRequest represents a pending friend request with the other user's info.
type FriendRequest struct {
	User      *User
	Direction string // "incoming" or "outgoing"
	CreatedAt time.Time
}
