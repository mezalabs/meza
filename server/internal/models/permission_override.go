package models

// PermissionOverride represents a permission override for a channel group or channel.
// Either RoleID or UserID is set (mutually exclusive): role overrides apply to all members
// with that role, user overrides apply to a specific user.
type PermissionOverride struct {
	ID             string
	ChannelGroupID string // set if this override targets a channel group
	ChannelID      string // set if this override targets a channel
	RoleID         string // set for role overrides
	UserID         string // set for user overrides
	Allow          int64
	Deny           int64
}
