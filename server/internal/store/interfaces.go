package store

import (
	"context"
	"errors"
	"time"

	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/permissions"
	"github.com/jackc/pgx/v5"
)

// ErrNotFound is a sentinel error returned when a requested entity does not exist.
var ErrNotFound = errors.New("not found")

// ErrAlreadyExists is a sentinel error returned when a unique constraint is violated.
var ErrAlreadyExists = errors.New("already exists")

// UpdateUserParams holds parameters for updating a user's profile.
type UpdateUserParams struct {
	UserID               string
	DisplayName          *string
	AvatarURL            *string
	EmojiScale           *float32
	Bio                  *string
	Pronouns             *string
	BannerURL            *string
	ThemeColorPrimary    *string
	ThemeColorSecondary  *string
	SimpleMode           *bool
	AudioPreferences     *models.AudioPreferences
	DMPrivacy            *string
	Connections          []models.UserConnection
	FriendRequestPrivacy *string
	ProfilePrivacy       *string
	DismissedTips        []string // Tips to append (deduplicated by caller)
	ClearDismissedTips   bool     // When true, reset dismissed_tips to '{}'
}

// AuthStorer provides access to user authentication data in Postgres.
type AuthStorer interface {
	CreateUser(ctx context.Context, user *models.User, authKeyHash string, salt []byte, encryptedBundle models.EncryptedBundle) (*models.User, error)
	GetUserByID(ctx context.Context, userID string) (*models.User, error)
	GetUsersByIDs(ctx context.Context, userIDs []string) ([]*models.User, error)
	UpdateUser(ctx context.Context, params UpdateUserParams) (*models.User, error)
	GetAuthDataByUserID(ctx context.Context, userID string) (*models.AuthData, error)
	GetUserByEmail(ctx context.Context, email string) (*models.User, *models.AuthData, error)
	GetUserByUsername(ctx context.Context, username string) (*models.User, *models.AuthData, error)
	GetSalt(ctx context.Context, email string) ([]byte, error)
	GetSaltByUsername(ctx context.Context, username string) ([]byte, error)
	StoreRefreshToken(ctx context.Context, tokenHash, userID, deviceID string, expiresAt time.Time) error
	ConsumeRefreshToken(ctx context.Context, tokenHash string) (userID, deviceID string, err error)
	DeleteRefreshTokensByUser(ctx context.Context, userID string) error
	DeleteRefreshTokensByDevice(ctx context.Context, userID, deviceID string) error
	GetKeyBundle(ctx context.Context, userID string) (*models.EncryptedBundle, error)
	ChangePassword(ctx context.Context, userID, oldAuthKeyHash, newAuthKeyHash string, newSalt []byte, newBundle models.EncryptedBundle) error
	GetRecoveryBundle(ctx context.Context, email string) (recoveryBundle, recoveryIV, salt []byte, err error)
	// RecoverAccount atomically verifies the recovery verifier and resets credentials.
	// verifyVerifier is called with the stored hash inside the transaction; if it returns
	// false, the transaction is rolled back and ErrInvalidRecoveryProof is returned.
	RecoverAccount(ctx context.Context, email, newAuthKeyHash string, newSalt []byte, newBundle models.EncryptedBundle, verifyVerifier func(storedHash []byte) bool, excludeDeviceIDs ...string) (userID string, err error)
}

