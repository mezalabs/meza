import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { ChatService } from '@meza/gen/meza/v1/chat_pb.ts';
import {
  AttachmentSchema,
  ChannelType,
  type CustomEmoji,
  type DMChannel,
  MessageSchema,
} from '@meza/gen/meza/v1/models_pb.ts';
import {
  createChannelKey,
  getIdentity,
  hasChannelKey,
  isSessionReady,
  provisionChannelKeyBatched,
  redistributeChannelKeys,
  wrapKeyForMembers,
} from '../crypto/index.ts';
import { useAuthStore } from '../store/auth.ts';
import { useBlockStore } from '../store/blocks.ts';
import { useChannelGroupStore } from '../store/channel-groups.ts';
import { useChannelStore } from '../store/channels.ts';
import { useDMStore } from '../store/dms.ts';
import {
  markPersonalRefreshed,
  markServerRefreshed,
  useEmojiStore,
} from '../store/emojis.ts';
import { useFriendStore } from '../store/friends.ts';
import { useInviteStore } from '../store/invite.ts';
import { useMemberStore } from '../store/members.ts';
import { useMessageStore } from '../store/messages.ts';
import { Permissions } from '../store/permissions.ts';
import { usePinStore } from '../store/pins.ts';
import { useReactionStore } from '../store/reactions.ts';
import { useRoleStore } from '../store/roles.ts';
import { useServerStore } from '../store/servers.ts';
import { useSoundStore } from '../store/sounds.ts';
import { useUsersStore } from '../store/users.ts';
import { publicUserToStored, toStoredUser } from './auth.ts';
import { transport } from './client.ts';
import { getPublicKeys, storeKeyEnvelopes } from './keys.ts';

const chatClient = createClient(ChatService, transport);

/** Decode a base64url string (no padding) to bytes. */
function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/**
 * Provision the initial encryption key for a newly created encrypted channel.
 * Generates a channel key, wraps it for the specified members, and uploads envelopes.
 */
async function provisionChannelKey(
  channelId: string,
  memberUserIds: string[],
): Promise<void> {
  if (!isSessionReady()) return;
  const identity = getIdentity();
  if (!identity) return;

  const { key, version } = createChannelKey(channelId);
  const pubKeys = await getPublicKeys(memberUserIds);
  const memberPubKeys = new Map<string, Uint8Array>();
  for (const userId of memberUserIds) {
    const pk = pubKeys[userId];
    if (pk) memberPubKeys.set(userId, pk);
  }
  if (memberPubKeys.size === 0) return;

  const envelopes = await wrapKeyForMembers(channelId, key, memberPubKeys);
  await storeKeyEnvelopes(channelId, version, envelopes);
}

function mapChatError(err: unknown): string {
  if (err instanceof ConnectError) {
    switch (err.code) {
      case Code.PermissionDenied:
        return 'You do not have access';
      case Code.NotFound:
        return 'Not found';
      case Code.InvalidArgument:
        return 'Invalid input. Please check your request.';
      case Code.AlreadyExists:
        return 'You are already a member of this server';
      case Code.ResourceExhausted:
        return 'Limit reached. Please try again later.';
      case Code.Unauthenticated:
        return 'Your session has expired. Please log in again.';
      case Code.Internal:
        return 'Something went wrong. Please try again.';
      default:
        console.error('Unmapped ConnectError:', err.code, err.message);
        return 'Something went wrong. Please try again.';
    }
  }
  return 'Network error. Please check your connection.';
}

