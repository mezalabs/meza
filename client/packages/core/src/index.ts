export const MEZA_VERSION = '0.0.9';

export type { Device } from '@meza/gen/meza/v1/auth_pb.ts';
export type {
  FriendRequestEntry,
  ReplyEntry,
} from '@meza/gen/meza/v1/chat_pb.ts';
export { UploadPurpose } from '@meza/gen/meza/v1/media_pb.ts';
export type {
  Attachment,
  Channel,
  ChannelGroup,
  CustomEmoji,
  DMChannel,
  Invite,
  LinkEmbed,
  PermissionOverride,
  Role,
  Server,
  ServerSystemMessageConfig,
  User,
} from '@meza/gen/meza/v1/models_pb.ts';
// Re-export protobuf enums used by UI
export { ChannelType, MessageType } from '@meza/gen/meza/v1/models_pb.ts';
export { PresenceStatus } from '@meza/gen/meza/v1/presence_pb.ts';
// API — auth
export {
  changePassword,
  finalizeRegistration,
  getProfile,
  getRecoveryBundle,
  getSalt,
  listDevices,
  login,
  logout,
  recoverAccount,
  refreshAccessToken,
  register,
  revokeAllOtherDevices,
  revokeDevice,
  toStoredUser,
  updateProfile,
} from './api/auth.ts';
// API — chat
export {
  acceptFriendRequest,
  acceptMessageRequest,
  ackMessage,
  acknowledgeRules,
  addChannelMember,
  addReaction,
  banMember,
  blockUser,
  cancelFriendRequest,
  completeOnboarding,
  createChannel,
  createChannelGroup,
  createEmoji,
  createGroupDMChannel,
  createInvite,
  createOrGetDMChannel,
  createRole,
  createServer,
  createServerFromTemplate,
  createSound,
  declineFriendRequest,
  declineMessageRequest,
  deleteChannel,
  deleteChannelGroup,
  deleteEmoji,
  deleteMessage,
  deletePermissionOverride,
  deleteRole,
  deleteSound,
  editMessage,
  getEffectivePermissions,
  getMessages,
  getMessagesByIDs,
  getPinnedMessages,
  getReactions,
  getReplies,
  getServer,
  getSystemMessageConfig,
  joinServer,
  kickMember,
  listBans,
  listBlocks,
  listChannelGroups,
  listChannelMembers,
  listChannels,
  listDMChannels,
  listEmojis,
  listFriendRequests,
  listFriends,
  listMembers,
  listMessageRequests,
  listPermissionOverrides,
  listRoles,
  listServerSounds,
  listServers,
  listUserEmojis,
  listUserSounds,
  pinMessage,
  removeChannelMember,
  removeFriend,
  removeReaction,
  removeTimeout,
  reorderRoles,
  resolveInvite,
  reverseDecline,
  type SearchMessagesParams,
  type SearchMessagesResult,
  searchMessages,
  sendFriendRequest,
  sendMessage,
  setMemberRoles,
  setPermissionOverride,
  timeoutMember,
  type UploadedFile,
  unbanMember,
  unblockUser,
  unpinMessage,
  updateChannel,
  updateChannelGroup,
  updateEmoji,
  updateMember,
  updateRole,
  updateServer,
  updateSound,
  updateSystemMessageConfig,
} from './api/chat.ts';
// API — key distribution
export { getPublicKeys, requestChannelKeys } from './api/keys.ts';
// API — media
export {
  completeUpload,
  createUpload,
  type EncryptedUploadResult,
  fetchEncryptedMedia,
  getDownloadURL,
  getMediaURL,
  resolveIconUrl,
  uploadEncryptedFile,
  uploadFile,
} from './api/media.ts';
// API — notification
export { getVAPIDPublicKey } from './api/notification.ts';
// API — presence
export {
  clearStatusOverride,
  getBulkPresence,
  getMyPresence,
  getPresence,
  setStatusOverride,
  updatePresence,
} from './api/presence.ts';
// API — profile
export {
  getMutualFriends,
  getMutualServers,
  getUserVoiceActivity,
  type StoredServer,
  type VoiceActivity,
} from './api/profile.ts';
// API — voice
export {
  getStreamPreviewToken,
  getVoiceChannelState,
  joinVoiceChannel,
  leaveVoiceChannel,
  mapVoiceError,
} from './api/voice.ts';
// Constants
export { LOBBY_SERVER_ID } from './constants.ts';
// Crypto — E2EE static channel key operations
export {
  type AttachmentMeta,
  // File encryption
  acquireBlobURL,
  aesGcmDecrypt,
  aesGcmEncrypt,
  base64ToUint8,
  bootstrapSession,
  buildMessageContent,
  clearChannelKeyCache,
  clearCryptoStorage,
  createChannelKey,
  createIdentity,
  createInviteKeyBundle,
  type DerivedKeys,
  decryptAndUpdateMessage,
  decryptAndUpdateMessages,
  decryptFile,
  decryptMessage,
  decryptPayload,
  decryptRecoveryBundle,
  deriveKeys,
  deriveRecoveryKey,
  deriveRecoveryVerifier,
  deserializeIdentity,
  distributeKeyToMember,
  type EncryptedMessage,
  edToX25519Public,
  edToX25519Secret,
  encryptFile,
  encryptMessage,
  encryptPayload,
  encryptRecoveryBundle,
  fetchAndCacheChannelKeys,
  flushChannelKeys,
  generateChannelKey,
  generateFileKey,
  generateIdentityKeypair,
  generateImageThumbnail,
  generateRecoveryPhrase,
  generateVideoThumbnail,
  getCachedChannelIds,
  getChannelKey,
  getChannelKeysForServer,
  getIdentity,
  getLatestKeyVersion,
  hasChannelKey,
  type IdentityKeypair,
  importChannelKeys,
  importInviteKeyBundle,
  initChannelKeys,
  isSessionReady,
  lazyInitChannelKey,
  loadCachedChannelKeys,
  loadKeyBundle,
  onCrossTabTeardown,
  onSessionReady,
  type ParsedMessageContent,
  parseMessageContent,
  persistIdentity,
  provisionChannelKeyBatched,
  redistributeChannelKeys,
  registerPublicKey,
  releaseAllBlobURLs,
  releaseBlobURL,
  restoreIdentity,
  rotateChannelKey,
  safeParseMessageText,
  serializeIdentity,
  signMessage,
  storeKeyBundle,
  teardownSession,
  unwrapChannelKey,
  unwrapFileKey,
  validateRecoveryPhrase,
  verifySignature,
  wrapChannelKey,
  wrapFileKey,
  wrapKeyForMembers,
} from './crypto/index.ts';
// Gateway
export {
  connect as gatewayConnect,
  disconnect as gatewayDisconnect,
  sendTyping as gatewaySendTyping,
} from './gateway/gateway.ts';
export * from './keybinds/index.ts';
export {
  clearEmojiCache,
  initEmojiCachePersistence,
  loadEmojiCache,
} from './lib/emojiCache.ts';
// Emoji data & search
export type {
  EmojiGroup,
  ShortcodeMap,
  UnicodeEmoji,
} from './lib/emojiData.ts';
export {
  applySkinTone,
  getAllUnicodeEmojis,
  getEmojiGroups,
  getShortcodes,
  loadEmojiData,
} from './lib/emojiData.ts';
export type {
  CustomSearchResult,
  SearchResult,
  UnicodeSearchResult,
} from './lib/emojiSearch.ts';
export { searchEmojis } from './lib/emojiSearch.ts';
export type { FrequentEmojiEntry } from './lib/frequentEmojis.ts';
export {
  clearFrequentEmojis,
  getFrequentEmojis,
  recordUsage,
} from './lib/frequentEmojis.ts';
// Onboarding templates
export {
  SERVER_TEMPLATES,
  type ServerTemplate,
  type TemplateChannel,
  type TemplateRole,
  VOICE_CHANNELS,
} from './onboarding/templates.ts';
export { subscribeToPush } from './push/push-manager.ts';
// Push notifications
export type { PushAdapter, PushSubscriptionDetails } from './push/types.ts';
// Search
export * from './search/index.ts';
// Sound
export type { SoundType } from './sound/SoundManager.ts';
export { soundManager } from './sound/SoundManager.ts';
// Stores
export type {
  AudioSettingsActions,
  AudioSettingsState,
  NoiseCancellationMode,
} from './store/audioSettings.ts';
export { useAudioSettingsStore } from './store/audioSettings.ts';
export type {
  AuthActions,
  AuthState,
  ConnectionPlatform,
  StoredUser,
  StoredUserConnection,
} from './store/auth.ts';
export { PLATFORM_LABELS, useAuthStore } from './store/auth.ts';
export type { BlockActions, BlockState } from './store/blocks.ts';
export { useBlockStore } from './store/blocks.ts';
export type {
  ChannelGroupActions,
  ChannelGroupState,
} from './store/channel-groups.ts';
export { useChannelGroupStore } from './store/channel-groups.ts';
export type { ChannelActions, ChannelState } from './store/channels.ts';
export { useChannelStore } from './store/channels.ts';
export type { DMActions, DMState } from './store/dms.ts';
export { useDMStore } from './store/dms.ts';
export type { EmojiActions, EmojiState } from './store/emojis.ts';
export {
  cachedServerIds,
  isPersonalFromCache,
  useEmojiStore,
} from './store/emojis.ts';
export type { FriendActions, FriendState } from './store/friends.ts';
export { useFriendStore } from './store/friends.ts';
export type {
  GatewayActions,
  GatewayState,
  GatewayStatus,
} from './store/gateway.ts';
export { useGatewayStore } from './store/gateway.ts';
export type { InviteState } from './store/invite.ts';
export { useInviteStore } from './store/invite.ts';
export type {
  KeybindOverridesActions,
  KeybindOverridesState,
} from './store/keybindOverrides.ts';
export { useKeybindOverridesStore } from './store/keybindOverrides.ts';
export type { MemberActions, MemberState } from './store/members.ts';
export { useMemberStore } from './store/members.ts';
export type { MessageActions, MessageState } from './store/messages.ts';
export { useMessageStore } from './store/messages.ts';
export type {
  NotificationSettingsActions,
  NotificationSettingsState,
} from './store/notificationSettings.ts';
export { useNotificationSettingsStore } from './store/notificationSettings.ts';
export type {
  PermissionOverrideActions,
  PermissionOverrideState,
} from './store/permission-overrides.ts';
export { usePermissionOverrideStore } from './store/permission-overrides.ts';
export type {
  PermCategory,
  PermissionKey,
} from './store/permissions.ts';
export {
  ALL_PERMISSIONS,
  CATEGORY_META,
  CHANNEL_SCOPED_PERMISSIONS,
  CHANNEL_TYPE_CATEGORIES,
  hasPermission,
  PERMISSION_INFO,
  PERMISSIONS_BY_CATEGORY,
  Permissions,
  validateChannelScoped,
  validatePermissions,
} from './store/permissions.ts';
export type { PinActions, PinState } from './store/pins.ts';
export { usePinStore } from './store/pins.ts';
export type {
  PresenceActions,
  PresenceState,
  StatusOverride,
} from './store/presence.ts';
export { usePresenceStore } from './store/presence.ts';
export type { ReactionActions, ReactionState } from './store/reactions.ts';
export { useReactionStore } from './store/reactions.ts';
export type { ReadStateActions, ReadStateState } from './store/read-state.ts';
export { useReadStateStore } from './store/read-state.ts';
export type { RoleActions, RoleState } from './store/roles.ts';
export { useRoleStore } from './store/roles.ts';
export type { ServerActions, ServerState } from './store/servers.ts';
export { useServerStore } from './store/servers.ts';
export type { SoundActions, SoundState } from './store/sounds.ts';
export { useSoundStore } from './store/sounds.ts';
export type {
  ContentHint,
  ScreenSharePresetKey,
  StreamSettingsActions,
  StreamSettingsState,
  ViewerQuality,
} from './store/streamSettings.ts';
export { useStreamSettingsStore } from './store/streamSettings.ts';
export type {
  Toast,
  ToastActions,
  ToastState,
  ToastVariant,
} from './store/toasts.ts';
export { useToastStore } from './store/toasts.ts';
export type { TypingActions, TypingState } from './store/typing.ts';
export { useTypingStore } from './store/typing.ts';
export type { UsersActions, UsersState } from './store/users.ts';
export { useUsersStore } from './store/users.ts';
// Stores — voice
export type { VoiceActions, VoiceState } from './store/voice.ts';
export { useVoiceStore } from './store/voice.ts';
// Stores — voice participants
export type {
  VoiceChannelParticipant,
  VoiceParticipantsActions,
  VoiceParticipantsState,
} from './store/voiceParticipants.ts';
export { useVoiceParticipantsStore } from './store/voiceParticipants.ts';
export * from './tiling/index.ts';
// Types — Electron API
export type { ElectronAPI } from './types/electron.d.ts';
export { getDMDisplayName, isGroupDM } from './utils/dm.ts';
export { canRunGiga, supportsAudioWorklet } from './utils/hardware.ts';
// Utils
export {
  hideKeyboard,
  onKeyboardWillHide,
  onKeyboardWillShow,
} from './utils/keyboard.ts';
export type { DetectedOS } from './utils/os-detection.ts';
export { detectOS, isMobileOS } from './utils/os-detection.ts';
export { getBaseUrl, isCapacitor, isElectron } from './utils/platform.ts';
export { formatRelativeTime, toISO } from './utils/time.ts';