// ChatStorer provides access to server/channel/member data in Postgres.
type ChatStorer interface {
	CreateServer(ctx context.Context, name, ownerID string, iconURL *string, defaultChannelPrivacy bool) (*models.Server, error)
	GetServer(ctx context.Context, serverID string) (*models.Server, error)
	UpdateServer(ctx context.Context, serverID string, name, iconURL, welcomeMessage, rules *string, onboardingEnabled, rulesRequired, defaultChannelPrivacy *bool) (*models.Server, error)
	ListServers(ctx context.Context, userID string) ([]*models.Server, error)
	CreateChannel(ctx context.Context, serverID, name string, channelType int, isPrivate bool, channelGroupID string) (*models.Channel, error)
	GetChannel(ctx context.Context, channelID string) (*models.Channel, error)
	GetChannelAndCheckMembership(ctx context.Context, channelID, userID string) (*models.Channel, bool, error)
	ListChannels(ctx context.Context, serverID, userID string) ([]*models.Channel, error)
	UpdateChannel(ctx context.Context, channelID string, name, topic *string, position *int, isPrivate *bool, slowModeSeconds *int, isDefault *bool, channelGroupID, contentWarning *string) (*models.Channel, error)
	// UpdateChannelPrivacy atomically updates the channel and manages the
	// ViewChannel permission override on @everyone. When toggling to private it
	// upserts a deny override; when toggling to public it removes it. Both
	// operations run in a single transaction so the channel state and permission
	// overrides are always consistent.
	UpdateChannelPrivacy(ctx context.Context, channelID string, name, topic *string, position *int, isPrivate *bool, slowModeSeconds *int, isDefault *bool, channelGroupID, contentWarning *string, oldIsPrivate bool, everyoneRoleID string, viewChannelPerm int64) (*models.Channel, error)
	DeleteChannel(ctx context.Context, channelID string) error
	// CreateVoiceChannelWithCompanion atomically creates a voice channel and its companion text channel.
	CreateVoiceChannelWithCompanion(ctx context.Context, serverID, name string, isPrivate bool, channelGroupID string) (voiceCh *models.Channel, textCh *models.Channel, err error)
	// DeleteChannelWithCompanion deletes a voice channel and its companion text channel atomically.
	DeleteChannelWithCompanion(ctx context.Context, voiceChannelID, companionChannelID string) error
	// IsVoiceTextCompanion checks if a channel is a companion text channel for a voice channel.
	IsVoiceTextCompanion(ctx context.Context, channelID string) (bool, error)
	// UpdateCompanionChannel syncs fields from a voice channel to its companion text channel.
	UpdateCompanionChannel(ctx context.Context, companionID string, name, topic *string, channelGroupID *string) error
	AddMember(ctx context.Context, userID, serverID string) error
	RemoveMember(ctx context.Context, userID, serverID string) error
	IsMember(ctx context.Context, userID, serverID string) (bool, error)
	GetMemberCount(ctx context.Context, serverID string) (int, error)
	ListMembers(ctx context.Context, serverID string, after string, limit int) ([]*models.Member, error)
	GetUserChannels(ctx context.Context, userID string) ([]string, error)
	GetMember(ctx context.Context, userID, serverID string) (*models.Member, error)
	ListMemberUserIDs(ctx context.Context, serverID string) ([]string, error)
	// DM channel operations.
	CreateDMChannel(ctx context.Context, userID1, userID2, dmStatus, dmInitiatorID string) (*models.Channel, bool, error)
	ListDMChannelsWithParticipants(ctx context.Context, userID string) ([]*models.DMChannelWithParticipants, error)
	CreateGroupDMChannel(ctx context.Context, creatorID, name string, participantIDs []string) (*models.Channel, error)
	GetDMChannelByPairKey(ctx context.Context, userID1, userID2 string) (*models.Channel, error)
	UpdateDMStatus(ctx context.Context, channelID, status string) error
	ListPendingDMRequests(ctx context.Context, recipientID string) ([]*models.DMChannelWithParticipants, error)
	ShareAnyServer(ctx context.Context, userID1, userID2 string) (bool, error)
	GetMutualServers(ctx context.Context, userID1, userID2 string) ([]*models.Server, error)
	GetDMOtherParticipantID(ctx context.Context, channelID, userID string) (string, error)
	// Channel member operations for private channels.
	AddChannelMember(ctx context.Context, channelID, userID string) error
	RemoveChannelMember(ctx context.Context, channelID, userID string) error
	ListChannelMembers(ctx context.Context, channelID string) ([]*models.Member, error)
	ListChannelParticipantIDs(ctx context.Context, channelID string) ([]string, error)
	CountChannelMembers(ctx context.Context, channelID string) (int, error)
	IsChannelMember(ctx context.Context, channelID, userID string) (bool, error)
	RemoveChannelMembersForServer(ctx context.Context, userID, serverID string) error
	ClearChannelMembers(ctx context.Context, channelID string) error
	SetMemberTimeout(ctx context.Context, serverID, userID string, timedOutUntil *time.Time) error
	SetMemberNickname(ctx context.Context, serverID, userID, nickname string) error
	// Onboarding operations.
	AcknowledgeRules(ctx context.Context, userID, serverID string) (time.Time, error)
	CompleteOnboarding(ctx context.Context, userID, serverID string, channelIDs, roleIDs []string) (time.Time, []string, []string, error)
	CheckRulesAcknowledged(ctx context.Context, userID, serverID string) (bool, error)
	GetDefaultChannels(ctx context.Context, serverID string) ([]*models.Channel, error)
	GetSelfAssignableRoles(ctx context.Context, serverID string) ([]*models.Role, error)
	CreateServerFromTemplate(ctx context.Context, params CreateServerFromTemplateParams) (*models.Server, []*models.Channel, []*models.Role, error)
	// System message configuration.
	GetSystemMessageConfig(ctx context.Context, serverID string) (*models.ServerSystemMessageConfig, error)
	UpsertSystemMessageConfig(ctx context.Context, serverID string, opts UpsertSystemMessageConfigOpts) (*models.ServerSystemMessageConfig, error)
}