export async function listServers() {
  const store = useServerStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const res = await chatClient.listServers({});
    store.setServers(res.servers);
    return res.servers;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function createServer(name: string, iconUrl?: string) {
  const store = useServerStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const res = await chatClient.createServer({ name, iconUrl });
    if (res.server) {
      store.addServer(res.server);
    }
    store.setLoading(false);
    return res.server;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function listChannels(serverId: string) {
  const store = useChannelStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const res = await chatClient.listChannels({ serverId });
    store.setChannels(serverId, res.channels);
    return res.channels;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function createChannel(
  serverId: string,
  name: string,
  type: ChannelType = ChannelType.TEXT,
  isPrivate = false,
  channelGroupId?: string,
) {
  const store = useChannelStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const res = await chatClient.createChannel({
      serverId,
      name,
      type,
      isPrivate,
      channelGroupId,
    });
    if (res.channel) {
      store.addChannel(res.channel);
      // Provision encryption key for all new channels (universal E2EE)
      try {
        if (isPrivate) {
          // Private channels: only the creator initially has access
          const userId = useAuthStore.getState().user?.id;
          if (userId) {
            await provisionChannelKey(res.channel.id, [userId]);
          }
        } else {
          // Public channels: distribute to all members with ViewChannel
          await provisionChannelKeyBatched(res.channel.id);
        }
      } catch (err) {
        console.error('[E2EE] Failed to provision key for new channel:', err);
      }
    }
    store.setLoading(false);
    return res.channel;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function getMessages(
  channelId: string,
  opts?: { before?: string; after?: string; around?: string; limit?: number },
) {
  const store = useMessageStore.getState();
  store.setLoading(channelId, true);
  store.setError(channelId, null);
  try {
    const limit = opts?.limit ?? 50;
    const res = await chatClient.getMessages({
      channelId,
      before: opts?.before ?? '',
      after: opts?.after ?? '',
      around: opts?.around ?? '',
      limit,
    });
    if (opts?.around) {
      // Around replaces the entire message window
      store.setMessages(channelId, res.messages);
    } else if (opts?.before) {
      store.prependMessages(channelId, res.messages);
    } else {
      store.setMessages(channelId, res.messages);
    }
    // Use server-provided hasMore instead of length heuristic
    store.setHasMore(channelId, res.hasMore);
    store.setLoading(channelId, false);
    return res;
  } catch (err) {
    store.setError(channelId, mapChatError(err));
    throw err;
  }
}

export async function createInvite(
  serverId: string,
  keyBundle?: { encryptedChannelKeys: Uint8Array; channelKeysIv: Uint8Array },
) {
  try {
    const res = await chatClient.createInvite({
      serverId,
      maxUses: 0,
      maxAgeSeconds: 86400 * 7,
      encryptedChannelKeys: keyBundle?.encryptedChannelKeys ?? new Uint8Array(),
      channelKeysIv: keyBundle?.channelKeysIv ?? new Uint8Array(),
    });
    return res.invite;
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function resolveInvite(code: string) {
  try {
    return await chatClient.resolveInvite({ code });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function joinServer(inviteCode: string) {
  try {
    const res = await chatClient.joinServer({ inviteCode });
    if (res.server) {
      useServerStore.getState().addServer(res.server);
    }

    // Import E2EE key bundle if the invite included one and we have the secret
    const { inviteSecret, setInviteSecret } = useInviteStore.getState();
    if (
      inviteSecret &&
      res.encryptedChannelKeys.length > 0 &&
      res.channelKeysIv.length > 0
    ) {
      try {
        const { importInviteKeyBundle } = await import(
          '../crypto/invite-keys.ts'
        );
        const secretBytes = base64UrlToBytes(inviteSecret);
        try {
          await importInviteKeyBundle(
            secretBytes,
            res.encryptedChannelKeys,
            res.channelKeysIv,
          );
        } finally {
          secretBytes.fill(0);
        }
      } catch (err) {
        // Non-fatal: keys will be distributed by online members as fallback
        console.warn('[E2EE] Failed to import invite key bundle:', err);
      }
      setInviteSecret(null);
    }

    return res.server;
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function listMembers(
  serverId: string,
  opts?: { after?: string; limit?: number },
) {
  const store = useMemberStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const res = await chatClient.listMembers({
      serverId,
      after: opts?.after ?? '',
      limit: opts?.limit ?? 200,
    });
    store.setMembers(serverId, res.members);
    // Bulk-hydrate user profiles from the sidecar (avoids N+1 getProfile calls).
    if (res.users?.length > 0) {
      useUsersStore.getState().setProfiles(res.users.map(publicUserToStored));
    }
    return res.members;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function editMessage(params: {
  channelId: string;
  messageId: string;
  encryptedContent: Uint8Array;
  keyVersion?: number;
}) {
  try {
    const res = await chatClient.editMessage({
      channelId: params.channelId,
      messageId: params.messageId,
      encryptedContent: params.encryptedContent,
      keyVersion: params.keyVersion ?? 0,
    });
    // Store update handled by gateway messageUpdate event to avoid double-apply race.
    return { editedAt: res.editedAt };
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function deleteMessage(channelId: string, messageId: string) {
  try {
    await chatClient.deleteMessage({ channelId, messageId });
    // Store update handled by gateway messageDelete event to avoid double-remove race.
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function updateChannel(
  channelId: string,
  updates: {
    name?: string;
    topic?: string;
    position?: number;
    isPrivate?: boolean;
    slowModeSeconds?: number;
    isDefault?: boolean;
    channelGroupId?: string;
    contentWarning?: string;
  },
) {
  const store = useChannelStore.getState();
  store.setError(null);
  try {
    const res = await chatClient.updateChannel({ channelId, ...updates });
    if (res.channel) {
      store.updateChannel(res.channel);
    }
    return res.channel;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function deleteChannel(channelId: string) {
  const store = useChannelStore.getState();
  store.setError(null);
  try {
    await chatClient.deleteChannel({ channelId });
    store.removeChannel(channelId);
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export interface UploadedFile {
  attachmentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  url: string;
  hasThumbnail: boolean;
  width: number;
  height: number;
  microThumbnail: Uint8Array;
}

export async function sendMessage(params: {
  channelId: string;
  encryptedContent: Uint8Array;
  keyVersion?: number;
  nonce: string;
  plaintext?: Uint8Array;
  uploadedFiles?: UploadedFile[];
  replyToId?: string;
  mentionedUserIds?: string[];
  mentionedRoleIds?: string[];
  mentionEveryone?: boolean;
}) {
  try {
    const attachmentIds =
      params.uploadedFiles?.map((f) => f.attachmentId) ?? [];
    const res = await chatClient.sendMessage({
      channelId: params.channelId,
      encryptedContent: params.encryptedContent,
      keyVersion: params.keyVersion ?? 0,
      nonce: params.nonce,
      attachmentIds,
      replyToId: params.replyToId,
      mentionedUserIds: params.mentionedUserIds ?? [],
      mentionedRoleIds: params.mentionedRoleIds ?? [],
      mentionEveryone: params.mentionEveryone ?? false,
    });

    // Build attachment protos for optimistic rendering
    const attachments = (params.uploadedFiles ?? []).map((f) =>
      create(AttachmentSchema, {
        id: f.attachmentId,
        filename: f.filename,
        contentType: f.contentType,
        sizeBytes: BigInt(f.sizeBytes),
        url: f.url,
        hasThumbnail: f.hasThumbnail,
        width: f.width,
        height: f.height,
        microThumbnail: f.microThumbnail,
      }),
    );

    // Add the sent message to the store so it appears immediately.
    // Use plaintext for the optimistic message so the sender sees their own
    // content without waiting for the gateway echo + decrypt round-trip.
    const authorId = useAuthStore.getState().user?.id ?? '';
    const optimisticMsg = create(MessageSchema, {
      id: res.messageId,
      channelId: params.channelId,
      authorId,
      encryptedContent: params.plaintext ?? params.encryptedContent,
      keyVersion: 0,
      attachments,
      createdAt: res.createdAt,
      replyToId: params.replyToId,
      mentionedUserIds: params.mentionedUserIds ?? [],
      mentionedRoleIds: params.mentionedRoleIds ?? [],
      mentionEveryone: params.mentionEveryone ?? false,
    });
    const store = useMessageStore.getState();
    store.addMessage(params.channelId, optimisticMsg);

    return res;
  } catch (err) {
    useMessageStore.getState().setError(params.channelId, mapChatError(err));
    throw err;
  }
}

export async function getReplies(params: {
  channelId: string;
  messageId: string;
  limit?: number;
}) {
  try {
    const res = await chatClient.getReplies({
      channelId: params.channelId,
      messageId: params.messageId,
      limit: params.limit,
    });
    return { replies: res.replies, totalCount: res.totalCount };
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function getMessagesByIDs(params: {
  channelId: string;
  messageIds: string[];
}) {
  try {
    const res = await chatClient.getMessagesByIDs({
      channelId: params.channelId,
      messageIds: params.messageIds,
    });
    return res.messages;
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

// --- Moderation API ---

export async function kickMember(serverId: string, userId: string) {
  try {
    await chatClient.kickMember({ serverId, userId });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function banMember(
  serverId: string,
  userId: string,
  reason?: string,
) {
  try {
    await chatClient.banMember({ serverId, userId, reason });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function unbanMember(serverId: string, userId: string) {
  try {
    await chatClient.unbanMember({ serverId, userId });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function listBans(serverId: string) {
  try {
    const res = await chatClient.listBans({ serverId });
    return res.bans;
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

// --- Role API ---

export async function listRoles(serverId: string) {
  const store = useRoleStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const res = await chatClient.listRoles({ serverId });
    store.setRoles(serverId, res.roles);
    return res.roles;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function createRole(
  serverId: string,
  name: string,
  permissions: bigint = 0n,
  color: number = 0,
) {
  const store = useRoleStore.getState();
  store.setError(null);
  try {
    const res = await chatClient.createRole({
      serverId,
      name,
      permissions,
      color,
    });
    if (res.role) {
      store.addRole(res.role);
    }
    return res.role;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function updateRole(
  roleId: string,
  updates: {
    name?: string;
    permissions?: bigint;
    color?: number;
    isSelfAssignable?: boolean;
  },
) {
  const store = useRoleStore.getState();
  store.setError(null);

  // Snapshot old permissions before updating to detect ViewChannel changes.
  const oldRole = Object.values(store.byServer)
    .flat()
    .find((r) => r.id === roleId);
  const oldPerms = oldRole?.permissions ?? 0n;

  try {
    const res = await chatClient.updateRole({ roleId, ...updates });
    if (res.role) {
      store.updateRole(res.role);

      // If ViewChannel was added, distribute keys to newly-visible channels.
      if (
        updates.permissions !== undefined &&
        isSessionReady() &&
        res.role.serverId
      ) {
        const hadView = (oldPerms & Permissions.VIEW_CHANNEL) !== 0n;
        const hasView =
          (res.role.permissions & Permissions.VIEW_CHANNEL) !== 0n;
        if (!hadView && hasView) {
          distributeKeysForServer(res.role.serverId);
        }
      }
    }
    return res.role;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function deleteRole(roleId: string) {
  try {
    await chatClient.deleteRole({ roleId });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function reorderRoles(serverId: string, roleIds: string[]) {
  try {
    await chatClient.reorderRoles({ serverId, roleIds });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

// --- Pin API ---

export async function pinMessage(channelId: string, messageId: string) {
  try {
    const res = await chatClient.pinMessage({ channelId, messageId });
    if (res.pinnedMessage) {
      usePinStore.getState().addPin(channelId, res.pinnedMessage);
    }
    return res.pinnedMessage;
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function unpinMessage(channelId: string, messageId: string) {
  try {
    await chatClient.unpinMessage({ channelId, messageId });
    usePinStore.getState().removePin(channelId, messageId);
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function getPinnedMessages(channelId: string, before?: string) {
  const store = usePinStore.getState();
  store.setLoading(channelId, true);
  store.setError(channelId, null);
  try {
    const res = await chatClient.getPinnedMessages({
      channelId,
      before: before ?? '',
      limit: 50,
    });
    if (before) {
      store.appendPinnedMessages(channelId, res.pinnedMessages, res.hasMore);
    } else {
      store.setPinnedMessages(channelId, res.pinnedMessages, res.hasMore);
    }
    return res.pinnedMessages;
  } catch (err) {
    store.setError(channelId, mapChatError(err));
    throw err;
  }
}

// --- Emoji API ---

const emojiInflight = new Map<string, Promise<CustomEmoji[]>>();

export async function listEmojis(serverId: string) {
  const existing = emojiInflight.get(serverId);
  if (existing) return existing;

  const promise = (async () => {
    const sessionUserId = useAuthStore.getState().user?.id;
    const store = useEmojiStore.getState();
    store.setError(null);
    try {
      const res = await chatClient.listEmojis({ serverId });
      // Only write if still in the same session (prevents stale writes after logout)
      if (useAuthStore.getState().user?.id === sessionUserId) {
        store.setEmojis(serverId, res.emojis);
        markServerRefreshed(serverId);
      }
      return res.emojis;
    } catch (err) {
      if (useAuthStore.getState().user?.id === sessionUserId) {
        store.setError(mapChatError(err));
      }
      throw err;
    } finally {
      emojiInflight.delete(serverId);
    }
  })();

  emojiInflight.set(serverId, promise);
  return promise;
}

let personalEmojiInflight: Promise<CustomEmoji[]> | null = null;

export async function listUserEmojis() {
  if (personalEmojiInflight) return personalEmojiInflight;

  personalEmojiInflight = (async () => {
    const sessionUserId = useAuthStore.getState().user?.id;
    const store = useEmojiStore.getState();
    store.setError(null);
    try {
      const res = await chatClient.listUserEmojis({});
      if (useAuthStore.getState().user?.id === sessionUserId) {
        store.setPersonalEmojis(res.emojis);
        markPersonalRefreshed();
      }
      return res.emojis;
    } catch (err) {
      if (useAuthStore.getState().user?.id === sessionUserId) {
        store.setError(mapChatError(err));
      }
      throw err;
    } finally {
      personalEmojiInflight = null;
    }
  })();

  return personalEmojiInflight;
}

export async function createEmoji(
  name: string,
  attachmentId: string,
  serverId?: string,
) {
  const store = useEmojiStore.getState();
  store.setError(null);
  try {
    const res = await chatClient.createEmoji({
      serverId: serverId ?? '',
      name,
      attachmentId,
    });
    if (res.emoji) {
      store.addEmoji(res.emoji);
    }
    return res.emoji;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function updateEmoji(emojiId: string, name: string) {
  const store = useEmojiStore.getState();
  store.setError(null);
  try {
    const res = await chatClient.updateEmoji({ emojiId, name });
    if (res.emoji) {
      store.updateEmoji(res.emoji);
    }
    return res.emoji;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function deleteEmoji(emojiId: string) {
  try {
    await chatClient.deleteEmoji({ emojiId });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

// --- Member API ---

export async function updateMember(
  serverId: string,
  userId: string,
  updates: { nickname?: string },
) {
  try {
    await chatClient.updateMember({ serverId, userId, ...updates });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function setMemberRoles(
  serverId: string,
  userId: string,
  roleIds: string[],
) {
  try {
    await chatClient.setMemberRoles({ serverId, userId, roleIds });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function timeoutMember(
  serverId: string,
  userId: string,
  timedOutUntil: Date,
) {
  try {
    const res = await chatClient.timeoutMember({
      serverId,
      userId,
      timedOutUntil: {
        seconds: BigInt(Math.floor(timedOutUntil.getTime() / 1000)),
        nanos: 0,
      },
    });
    return res.member;
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function removeTimeout(serverId: string, userId: string) {
  try {
    const res = await chatClient.removeTimeout({ serverId, userId });
    return res.member;
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

// --- Channel Member API ---

export async function addChannelMember(channelId: string, userId: string) {
  try {
    await chatClient.addChannelMember({ channelId, userId });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function removeChannelMember(channelId: string, userId: string) {
  try {
    await chatClient.removeChannelMember({ channelId, userId });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function listChannelMembers(channelId: string) {
  try {
    const res = await chatClient.listChannelMembers({ channelId });
    return res.members;
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

// --- Sound API ---

export async function listServerSounds(serverId: string) {
  const store = useSoundStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const res = await chatClient.listServerSounds({ serverId });
    store.setServerSounds(serverId, res.sounds);
    return res.sounds;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function listUserSounds() {
  const store = useSoundStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const res = await chatClient.listUserSounds({});
    store.setPersonalSounds(res.sounds);
    return res.sounds;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function createSound(
  name: string,
  attachmentId: string,
  serverId?: string,
) {
  const store = useSoundStore.getState();
  store.setError(null);
  try {
    const res = await chatClient.createSound({
      name,
      attachmentId,
      serverId: serverId ?? '',
    });
    if (res.sound) {
      store.addSound(res.sound);
    }
    return res.sound;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function updateSound(soundId: string, name: string) {
  const store = useSoundStore.getState();
  store.setError(null);
  try {
    const res = await chatClient.updateSound({ soundId, name });
    if (res.sound) {
      store.updateSound(res.sound);
    }
    return res.sound;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function deleteSound(soundId: string) {
  try {
    await chatClient.deleteSound({ soundId });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

// --- Read State API ---

export async function ackMessage(channelId: string, messageId: string) {
  try {
    await chatClient.ackMessage({ channelId, messageId });
    // Store update handled by gateway readStateUpdate event.
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

// --- Reaction API ---

export async function addReaction(
  channelId: string,
  messageId: string,
  emoji: string,
) {
  try {
    await chatClient.addReaction({ channelId, messageId, emoji });
    // Store update handled by gateway reactionAdd event.
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function removeReaction(
  channelId: string,
  messageId: string,
  emoji: string,
) {
  try {
    await chatClient.removeReaction({ channelId, messageId, emoji });
    // Store update handled by gateway reactionRemove event.
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function getReactions(channelId: string, messageIds: string[]) {
  try {
    const res = await chatClient.getReactions({ channelId, messageIds });
    const reactionStore = useReactionStore.getState();
    const groups: Record<string, (typeof res.reactions)[string]['groups']> = {};
    for (const [msgId, list] of Object.entries(res.reactions)) {
      groups[msgId] = list.groups;
    }
    reactionStore.setBulkReactions(groups);
    return res.reactions;
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

// --- Server Creation from Template ---

export async function createServerFromTemplate(params: {
  name: string;
  iconUrl?: string;
  channels: Array<{
    name: string;
    type: ChannelType;
    isDefault: boolean;
    isPrivate: boolean;
    roleNames?: string[];
  }>;
  roles: Array<{
    name: string;
    permissions: bigint;
    color: number;
    isSelfAssignable: boolean;
  }>;
  welcomeMessage?: string;
  rules?: string;
  onboardingEnabled: boolean;
  rulesRequired: boolean;
}) {
  try {
    const res = await chatClient.createServerFromTemplate(params);
    if (res.server) {
      useServerStore.getState().addServer(res.server);
      useChannelStore.getState().setChannels(res.server.id, res.channels);
      useRoleStore.getState().setRoles(res.server.id, res.roles);
      // Provision encryption keys for all template channels (universal E2EE)
      const userId = useAuthStore.getState().user?.id;
      if (userId) {
        for (const ch of res.channels) {
          provisionChannelKey(ch.id, [userId]).catch((err) =>
            console.error(
              '[E2EE] Failed to provision key for template channel:',
              err,
            ),
          );
        }
      }
    }
    return {
      server: res.server,
      channels: res.channels,
      roles: res.roles,
      invite: res.invite,
    };
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

// --- Onboarding API ---

export async function getServer(serverId: string) {
  try {
    const res = await chatClient.getServer({ serverId });
    if (res.server) {
      useServerStore.getState().addServer(res.server);
    }
    return res.server;
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function updateServer(
  serverId: string,
  updates: {
    name?: string;
    iconUrl?: string;
    welcomeMessage?: string;
    rules?: string;
    onboardingEnabled?: boolean;
    rulesRequired?: boolean;
    defaultChannelPrivacy?: boolean;
  },
) {
  try {
    const res = await chatClient.updateServer({ serverId, ...updates });
    if (res.server) {
      useServerStore.getState().addServer(res.server);
    }
    return res.server;
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function acknowledgeRules(serverId: string) {
  try {
    const res = await chatClient.acknowledgeRules({ serverId });
    // Patch member store so sidebar reactively unblocks
    const userId = useAuthStore.getState().user?.id;
    if (userId && res.acknowledgedAt) {
      const members = useMemberStore.getState().byServer[serverId] ?? [];
      const me = members.find((m) => m.userId === userId);
      if (me) {
        useMemberStore
          .getState()
          .updateMember({ ...me, rulesAcknowledgedAt: res.acknowledgedAt });
      }
    }
    return res.acknowledgedAt;
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function completeOnboarding(
  serverId: string,
  channelIds: string[],
  roleIds: string[],
) {
  try {
    const res = await chatClient.completeOnboarding({
      serverId,
      channelIds,
      roleIds,
    });
    // Patch member store so sidebar reactively shows channels
    const userId = useAuthStore.getState().user?.id;
    if (userId && res.completedAt) {
      const members = useMemberStore.getState().byServer[serverId] ?? [];
      const me = members.find((m) => m.userId === userId);
      if (me) {
        useMemberStore
          .getState()
          .updateMember({ ...me, onboardingCompletedAt: res.completedAt });
      }
    }
    return {
      completedAt: res.completedAt,
      skippedChannelIds: res.skippedChannelIds,
      skippedRoleIds: res.skippedRoleIds,
    };
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

// --- DM API ---

export async function createOrGetDMChannel(recipientId: string) {
  const store = useDMStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const res = await chatClient.createOrGetDMChannel({ recipientId });
    if (res.dmChannel) {
      store.addOrUpdateDMChannel(res.dmChannel);
      cacheDMParticipants([res.dmChannel]);
      // Provision encryption key for newly created DMs
      if (res.created && res.dmChannel.channel) {
        const userId = useAuthStore.getState().user?.id;
        if (userId) {
          try {
            await provisionChannelKey(res.dmChannel.channel.id, [
              userId,
              recipientId,
            ]);
          } catch (err) {
            console.error('[E2EE] Failed to provision key for new DM:', err);
          }
        }
      }
    }
    store.setLoading(false);
    return res;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function createGroupDMChannel(
  participantIds: string[],
  name?: string,
) {
  const store = useDMStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const res = await chatClient.createGroupDMChannel({
      participantIds,
      name,
    });
    if (res.dmChannel) {
      store.addOrUpdateDMChannel(res.dmChannel);
      cacheDMParticipants([res.dmChannel]);
      // Provision encryption key for newly created group DMs
      if (res.created && res.dmChannel.channel) {
        const userId = useAuthStore.getState().user?.id;
        if (userId) {
          try {
            await provisionChannelKey(res.dmChannel.channel.id, [
              userId,
              ...participantIds,
            ]);
          } catch (err) {
            console.error(
              '[E2EE] Failed to provision key for new group DM:',
              err,
            );
          }
        }
      }
    }
    store.setLoading(false);
    return res;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

/** Cache DM participant profiles so useDisplayName / useAuthorAvatar can resolve them. */
function cacheDMParticipants(dmChannels: DMChannel[]) {
  const usersStore = useUsersStore.getState();
  for (const dm of dmChannels) {
    for (const p of dm.participants) {
      usersStore.setProfile(p.id, toStoredUser(p));
    }
  }
}

export async function listDMChannels() {
  const store = useDMStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const res = await chatClient.listDMChannels({});
    store.setDMChannels(res.dmChannels);
    cacheDMParticipants(res.dmChannels);
    return res.dmChannels;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

// --- Message Request API ---

export async function listMessageRequests() {
  const store = useDMStore.getState();
  try {
    const res = await chatClient.listMessageRequests({});
    store.setMessageRequests(res.dmChannels);
    cacheDMParticipants(res.dmChannels);
    return res.dmChannels;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function acceptMessageRequest(channelId: string) {
  const store = useDMStore.getState();
  try {
    const res = await chatClient.acceptMessageRequest({ channelId });
    if (res.dmChannel) {
      store.removeMessageRequest(channelId);
      store.addOrUpdateDMChannel(res.dmChannel);
      cacheDMParticipants([res.dmChannel]);
    }
    return res;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function declineMessageRequest(channelId: string) {
  const store = useDMStore.getState();
  try {
    await chatClient.declineMessageRequest({ channelId });
    store.removeMessageRequest(channelId);
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function reverseDecline(channelId: string) {
  const store = useDMStore.getState();
  try {
    const res = await chatClient.reverseDecline({ channelId });
    if (res.dmChannel) {
      store.addOrUpdateDMChannel(res.dmChannel);
      cacheDMParticipants([res.dmChannel]);
    }
    return res;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

// --- Block API ---

export async function blockUser(userId: string) {
  try {
    await chatClient.blockUser({ userId });
    useBlockStore.getState().removeBlockedUser(userId);
    // Re-fetch to get the full User object in the store
    listBlocks().catch(() => {});
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function unblockUser(userId: string) {
  try {
    await chatClient.unblockUser({ userId });
    useBlockStore.getState().removeBlockedUser(userId);
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function listBlocks() {
  const store = useBlockStore.getState();
  try {
    const res = await chatClient.listBlocks({});
    store.setBlockedUsers(res.blockedUsers);
    return res.blockedUsers;
  } catch (err) {
    throw new Error(mapChatError(err));
  }
}

// --- Friend API ---

export async function sendFriendRequest(params: {
  userId?: string;
  username?: string;
}) {
  try {
    const res = await chatClient.sendFriendRequest(params);
    return { autoAccepted: res.autoAccepted };
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function acceptFriendRequest(userId: string) {
  try {
    await chatClient.acceptFriendRequest({ userId });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function declineFriendRequest(userId: string) {
  try {
    await chatClient.declineFriendRequest({ userId });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function cancelFriendRequest(userId: string) {
  try {
    await chatClient.cancelFriendRequest({ userId });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function removeFriend(userId: string) {
  try {
    await chatClient.removeFriend({ userId });
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function listFriends() {
  const store = useFriendStore.getState();
  try {
    const res = await chatClient.listFriends({});
    store.setFriends(res.friends);
    return res.friends;
  } catch (err) {
    throw new Error(mapChatError(err));
  }
}

export async function listFriendRequests() {
  const store = useFriendStore.getState();
  try {
    const res = await chatClient.listFriendRequests({});
    store.setIncomingRequests(res.incoming);
    store.setOutgoingRequests(res.outgoing);
    return { incoming: res.incoming, outgoing: res.outgoing };
  } catch (err) {
    throw new Error(mapChatError(err));
  }
}

// --- Channel Group API ---

export async function listChannelGroups(serverId: string) {
  const store = useChannelGroupStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const res = await chatClient.listChannelGroups({ serverId });
    store.setGroups(serverId, res.channelGroups);
    return res.channelGroups;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function createChannelGroup(serverId: string, name: string) {
  const store = useChannelGroupStore.getState();
  store.setError(null);
  try {
    const res = await chatClient.createChannelGroup({ serverId, name });
    if (res.channelGroup) {
      store.addGroup(res.channelGroup);
    }
    return res.channelGroup;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function updateChannelGroup(
  channelGroupId: string,
  updates: { name?: string; position?: number },
) {
  const store = useChannelGroupStore.getState();
  store.setError(null);
  try {
    const res = await chatClient.updateChannelGroup({
      channelGroupId,
      ...updates,
    });
    if (res.channelGroup) {
      store.updateGroup(res.channelGroup);
    }
    return res.channelGroup;
  } catch (err) {
    store.setError(mapChatError(err));
    throw err;
  }
}

export async function deleteChannelGroup(channelGroupId: string) {
  try {
    await chatClient.deleteChannelGroup({ channelGroupId });
    // Store update handled by gateway channelGroupDelete event to avoid double-remove race.
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

// --- Permission Override API ---
// No client-side store yet. Overrides are fetched on-demand for settings UI.
// Real-time updates will be added when the channel/group settings pane is built.

export async function setPermissionOverride(
  targetId: string,
  roleId: string,
  allow: bigint,
  deny: bigint,
  userId?: string,
) {
  try {
    const res = await chatClient.setPermissionOverride({
      targetId,
      roleId,
      allow,
      deny,
      userId: userId ?? '',
    });

    // If ViewChannel was allowed (not denied), distribute keys for affected channel(s).
    if ((allow & Permissions.VIEW_CHANNEL) !== 0n && isSessionReady()) {
      distributeKeysForOverrideTarget(targetId);
    }

    return res.permissionOverride;
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function deletePermissionOverride(
  targetId: string,
  roleId: string,
  userId?: string,
) {
  try {
    await chatClient.deletePermissionOverride({
      targetId,
      roleId,
      userId: userId ?? '',
    });

    // Removing a deny override may grant ViewChannel — distribute keys.
    if (isSessionReady()) {
      distributeKeysForOverrideTarget(targetId);
    }
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function listPermissionOverrides(targetId: string) {
  try {
    const res = await chatClient.listPermissionOverrides({ targetId });
    return res.permissionOverrides;
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export async function getEffectivePermissions(
  serverId: string,
  channelId?: string,
  userId?: string,
) {
  try {
    const res = await chatClient.getEffectivePermissions({
      serverId,
      channelId: channelId ?? '',
      userId: userId ?? '',
    });
    return res.permissions;
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

export interface SearchMessagesParams {
  channelId: string;
  authorId?: string;
  hasAttachment?: boolean;
  mentionedUserId?: string;
  beforeId?: string;
  afterId?: string;
  limit?: number;
}

export interface SearchMessagesResult {
  messages: import('@meza/gen/meza/v1/models_pb.ts').Message[];
  hasMore: boolean;
}

export async function searchMessages(
  params: SearchMessagesParams,
): Promise<SearchMessagesResult> {
  try {
    const res = await chatClient.searchMessages({
      channelId: params.channelId,
      authorId: params.authorId,
      hasAttachment: params.hasAttachment,
      mentionedUserId: params.mentionedUserId,
      beforeId: params.beforeId,
      afterId: params.afterId,
      limit: params.limit ?? 25,
    });
    return {
      messages: res.messages,
      hasMore: res.hasMore,
    };
  } catch (err) {
    throw new Error(mapChatError(err), { cause: err });
  }
}

// --- E2EE key distribution helpers ---

/**
 * Distribute cached channel keys to all members for every encrypted channel
 * in a server. Called after a role update grants ViewChannel to new users.
 * Runs in the background — errors are logged but not thrown.
 */
function distributeKeysForServer(serverId: string): void {
  const channels = useChannelStore.getState().byServer[serverId] ?? [];
  const channelIds = channels
    .filter((ch) => hasChannelKey(ch.id))
    .map((ch) => ch.id);
  if (channelIds.length === 0) return;
  redistributeChannelKeys(channelIds).catch((err: unknown) =>
    console.error('[E2EE] distributeKeysForServer failed:', err),
  );
}

/**
 * Distribute cached channel keys for channels affected by a permission
 * override change. The targetId may be a channel or a channel group.
 * Runs in the background — errors are logged but not thrown.
 */
function distributeKeysForOverrideTarget(targetId: string): void {
  // Check if targetId is a channel directly (look it up in channelToServer map).
  const channelToServer = useChannelStore.getState().channelToServer;
  if (channelToServer[targetId]) {
    if (!hasChannelKey(targetId)) return;
    redistributeChannelKeys([targetId]).catch((err: unknown) =>
      console.error('[E2EE] distributeKeysForOverrideTarget failed:', err),
    );
    return;
  }

  // Otherwise, targetId may be a channel group — find all channels in it.
  const allServers = useChannelStore.getState().byServer;
  const channelIds: string[] = [];
  for (const channels of Object.values(allServers)) {
    for (const ch of channels) {
      if (ch.channelGroupId === targetId && hasChannelKey(ch.id)) {
        channelIds.push(ch.id);
      }
    }
  }
  if (channelIds.length === 0) return;
  redistributeChannelKeys(channelIds).catch((err: unknown) =>
    console.error('[E2EE] distributeKeysForOverrideTarget failed:', err),
  );
}

// --- System Message Config ---

export async function getSystemMessageConfig(serverId: string) {
  const resp = await chatClient.getSystemMessageConfig({ serverId });
  return resp.config;
}

export async function updateSystemMessageConfig(
  serverId: string,
  config: {
    welcomeChannelId?: string;
    modLogChannelId?: string;
    joinEnabled?: boolean;
    joinTemplate?: string;
    leaveEnabled?: boolean;
    leaveTemplate?: string;
    kickEnabled?: boolean;
    kickTemplate?: string;
    banEnabled?: boolean;
    banTemplate?: string;
    timeoutEnabled?: boolean;
    timeoutTemplate?: string;
  },
) {
  const resp = await chatClient.updateSystemMessageConfig({
    serverId,
    ...config,
  });
  return resp.config;
}