// UpsertSystemMessageConfigOpts holds optional fields for upserting system message config.
type UpsertSystemMessageConfigOpts struct {
	WelcomeChannelID *string
	ModLogChannelID  *string
	JoinEnabled      *bool
	JoinTemplate     *string
	LeaveEnabled     *bool
	LeaveTemplate    *string
	KickEnabled      *bool
	KickTemplate     *string
	BanEnabled       *bool
	BanTemplate      *string
	TimeoutEnabled   *bool
	TimeoutTemplate  *string
}

// InviteStorer provides access to invite data in Postgres.
type InviteStorer interface {
	CreateInvite(ctx context.Context, serverID, creatorID string, maxUses int, expiresAt *time.Time, encryptedChannelKeys, channelKeysIV []byte) (*models.Invite, error)
	GetInvite(ctx context.Context, code string) (*models.Invite, error)
	ConsumeInvite(ctx context.Context, code string) (*models.Invite, error)
	RevokeInvite(ctx context.Context, code string) error
	ListInvites(ctx context.Context, serverID string) ([]*models.Invite, error)
}

// RoleStorer provides access to role data in Postgres.
type RoleStorer interface {
	CreateRole(ctx context.Context, role *models.Role) (*models.Role, error)
	GetRole(ctx context.Context, roleID string) (*models.Role, error)
	GetRolesByIDs(ctx context.Context, roleIDs []string, serverID string) ([]*models.Role, error)
	ListRoles(ctx context.Context, serverID string) ([]*models.Role, error)
	UpdateRole(ctx context.Context, roleID string, name *string, permissions *int64, color *int, isSelfAssignable *bool) (*models.Role, error)
	DeleteRole(ctx context.Context, roleID string) error
	ReorderRoles(ctx context.Context, serverID string, roleIDs []string, callerPosition int) ([]*models.Role, error)
	GetMemberRoles(ctx context.Context, userID, serverID string) ([]*models.Role, error)
	SetMemberRoles(ctx context.Context, userID, serverID string, roleIDs []string) error
}

// BlockStorer provides access to user block data in Postgres.
type BlockStorer interface {
	BlockUser(ctx context.Context, blockerID, blockedID string) error
	BlockUserTx(ctx context.Context, tx pgx.Tx, blockerID, blockedID string) error
	UnblockUser(ctx context.Context, blockerID, blockedID string) error
	IsBlockedEither(ctx context.Context, userA, userB string) (bool, error)
	ListBlocks(ctx context.Context, blockerID string) ([]string, error)
	ListBlocksWithUsers(ctx context.Context, blockerID string) ([]*models.User, error)
}

// FriendStorer provides access to friendship data in Postgres.
type FriendStorer interface {
	SendFriendRequest(ctx context.Context, requesterID, addresseeID string) (autoAccepted bool, err error)
	AcceptFriendRequest(ctx context.Context, addresseeID, requesterID string) error
	DeclineFriendRequest(ctx context.Context, addresseeID, requesterID string) error
	CancelFriendRequest(ctx context.Context, requesterID, addresseeID string) error
	RemoveFriend(ctx context.Context, userA, userB string) error
	AreFriends(ctx context.Context, userA, userB string) (bool, error)
	ListFriendsWithUsers(ctx context.Context, userID string) ([]*models.User, error)
	ListIncomingRequestsWithUsers(ctx context.Context, userID string) ([]*models.FriendRequest, error)
	ListOutgoingRequestsWithUsers(ctx context.Context, userID string) ([]*models.FriendRequest, error)
	CountPendingOutgoingRequests(ctx context.Context, userID string) (int, error)
	RemoveFriendshipsByUser(ctx context.Context, userID, otherID string) error
	RemoveFriendshipsByUserTx(ctx context.Context, tx pgx.Tx, userID, otherID string) error
	GetMutualFriends(ctx context.Context, userID1, userID2 string) ([]*models.User, error)
}

// BanStorer provides access to ban data in Postgres.
type BanStorer interface {
	// CreateBanAndRemoveMember atomically bans a user AND removes their membership.
	// This crosses the member domain but is necessary for atomicity.
	// callerPosition is re-checked inside the transaction to prevent TOCTOU races.
	CreateBanAndRemoveMember(ctx context.Context, ban *models.Ban, callerPosition int) error
	CreateBan(ctx context.Context, ban *models.Ban) (bool, error)
	IsBanned(ctx context.Context, serverID, userID string) (bool, error)
	DeleteBan(ctx context.Context, serverID, userID string) error
	ListBans(ctx context.Context, serverID string) ([]*models.Ban, error)
}

// PinStorer provides access to pinned message data in Postgres.
type PinStorer interface {
	PinMessage(ctx context.Context, channelID, messageID, pinnedBy string) error
	UnpinMessage(ctx context.Context, channelID, messageID string) error
	GetPinnedMessages(ctx context.Context, channelID string, before time.Time, limit int) ([]*models.PinnedMessage, error)
	IsPinned(ctx context.Context, channelID, messageID string) (bool, error)
}

// EmojiStorer provides access to custom emoji data in Postgres.
type EmojiStorer interface {
	CreateEmoji(ctx context.Context, emoji *models.Emoji, maxPersonal, maxServer int) (*models.Emoji, error)
	GetEmoji(ctx context.Context, emojiID string) (*models.Emoji, error)
	ListEmojis(ctx context.Context, serverID string) ([]*models.Emoji, error)
	ListEmojisByUser(ctx context.Context, userID string) ([]*models.Emoji, error)
	UpdateEmoji(ctx context.Context, emojiID string, name *string) (*models.Emoji, error)
	DeleteEmoji(ctx context.Context, emojiID string) error
	CountEmojisByServer(ctx context.Context, serverID string) (int, error)
	CountEmojisByUser(ctx context.Context, userID string) (int, error)
}

// SoundboardStorer provides access to soundboard sound data in Postgres.
type SoundboardStorer interface {
	CreateSound(ctx context.Context, sound *models.SoundboardSound, maxPersonal, maxServer int) (*models.SoundboardSound, error)
	GetSound(ctx context.Context, soundID string) (*models.SoundboardSound, error)
	ListSoundsByUser(ctx context.Context, userID string) ([]*models.SoundboardSound, error)
	ListSoundsByServer(ctx context.Context, serverID string) ([]*models.SoundboardSound, error)
	UpdateSound(ctx context.Context, soundID string, name string) (*models.SoundboardSound, error)
	DeleteSound(ctx context.Context, soundID string) error
}

// ReactionStorer provides access to message reaction data in Postgres.
type ReactionStorer interface {
	AddReaction(ctx context.Context, r *models.Reaction) error
	RemoveReaction(ctx context.Context, channelID, messageID, userID, emoji string) error
	GetReactionGroups(ctx context.Context, channelID string, messageIDs []string, callerID string) (map[string][]*models.ReactionGroup, error)
	CountUniqueEmojis(ctx context.Context, channelID, messageID string) (int, error)
	RemoveAllMessageReactions(ctx context.Context, channelID, messageID string) error
}

// GetMessagesOpts holds cursor and limit options for GetMessages.
type GetMessagesOpts struct {
	Before string
	After  string
	Around string
	Limit  int
}

// SearchMessagesOpts holds filter and pagination options for SearchMessages.
type SearchMessagesOpts struct {
	ChannelID       string
	AuthorID        string
	HasAttachment   *bool
	MentionedUserID string
	MessageTypes    []uint32 // filter by message type (empty = all types)
	BeforeID        string   // ULID cursor — only messages with ID < this
	AfterID         string   // ULID cursor — only messages with ID > this (forward)
	Limit           int      // default 25, max 100
}

// MessageStorer provides access to message data in ScyllaDB.
type MessageStorer interface {
	InsertMessage(ctx context.Context, msg *models.Message) error
	GetMessage(ctx context.Context, channelID, messageID string) (*models.Message, error)
	GetMessages(ctx context.Context, channelID string, opts GetMessagesOpts) ([]*models.Message, bool, error)
	EditMessage(ctx context.Context, channelID, messageID string, encryptedContent []byte, mentionedUserIDs, mentionedRoleIDs []string, mentionEveryone bool, editedAt time.Time, keyVersion uint32) error
	DeleteMessage(ctx context.Context, channelID, messageID string) error
	BulkDeleteMessages(ctx context.Context, channelID string, messageIDs []string) error
	GetMessagesByIDs(ctx context.Context, channelID string, messageIDs []string) (map[string]*models.Message, error)
	CountMessagesAfter(ctx context.Context, channelID, afterMessageID string) (int32, error)
	SearchMessages(ctx context.Context, opts SearchMessagesOpts) ([]*models.Message, bool, error)
	InsertReplyIndex(ctx context.Context, channelID, replyToID, messageID, authorID string, createdAt time.Time) error
	DeleteReplyIndex(ctx context.Context, channelID, replyToID, messageID string) error
	GetReplies(ctx context.Context, channelID, messageID string, limit int) ([]*models.ReplyEntry, int, error)
}

// ReadStateStorer provides access to channel read state data in Postgres.
type ReadStateStorer interface {
	UpsertReadState(ctx context.Context, userID, channelID, messageID string) error
	GetReadState(ctx context.Context, userID, channelID string) (*models.ReadState, error)
	GetReadStates(ctx context.Context, userID string) ([]models.ReadState, error)
	MarkServerAsRead(ctx context.Context, userID string, channelIDs []string, messageIDs []string) error
}

// AuditLogStorer provides access to audit log data in Postgres.
type AuditLogStorer interface {
	CreateEntry(ctx context.Context, entry *models.AuditLogEntry) error
	ListEntries(ctx context.Context, serverID string, before time.Time, limit int) ([]*models.AuditLogEntry, error)
}

// DeviceStorer provides access to device/push-token data in Postgres.
type DeviceStorer interface {
	UpsertDevice(ctx context.Context, device *models.Device) error
	GetDevice(ctx context.Context, userID, deviceID string) (*models.Device, error)
	GetUserDevices(ctx context.Context, userID string) ([]*models.Device, error)
	GetPushEnabledDevices(ctx context.Context, userID string) ([]*models.Device, error)
	GetPushEnabledDevicesForUsers(ctx context.Context, userIDs []string) (map[string][]*models.Device, error)
	DeleteDevice(ctx context.Context, userID, deviceID string) error
	DeleteAllOtherDevices(ctx context.Context, userID, currentDeviceID string) ([]string, error)
	TouchLastSeen(ctx context.Context, userID, deviceID string) error
	PruneStaleDevices(ctx context.Context, olderThan time.Duration) (int64, error)
}

// NotificationPreferenceStorer provides access to notification preference data in Postgres.
type NotificationPreferenceStorer interface {
	GetPreferences(ctx context.Context, userID string) ([]*models.NotificationPreference, error)
	GetEffectiveLevel(ctx context.Context, userID, serverID, channelID string) (string, error)
	GetEffectiveLevelsForUsers(ctx context.Context, userIDs []string, serverID, channelID string) (map[string]string, error)
	UpsertPreference(ctx context.Context, pref *models.NotificationPreference) error
	DeletePreference(ctx context.Context, userID, scopeType, scopeID string) error
}

// LinkPreviewStorer provides access to link preview data in Postgres.
type LinkPreviewStorer interface {
	UpsertLinkPreview(ctx context.Context, lp *models.LinkPreview) error
	GetLinkPreviewsByHashes(ctx context.Context, urlHashes []string) (map[string]*models.LinkPreview, error)
	SetMessageEmbeds(ctx context.Context, channelID, messageID string, urlHashes []string) error
	DeleteMessageEmbeds(ctx context.Context, channelID, messageID string) error
	BulkDeleteMessageEmbeds(ctx context.Context, channelID string, messageIDs []string) error
	GetEmbedsForMessages(ctx context.Context, channelID string, messageIDs []string) (map[string][]*models.LinkPreview, error)
}

// ChannelGroupStorer provides access to channel group data in Postgres.
type ChannelGroupStorer interface {
	CreateChannelGroup(ctx context.Context, group *models.ChannelGroup) (*models.ChannelGroup, error)
	GetChannelGroup(ctx context.Context, groupID string) (*models.ChannelGroup, error)
	ListChannelGroups(ctx context.Context, serverID string) ([]*models.ChannelGroup, error)
	UpdateChannelGroup(ctx context.Context, groupID string, name *string, position *int) (*models.ChannelGroup, error)
	DeleteChannelGroup(ctx context.Context, groupID string) error
}

// ChannelOverrides holds the separated override data for permission resolution.
type ChannelOverrides struct {
	GroupRoleOverrides   []permissions.Override // category-level role overrides
	ChannelRoleOverrides []permissions.Override // channel-level role overrides
	GroupUserOverride    *permissions.Override  // category-level user override (at most one per user)
	ChannelUserOverride  *permissions.Override  // channel-level user override (at most one per user)
}

// PermissionOverrideStorer provides access to permission override data in Postgres.
type PermissionOverrideStorer interface {
	SetOverride(ctx context.Context, override *models.PermissionOverride) (*models.PermissionOverride, error)
	DeleteOverride(ctx context.Context, targetID, roleID string) error
	DeleteOverrideByUser(ctx context.Context, targetID, userID string) error
	ListOverridesByTarget(ctx context.Context, targetID string) ([]*models.PermissionOverride, error)
	GetEffectiveOverrides(ctx context.Context, channelID string, roleIDs []string) (groupAllow, groupDeny, channelAllow, channelDeny int64, err error)
	// GetAllOverridesForChannel returns all overrides for a channel (split by group/channel,
	// role/user) needed by the centralized permission resolver.
	GetAllOverridesForChannel(ctx context.Context, channelID string, roleIDs []string, userID string) (*ChannelOverrides, error)
	// GetAllOverridesForChannels returns all overrides for multiple channels in a single
	// query, keyed by channel ID. This avoids N+1 queries when resolving permissions in batch.
	GetAllOverridesForChannels(ctx context.Context, channelIDs []string, roleIDs []string, userID string) (map[string]*ChannelOverrides, error)
}

// FederationStorer provides access to federation data in Postgres.
type FederationStorer interface {
	// IsFederatedUser checks if a user ID belongs to a federated shadow user.
	IsFederatedUser(ctx context.Context, userID string) (bool, error)

	// LookupShadowUserID returns the local user ID for a federated shadow user
	// identified by (homeServer, remoteUserID). Returns "", nil if not found.
	LookupShadowUserID(ctx context.Context, homeServer, remoteUserID string) (string, error)

	// FederationJoinTx atomically creates/updates a shadow user, checks bans,
	// and adds guild membership. Returns store.ErrBannedFromServer if banned.
	FederationJoinTx(ctx context.Context, homeServer, remoteUserID, displayName, avatarURL, serverID string) (*models.User, error)

	// UpdateShadowUserProfile updates the display name and avatar URL on a shadow user.
	UpdateShadowUserProfile(ctx context.Context, userID, displayName, avatarURL string) error
}

// KeyEnvelope represents a single ECIES-wrapped channel key for a user.
type KeyEnvelope struct {
	UserID   string
	Envelope []byte // 93 bytes: version(1) || ephemeral_pub(32) || nonce(12) || wrapped_key(48)
}

// VersionedEnvelope is a key envelope tagged with its version.
type VersionedEnvelope struct {
	KeyVersion uint32
	Envelope   []byte
}

// KeyEnvelopeStorer provides access to static channel key envelope data in Postgres.
type KeyEnvelopeStorer interface {
	RegisterPublicKey(ctx context.Context, userID string, publicKey []byte) error
	GetPublicKeys(ctx context.Context, userIDs []string) (map[string][]byte, error)
	StoreKeyEnvelopes(ctx context.Context, channelID string, version uint32, envelopes []KeyEnvelope) error
	GetKeyEnvelopes(ctx context.Context, channelID string, userID string) ([]VersionedEnvelope, error)
	// RotateChannelKey atomically increments the key version and stores new envelopes.
	// Returns the new version. Fails if expectedVersion doesn't match current.
	RotateChannelKey(ctx context.Context, channelID string, expectedVersion uint32, envelopes []KeyEnvelope) (uint32, error)
	// HasChannelKeyVersion reports whether the channel has at least one key version
	// entry, meaning it has been set up for E2EE encryption.
	HasChannelKeyVersion(ctx context.Context, channelID string) (bool, error)
}

// MediaAccessChecker verifies whether a user may access (download) an attachment.
// Returns nil if access is allowed, store.ErrNotFound if denied (to avoid leaking
// existence), or another error on unexpected failures.
type MediaAccessChecker interface {
	CheckAttachmentAccess(ctx context.Context, attachment *models.Attachment, userID string) error
}

// MediaStorer provides access to attachment data in Postgres.
type MediaStorer interface {
	CreateAttachment(ctx context.Context, attachment *models.Attachment) (*models.Attachment, error)
	GetAttachment(ctx context.Context, id string) (*models.Attachment, error)
	GetAttachmentsByIDs(ctx context.Context, attachmentIDs []string) (map[string]*models.Attachment, error)
	CountPendingByUploader(ctx context.Context, uploaderID string) (int, error)
	TransitionToProcessing(ctx context.Context, id, uploaderID string) (*models.Attachment, error)
	UpdateAttachmentCompleted(ctx context.Context, id string, sizeBytes int64, contentType string, width, height int, thumbnailKey string, microThumbnailData string, encryptedKey []byte, isSpoiler bool) error
	DeleteAttachment(ctx context.Context, id string) error
	FindOrphanedUploads(ctx context.Context, before time.Time, limit int) ([]*models.Attachment, error)
	ResetAttachmentToPending(ctx context.Context, id string) error
	LinkAttachments(ctx context.Context, ids []string, channelID string) error
	FindUnlinkedAttachments(ctx context.Context, olderThan time.Time, limit int) ([]*models.Attachment, error)
	NullifyChannelAttachments(ctx context.Context, channelID string) error
}
