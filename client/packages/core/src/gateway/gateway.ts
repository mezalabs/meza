import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  EventSchema,
  FriendRequestEntrySchema,
  TypingEventSchema,
} from '@meza/gen/meza/v1/chat_pb.ts';
import {
  GatewayEnvelopeSchema,
  GatewayOpCode,
} from '@meza/gen/meza/v1/gateway_pb.ts';
import type { Message } from '@meza/gen/meza/v1/models_pb.ts';
import { PresenceStatus } from '@meza/gen/meza/v1/presence_pb.ts';
import { publicUserToStored } from '../api/auth.ts';
import {
  listChannels as fetchChannels,
  listDMChannels as fetchDMChannels,
  listEmojis,
  listUserEmojis,
} from '../api/chat.ts';
import { getPublicKeys } from '../api/keys.ts';
import {
  cachePublicKey,
  clearVerification,
} from '../crypto/key-monitor.ts';
import {
  clearStatusOverride,
  getMyPresence,
  updatePresence,
} from '../api/presence.ts';
import {
  distributeKeyToMember,
  fetchAndCacheChannelKeys,
  getCachedChannelIds,
  hasChannelKey,
  prefetchChannelKeys,
  redistributeChannelKeys,
} from '../crypto/channel-keys.ts';
import { decryptAndUpdateMessage } from '../crypto/decrypt-store.ts';
import { isSessionReady, onSessionReady } from '../crypto/session.ts';
import { indexIncomingMessage } from '../search/indexer.ts';
import {
  removeSearchMessage,
  removeSearchMessages,
} from '../search/search-service.ts';
import type { SoundType } from '../sound/SoundManager.ts';
import { soundManager } from '../sound/SoundManager.ts';
import { useAuthStore } from '../store/auth.ts';
import { useBlockStore } from '../store/blocks.ts';
import { useChannelGroupStore } from '../store/channel-groups.ts';
import { useChannelStore } from '../store/channels.ts';
import { useDMStore } from '../store/dms.ts';
import { useEmojiStore } from '../store/emojis.ts';
import { useFriendStore } from '../store/friends.ts';
import { useGatewayStore } from '../store/gateway.ts';
import { useMemberStore } from '../store/members.ts';
import { useMessageStore } from '../store/messages.ts';
import { useNotificationSettingsStore } from '../store/notificationSettings.ts';
import { usePermissionOverrideStore } from '../store/permission-overrides.ts';
import { usePinStore } from '../store/pins.ts';
import { usePresenceStore } from '../store/presence.ts';
import { useReactionStore } from '../store/reactions.ts';
import { useReadStateStore } from '../store/read-state.ts';
import { useRoleStore } from '../store/roles.ts';
import { useServerStore } from '../store/servers.ts';
import { useSoundStore } from '../store/sounds.ts';
import { useTypingStore } from '../store/typing.ts';
import { useUsersStore } from '../store/users.ts';
import { useVoiceStore } from '../store/voice.ts';
import { getBaseUrl } from '../utils/platform.ts';
import { retryWithBackoff } from '../utils/retry.ts';

/**
 * Validate the shape of the READY payload to prevent corrupted state.
 * Returns true if the payload has the expected structure.
 */
function validateReadyPayload(data: unknown): data is {
  user_id?: string;
  channel_ids?: string[];
  read_states?: Array<{
    channel_id: string;
    last_read_message_id: string;
    unread_count: number;
  }>;
} {
  if (data === null || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;

  // user_id must be a string if present
  if ('user_id' in obj && typeof obj.user_id !== 'string') return false;

  // channel_ids must be an array of strings if present (Go encodes nil slices as null)
  if ('channel_ids' in obj && obj.channel_ids !== null) {
    if (!Array.isArray(obj.channel_ids)) return false;
    if (!obj.channel_ids.every((id: unknown) => typeof id === 'string'))
      return false;
  }

  // read_states must be an array of { channel_id, last_read_message_id, unread_count }
  if ('read_states' in obj && obj.read_states !== null) {
    if (!Array.isArray(obj.read_states)) return false;
    for (const rs of obj.read_states) {
      if (rs === null || typeof rs !== 'object') return false;
      if (typeof rs.channel_id !== 'string') return false;
      if (typeof rs.last_read_message_id !== 'string') return false;
      if (typeof rs.unread_count !== 'number') return false;
    }
  }

  return true;
}

let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
let reconnectAttempts = 0;
let generation = 0;
let lastHeartbeatAck = 0;
let hasConnectedBefore = false;
let lastRedistributeTime = 0;
const REDISTRIBUTE_COOLDOWN_MS = 5_000; // debounce flapping connections; UPSERT makes dupes safe
let isOnline =
  typeof navigator !== 'undefined' ? (navigator.onLine ?? true) : true;

/** Deduplicate concurrent channel-key retry promises per channel. */
const keyRetryInFlight = new Map<string, Promise<boolean>>();

// --- Signing public key cache for message signature verification ---
const SIGNING_KEY_TTL_MS = 15 * 60 * 1000; // 15 minutes
const signingKeyCache = new Map<
  string,
  { key: Uint8Array; fetchedAt: number }
>();

// Guard: channel IDs for which a fetchDMChannels call is already in flight,
// preventing duplicate API calls when multiple messages arrive in quick
// succession for a brand-new DM channel.
const pendingDMFetchChannels = new Set<string>();

// --- Notification sound infrastructure ---
let reconnectGraceUntil = 0;
let overrideExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let isPrimaryTab = true;

// Multi-tab coordination: only the most recently focused tab plays sounds.
const soundChannel =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('meza-notification-sounds')
    : null;

if (soundChannel) {
  soundChannel.onmessage = (event) => {
    if (event.data?.type === 'TAB_ACTIVE') isPrimaryTab = false;
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    isPrimaryTab = true;
    soundChannel?.postMessage({ type: 'TAB_ACTIVE' });
  });
}

function isDMChannel(channelId: string): boolean {
  const { dmChannels } = useDMStore.getState();
  return dmChannels.some((dm) => dm.channel?.id === channelId);
}

function maybePlaySound(type: SoundType, authorId?: string): void {
  if (!isPrimaryTab) return;
  if (Date.now() < reconnectGraceUntil) return;

  const { soundEnabled, enabledSounds } =
    useNotificationSettingsStore.getState();
  if (!soundEnabled) return;
  if (!enabledSounds[type]) return;

  // DND check
  const { myStatus } = usePresenceStore.getState();
  if (myStatus === PresenceStatus.DND) return;

  // Blocked user check
  if (authorId && useBlockStore.getState().isBlocked(authorId)) return;

  soundManager.play(type);
}

async function getOrFetchPublicKey(userId: string): Promise<Uint8Array | null> {
  const cached = signingKeyCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < SIGNING_KEY_TTL_MS) {
    return cached.key;
  }
  try {
    const keys = await getPublicKeys([userId]);
    const pk = keys[userId];
    if (pk) {
      signingKeyCache.set(userId, { key: pk, fetchedAt: Date.now() });

      // Key change detection: compare against persistent cache
      const result = await cachePublicKey(userId, pk);
      if (result === 'changed') {
        console.warn(`[E2EE] identity key changed for user ${userId}`);
        await clearVerification(userId);
      }

      return pk;
    }
  } catch (err) {
    console.warn(`[E2EE] failed to fetch public key for ${userId}:`, err);
  }
  return null;
}

/**
 * Fetch a user's public key with retry+backoff. Useful when a new user
 * hasn't registered their key yet — they may still be bootstrapping.
 */
async function fetchPublicKeyWithRetry(
  userId: string,
  gen: number,
): Promise<Uint8Array | null> {
  try {
    return await retryWithBackoff(
      async () => {
        const pk = await getOrFetchPublicKey(userId);
        if (!pk) throw new Error('public key not available');
        return pk;
      },
      {
        maxAttempts: 3,
        initialDelayMs: 2_000,
        maxDelayMs: 10_000,
        signal: {
          get cancelled() {
            return gen !== generation;
          },
        },
        onRetry: (attempt, delayMs) => {
          console.warn(
            `[E2EE] retrying public key fetch for ${userId} (attempt ${attempt}, delay ${delayMs}ms)`,
          );
        },
      },
    );
  } catch {
    return null;
  }
}

/**
 * Ensure the channel key is available, retrying with backoff if needed.
 * Deduplicates concurrent requests for the same channel so that a burst
 * of messages (e.g. 50 arriving on reconnect) shares a single retry.
 */
async function ensureChannelKey(
  channelId: string,
  gen: number,
): Promise<boolean> {
  if (hasChannelKey(channelId)) return true;

  const existing = keyRetryInFlight.get(channelId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      await retryWithBackoff(
        async () => {
          await fetchAndCacheChannelKeys(channelId);
          if (!hasChannelKey(channelId))
            throw new Error('key not yet available');
        },
        {
          maxAttempts: 3,
          initialDelayMs: 1_000,
          maxDelayMs: 5_000,
          signal: {
            get cancelled() {
              return gen !== generation;
            },
          },
          onRetry: (attempt, delayMs) => {
            console.warn(
              `[E2EE] retrying channel key fetch for ${channelId} (attempt ${attempt}, delay ${delayMs}ms)`,
            );
          },
        },
      );
      return hasChannelKey(channelId);
    } catch {
      return false;
    } finally {
      keyRetryInFlight.delete(channelId);
    }
  })();

  keyRetryInFlight.set(channelId, promise);
  return promise;
}

/**
 * Attempt to decrypt an encrypted message and update the store in place.
 * Fire-and-forget — failures are logged and the message stays encrypted.
 * Retries key-fetch with backoff if the channel key is not yet available.
 *
 * Note: ChannelView may also decrypt the same messages via its fetch-time
 * handler or its `keysAvailable` effect. Idempotency is handled by the
 * shared {@link decryptAndUpdateMessage} function (keyVersion > 0 guard),
 * so concurrent calls from both paths are safe.
 */
function decryptInBackground(
  channelId: string,
  msg: Pick<
    Message,
    'id' | 'authorId' | 'keyVersion' | 'encryptedContent' | 'attachments'
  >,
  gen: number,
): void {
  (async () => {
    // Bail if the gateway has reconnected since this was queued
    if (gen !== generation) return;

    if (!(await ensureChannelKey(channelId, gen))) return;
    if (gen !== generation) return;

    try {
      const pubKey = await getOrFetchPublicKey(msg.authorId);
      if (!pubKey || gen !== generation) return;
      await decryptAndUpdateMessage(channelId, msg, pubKey);
    } catch (err) {
      console.error(
        `[E2EE] gateway decrypt failed for msg ${msg.id} in ${channelId}:`,
        err,
      );
    }
  })();
}

/**
 * Schedule a timer to auto-clear the local override when it expires.
 * Called after getMyPresence() restores override state from the server.
 */
function scheduleOverrideExpiry() {
  if (overrideExpiryTimer) {
    clearTimeout(overrideExpiryTimer);
    overrideExpiryTimer = null;
  }
  const override = usePresenceStore.getState().myOverride;
  if (!override || override.expiresAt === 0) return;

  const remaining = override.expiresAt * 1000 - Date.now();
  if (remaining <= 0) {
    // Already expired — clear immediately
    clearStatusOverride().catch(() => {});
    return;
  }
  overrideExpiryTimer = setTimeout(() => {
    overrideExpiryTimer = null;
    clearStatusOverride().catch(() => {});
  }, remaining);
}

function sendEnvelope(
  op: GatewayOpCode,
  payload: Uint8Array = new Uint8Array(),
) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const env = create(GatewayEnvelopeSchema, { op, payload, sequence: 0n });
  ws.send(toBinary(GatewayEnvelopeSchema, env));
}

export function connect(token: string) {
  disconnect();
  const gen = ++generation;

  const gw = useGatewayStore.getState();
  gw.setStatus('connecting');
  gw.setLastError(null);

  const base = getBaseUrl();
  let wsUrl: string;
  if (base) {
    const parsed = new URL(base);
    const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = `${wsProto}//${parsed.host}/ws`;
  } else {
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = `${wsProto}//${location.host}/ws`;
  }
  const socket = new WebSocket(wsUrl);
  socket.binaryType = 'arraybuffer';
  ws = socket;

  socket.onopen = () => {
    if (gen !== generation) return;
    // V1 simplification: IDENTIFY uses JSON-in-protobuf instead of a dedicated
    // proto message type. The outer envelope is protobuf (GatewayEnvelope), but
    // the auth payload is JSON text encoded as bytes. The server-side
    // authenticateFirstMessage() expects this format. This avoids needing
    // separate IdentifyPayload/ReadyPayload proto messages for the handshake
    // during early development.
    const identifyJson = JSON.stringify({ token });
    sendEnvelope(
      GatewayOpCode.GATEWAY_OP_IDENTIFY,
      new TextEncoder().encode(identifyJson),
    );
    lastHeartbeatAck = Date.now();
    startHeartbeat();
    reconnectDelay = 1000;
    reconnectAttempts = 0;
    useGatewayStore.getState().setStatus('connected');
    useGatewayStore.getState().setReconnectAttempt(0);
    // Always tell the server we're ONLINE (so it knows we're connected).
    // The server will apply any active override before broadcasting to others.
    updatePresence(PresenceStatus.ONLINE);
    const activeOverride = usePresenceStore.getState().myOverride;
    if (activeOverride) {
      // Keep local status reflecting the override
      usePresenceStore.getState().setMyStatus(activeOverride.status);
    } else {
      usePresenceStore.getState().setMyStatus(PresenceStatus.ONLINE);
    }
  };

  socket.onmessage = (e: MessageEvent) => {
    if (gen !== generation) return;
    const data = new Uint8Array(e.data as ArrayBuffer);
    const env = fromBinary(GatewayEnvelopeSchema, data);
    dispatch(env.op, env.payload);
  };

  socket.onclose = (e?: CloseEvent) => {
    if (gen !== generation) return;
    stopHeartbeat();
    useGatewayStore
      .getState()
      .setLastError(e?.reason || `WebSocket closed (code ${e?.code ?? 1006})`);
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose fires after onerror — reconnect handled there
  };
}

function dispatch(op: GatewayOpCode, payload: Uint8Array) {
  const currentUserId = useAuthStore.getState().user?.id;

  switch (op) {
    case GatewayOpCode.GATEWAY_OP_READY: {
      // V1 simplification: READY payload is JSON text encoded as bytes inside
      // the protobuf envelope (see IDENTIFY comment above). The server sends
      // JSON with { user_id, channel_ids, read_states }.
      try {
        const readyData = JSON.parse(new TextDecoder().decode(payload));
        if (!validateReadyPayload(readyData)) {
          console.error(
            '[Gateway] READY payload failed validation, reconnecting',
          );
          scheduleReconnect();
          return;
        }
        if (Array.isArray(readyData.read_states)) {
          useReadStateStore.getState().setReadStates(
            readyData.read_states.map(
              (rs: {
                channel_id: string;
                last_read_message_id: string;
                unread_count: number;
              }) => ({
                channelId: rs.channel_id,
                lastReadMessageId: rs.last_read_message_id,
                unreadCount: rs.unread_count,
              }),
            ),
          );
        }
        if (hasConnectedBefore) {
          // Reconnect: bump counter so UI re-fetches, reset ephemeral stores
          useGatewayStore.getState().incrementReconnectCount();
          useTypingStore.getState().reset();
          usePresenceStore.getState().reset();
        }
        // E2EE: redistribute cached channel keys to all members.
        // Covers both initial connection (Bob opens a fresh tab while
        // Charlie is waiting for keys) and reconnects (missed memberJoin).
        // Cooldown prevents flooding on flapping connections.
        // UPSERT semantics make duplicates safe.
        if (
          isSessionReady() &&
          Date.now() - lastRedistributeTime > REDISTRIBUTE_COOLDOWN_MS
        ) {
          const channelIds = getCachedChannelIds();
          if (channelIds.length > 0) {
            lastRedistributeTime = Date.now();
            redistributeChannelKeys(channelIds).catch((err) =>
              console.error(
                '[E2EE] key redistribution on connect failed:',
                err,
              ),
            );
          }
        }
        // Prefetch channel keys for all channels so switching is instant.
        // Runs after session bootstrap completes (may already be ready).
        if (
          Array.isArray(readyData.channel_ids) &&
          readyData.channel_ids.length > 0
        ) {
          const readyChannelIds = readyData.channel_ids;
          const gen = generation;
          const doPrefetch = () => {
            if (gen !== generation) return; // stale READY after reconnect
            prefetchChannelKeys(readyChannelIds).catch((err) =>
              console.error('[E2EE] channel key prefetch failed:', err),
            );
          };
          if (isSessionReady()) {
            doPrefetch();
          } else {
            onSessionReady(doPrefetch);
          }
        }
        hasConnectedBefore = true;
        // Suppress notification sounds for 3s after connect/reconnect
        // to prevent flooding from a backlog of missed events.
        reconnectGraceUntil = Date.now() + 3000;
        // Pre-fetch sound files so they're ready when needed.
        // AudioContext creation is deferred to the first play() call
        // to avoid the browser autoplay policy error.
        soundManager.prefetch();
        // Restore override state from server on connection/reconnection.
        getMyPresence()
          .then((res) => {
            if (res) scheduleOverrideExpiry();
          })
          .catch(() => {});
        // Catch up on any emoji changes missed during disconnection.
        // On first connect the UI components also trigger fetches, but
        // the dedup logic in chat.ts collapses duplicate in-flight requests.
        const serverIds = Object.keys(useServerStore.getState().servers);
        for (const sid of serverIds) {
          listEmojis(sid).catch(() => {});
        }
        listUserEmojis().catch(() => {});
      } catch (err) {
        console.error(
          '[Gateway] READY payload parse failed, reconnecting:',
          err,
        );
        scheduleReconnect();
        return;
      }
      break;
    }
    case GatewayOpCode.GATEWAY_OP_HEARTBEAT_ACK:
      lastHeartbeatAck = Date.now();
      break;
    case GatewayOpCode.GATEWAY_OP_EVENT: {
      const event = fromBinary(EventSchema, payload);
      if (event.payload.case === 'messageCreate' && event.payload.value) {
        const msg = event.payload.value;

        // Own encrypted messages: the optimistic path in sendMessage already
        // added the plaintext version (keyVersion=0). The gateway echo has
        // encrypted text but also carries server-enriched attachment metadata
        // (e.g., encryptedKey for file decryption). Merge the attachment data
        // without overwriting the plaintext content.
        const store = useMessageStore.getState();
        const alreadySeen = !!store.byId[msg.channelId]?.[msg.id];
        const existingOwn =
          msg.authorId === currentUserId && msg.keyVersion > 0
            ? store.byId[msg.channelId]?.[msg.id]
            : undefined;
        if (existingOwn) {
          // Keep plaintext content + keyVersion=0, but update attachments
          store.updateMessage(msg.channelId, {
            ...existingOwn,
            attachments: msg.attachments,
          });
        } else {
          store.addMessage(msg.channelId, msg);
          if (msg.keyVersion > 0 && isSessionReady()) {
            decryptInBackground(msg.channelId, msg, generation);
          }
        }
        useTypingStore.getState().clearUser(msg.channelId, msg.authorId);

        // Classify the channel once: known DM, server channel, or unknown
        // (likely a new DM from a friend that hasn't been fetched yet).
        const knownDM = isDMChannel(msg.channelId);
        const isServerCh =
          !knownDM &&
          Object.values(useChannelStore.getState().byServer).some((chs) =>
            chs.some((c) => c.id === msg.channelId),
          );
        const likelyDM = knownDM || !isServerCh;

        // Increment unread count for messages from other users, but only if
        // the channel is not currently being viewed and the message wasn't
        // already processed (guards against duplicate gateway delivery).
        if (!alreadySeen && msg.authorId !== currentUserId) {
          const viewed = useGatewayStore.getState().viewedChannelIds;
          if (!viewed[msg.channelId]) {
            useReadStateStore.getState().incrementUnread(msg.channelId);
            // Notification sound: mention > dm > message
            let soundType: SoundType = 'message';
            if (
              msg.mentionedUserIds.includes(currentUserId ?? '') ||
              msg.mentionEveryone
            ) {
              soundType = 'mention';
            } else if (likelyDM) {
              soundType = 'dm';
            }
            maybePlaySound(soundType, msg.authorId);
          }
        }
        // Bump the DM channel to the top of the list so the sidebar and
        // DMs home page reflect the most-recently-active conversation.
        if (knownDM) {
          useDMStore.getState().bumpDMChannel(msg.channelId);
        } else if (likelyDM && msg.authorId !== currentUserId) {
          // New DM not yet in the store — fetch once (guard against
          // duplicate fetches while the first request is in flight).
          if (!pendingDMFetchChannels.has(msg.channelId)) {
            pendingDMFetchChannels.add(msg.channelId);
            fetchDMChannels()
              .catch(() => {})
              .finally(() => pendingDMFetchChannels.delete(msg.channelId));
          }
        }
        // Index for local search (best-effort, no-ops if decrypt unavailable)
        indexIncomingMessage(msg.channelId, msg);
      } else if (
        event.payload.case === 'messageUpdate' &&
        event.payload.value
      ) {
        const msg = event.payload.value;
        useMessageStore.getState().updateMessage(msg.channelId, msg);
        // Decrypt edited content (same as messageCreate)
        if (msg.keyVersion > 0 && isSessionReady()) {
          decryptInBackground(msg.channelId, msg, generation);
        } else {
          // Already decrypted — re-index with updated content
          indexIncomingMessage(msg.channelId, msg);
        }
      } else if (
        event.payload.case === 'messageDelete' &&
        event.payload.value
      ) {
        const { channelId, messageId } = event.payload.value;
        useMessageStore.getState().removeMessage(channelId, messageId);
        removeSearchMessage(channelId, messageId).catch(() => {});
      } else if (
        event.payload.case === 'messageBulkDelete' &&
        event.payload.value
      ) {
        const { channelId, messageIds } = event.payload.value;
        useMessageStore.getState().removeMessages(channelId, messageIds);
        removeSearchMessages(channelId, messageIds).catch(() => {});
      } else if (event.payload.case === 'typingStart' && event.payload.value) {
        const { channelId, userId } = event.payload.value;
        if (userId !== currentUserId) {
          useTypingStore.getState().setTyping(channelId, userId);
        }
      } else if (
        event.payload.case === 'channelCreate' &&
        event.payload.value
      ) {
        useChannelStore.getState().addChannel(event.payload.value);
      } else if (
        event.payload.case === 'channelUpdate' &&
        event.payload.value
      ) {
        const updatedChannel = event.payload.value;
        // When permissionsSynced flips to true, eagerly clear local overrides
        // for this channel to prevent flickering from trickle-in delete events.
        if (updatedChannel.permissionsSynced) {
          const channelStore = useChannelStore.getState();
          const existing = channelStore.byServer[updatedChannel.serverId]?.find(
            (c) => c.id === updatedChannel.id,
          );
          if (existing && !existing.permissionsSynced) {
            usePermissionOverrideStore
              .getState()
              .setOverrides(updatedChannel.id, []);
          }
        }
        useChannelStore.getState().updateChannel(updatedChannel);
      } else if (
        event.payload.case === 'channelDelete' &&
        event.payload.value
      ) {
        const { channelId } = event.payload.value;
        useChannelStore.getState().removeChannel(channelId);
        // Clean up typing throttle for the deleted channel
        typingThrottles.delete(channelId);
        // Disconnect voice if the deleted channel is the one we're connected to
        const voiceState = useVoiceStore.getState();
        if (voiceState.channelId === channelId) {
          voiceState.disconnect();
        }
      } else if (event.payload.case === 'memberJoin' && event.payload.value) {
        const joinedMember = event.payload.value;
        useMemberStore.getState().addMember(joinedMember);
        // E2EE: any online member distributes channel keys to the new member.
        // The inviter distributes immediately; other members delay 3-8s as backup
        // in case the inviter is offline. UPSERT semantics make duplicates harmless.
        if (
          joinedMember.userId !== currentUserId &&
          joinedMember.serverId &&
          isSessionReady()
        ) {
          const serverId = joinedMember.serverId;
          const newUserId = joinedMember.userId;
          const isInviter = joinedMember.inviterUserId === currentUserId;
          const jitterMs = isInviter ? 0 : 1000 + Math.random() * 2000;
          const gen = generation;
          setTimeout(() => {
            if (gen !== generation) return;
            (async () => {
              try {
                const maybePk = await fetchPublicKeyWithRetry(newUserId, gen);
                if (!maybePk || gen !== generation) return;
                const pk: Uint8Array = maybePk;
                // Get all non-private channels in this server.
                // Skip private channels — the new member won't have
                // ViewChannel on them (@everyone deny). They'll lazy-init
                // if they're later granted access.
                // distributeKeyToMember handles cache misses via server fetch,
                // so we don't need to pre-filter by hasChannelKey.
                const channels =
                  useChannelStore.getState().byServer[serverId] ?? [];
                const CONCURRENCY = 5;
                const queue = channels.filter((ch) => !ch.isPrivate);
                async function distributeWorker() {
                  while (queue.length > 0) {
                    const ch = queue.shift();
                    if (!ch) break;
                    try {
                      await distributeKeyToMember(ch.id, newUserId, pk);
                    } catch (err) {
                      console.error(
                        `[E2EE] key distribution to ${newUserId} for ${ch.id}:`,
                        err,
                      );
                    }
                  }
                }
                await Promise.all(
                  Array.from(
                    { length: Math.min(CONCURRENCY, queue.length) },
                    () => distributeWorker(),
                  ),
                );
              } catch (err) {
                console.error(
                  `[E2EE] failed to distribute keys to new member ${newUserId}:`,
                  err,
                );
              }
            })();
          }, jitterMs);
        }
      } else if (event.payload.case === 'memberUpdate' && event.payload.value) {
        useMemberStore.getState().updateMember(event.payload.value);
      } else if (event.payload.case === 'memberRemove' && event.payload.value) {
        const { serverId, userId } = event.payload.value;
        useMemberStore.getState().removeMember(serverId, userId);
        // If the removed user is us, clean up all server-related state.
        if (userId === currentUserId) {
          useServerStore.getState().removeServer(serverId);
          useChannelStore.getState().removeServerChannels(serverId);
          useRoleStore.getState().removeServerRoles(serverId);
          useChannelGroupStore.getState().removeServerGroups(serverId);
          useEmojiStore.getState().removeServerEmojis(serverId);
        }
      } else if (event.payload.case === 'roleCreate' && event.payload.value) {
        useRoleStore.getState().addRole(event.payload.value);
      } else if (event.payload.case === 'roleUpdate' && event.payload.value) {
        useRoleStore.getState().updateRole(event.payload.value);
      } else if (event.payload.case === 'roleDelete' && event.payload.value) {
        const { serverId, roleId } = event.payload.value;
        useRoleStore.getState().removeRole(serverId, roleId);
        // Strip deleted role from all members (single store update)
        useMemberStore.getState().stripRoleFromAll(serverId, roleId);
      } else if (
        event.payload.case === 'rolesReordered' &&
        event.payload.value
      ) {
        const { serverId, roles } = event.payload.value;
        useRoleStore.getState().setRoles(serverId, roles);
      } else if (event.payload.case === 'pinAdd' && event.payload.value) {
        const pin = event.payload.value;
        if (pin.message) {
          usePinStore.getState().addPin(pin.message.channelId, pin);
        }
      } else if (event.payload.case === 'pinRemove' && event.payload.value) {
        const { channelId, messageId } = event.payload.value;
        usePinStore.getState().removePin(channelId, messageId);
      } else if (event.payload.case === 'reactionAdd' && event.payload.value) {
        const { messageId, emoji, userId, customEmoji } = event.payload.value;
        useReactionStore
          .getState()
          .addReaction(messageId, emoji, userId, userId === currentUserId);
        if (customEmoji?.id) {
          useEmojiStore
            .getState()
            .setReactionEmojis({ [customEmoji.id]: customEmoji });
        }
      } else if (
        event.payload.case === 'reactionRemove' &&
        event.payload.value
      ) {
        const { messageId, emoji, userId } = event.payload.value;
        useReactionStore
          .getState()
          .removeReaction(messageId, emoji, userId, userId === currentUserId);
      } else if (event.payload.case === 'emojiCreate' && event.payload.value) {
        useEmojiStore.getState().addEmoji(event.payload.value);
      } else if (event.payload.case === 'emojiUpdate' && event.payload.value) {
        useEmojiStore.getState().updateEmoji(event.payload.value);
      } else if (event.payload.case === 'emojiDelete' && event.payload.value) {
        const { serverId, emojiId } = event.payload.value;
        useEmojiStore.getState().removeEmoji(serverId, emojiId);
      } else if (event.payload.case === 'soundCreate' && event.payload.value) {
        useSoundStore.getState().addSound(event.payload.value);
      } else if (event.payload.case === 'soundUpdate' && event.payload.value) {
        useSoundStore.getState().updateSound(event.payload.value);
      } else if (event.payload.case === 'soundDelete' && event.payload.value) {
        const { soundId, serverId } = event.payload.value;
        useSoundStore.getState().removeSound(soundId, serverId);
      } else if (event.payload.case === 'embedsUpdate' && event.payload.value) {
        const { channelId, messageId, embeds } = event.payload.value;
        useMessageStore.getState().patchEmbeds(channelId, messageId, embeds);
      } else if (
        event.payload.case === 'readStateUpdate' &&
        event.payload.value
      ) {
        const { channelId, lastReadMessageId, unreadCount } =
          event.payload.value;
        useReadStateStore
          .getState()
          .updateReadState(channelId, lastReadMessageId, unreadCount);
      } else if (
        event.payload.case === 'channelMemberAdd' &&
        event.payload.value
      ) {
        // Channel member events — re-fetch channels when current user is affected.
        const { serverId, channelId: chId, userId } = event.payload.value;
        if (userId === currentUserId && serverId) {
          fetchChannels(serverId).catch(() => {});
        }
        // Group DM member added — re-fetch DM list to pick up participant changes.
        if (!serverId && chId) {
          fetchDMChannels().catch(() => {});
        }
        // If a new member was added, distribute the channel key to them
        // with retry — the new user may still be bootstrapping.
        // distributeKeyToMember handles cache misses via server fetch.
        if (userId !== currentUserId && chId && isSessionReady()) {
          const gen = generation;
          fetchPublicKeyWithRetry(userId, gen).then((pk) => {
            if (pk && gen === generation) {
              distributeKeyToMember(chId, userId, pk).catch((err) =>
                console.error(
                  `[E2EE] distributeKeyToMember failed for ${userId} in ${chId}:`,
                  err,
                ),
              );
            }
          });
        }
      } else if (
        event.payload.case === 'channelMemberRemove' &&
        event.payload.value
      ) {
        const { serverId, channelId: removeChId, userId } = event.payload.value;
        if (userId === currentUserId && serverId) {
          fetchChannels(serverId).catch(() => {});
        }
        // Group DM member removed — update DM list.
        if (!serverId && removeChId) {
          if (userId === currentUserId) {
            // We were removed — drop from our DM list.
            useDMStore.getState().removeDMChannel(removeChId);
          } else {
            // Someone else was removed — re-fetch to update participants.
            fetchDMChannels().catch(() => {});
          }
        }
        // Clean up typing throttle if we were removed
        if (removeChId && userId === currentUserId) {
          typingThrottles.delete(removeChId);
        }
        // Note: no key rotation on member removal (universal E2EE with static keys)
      } else if (
        event.payload.case === 'channelGroupCreate' &&
        event.payload.value
      ) {
        useChannelGroupStore.getState().addGroup(event.payload.value);
      } else if (
        event.payload.case === 'channelGroupUpdate' &&
        event.payload.value
      ) {
        useChannelGroupStore.getState().updateGroup(event.payload.value);
      } else if (
        event.payload.case === 'channelGroupDelete' &&
        event.payload.value
      ) {
        const { serverId, channelGroupId } = event.payload.value;
        useChannelGroupStore.getState().removeGroup(serverId, channelGroupId);
      } else if (
        event.payload.case === 'permissionsUpdated' &&
        event.payload.value
      ) {
        // Permission events — re-fetch channels when permissions change (ViewChannel filter may differ).
        const { serverId } = event.payload.value;
        if (serverId) {
          fetchChannels(serverId).catch(() => {});
        }
      } else if (
        event.payload.case === 'permissionOverrideUpdate' &&
        event.payload.value
      ) {
        const { serverId, override } = event.payload.value;
        if (override) {
          usePermissionOverrideStore
            .getState()
            .upsertOverride(override.targetId, override);
        }
        if (serverId) {
          fetchChannels(serverId).catch(() => {});
        }
      } else if (
        event.payload.case === 'permissionOverrideDelete' &&
        event.payload.value
      ) {
        const { serverId, targetId, overrideId } = event.payload.value;
        if (targetId && overrideId) {
          const overrides =
            usePermissionOverrideStore.getState().byTarget[targetId];
          const match = overrides?.find((o) => o.id === overrideId);
          if (match) {
            usePermissionOverrideStore
              .getState()
              .removeOverride(targetId, match.roleId, match.userId);
          }
        }
        if (serverId) {
          fetchChannels(serverId).catch(() => {});
        }
      } else if (
        event.payload.case === 'federationRemoved' &&
        event.payload.value
      ) {
        const { serverId } = event.payload.value;
        if (serverId) {
          fetchChannels(serverId).catch(() => {});
        }
      } else if (
        event.payload.case === 'dmRequestReceived' &&
        event.payload.value
      ) {
        // Message request events.
        useDMStore.getState().addMessageRequest(event.payload.value);
        maybePlaySound('dm');
      } else if (
        event.payload.case === 'dmRequestAccepted' &&
        event.payload.value
      ) {
        const channelId = event.payload.value.channel?.id;
        if (channelId) {
          useDMStore.getState().moveRequestToActive(channelId);
        }
      } else if (
        event.payload.case === 'dmRequestDeclined' &&
        event.payload.value
      ) {
        useDMStore
          .getState()
          .removeMessageRequest(event.payload.value.channelId);
      } else if (event.payload.case === 'userBlocked' && event.payload.value) {
        // Block events.
        const { userId, channelId } = event.payload.value;
        if (channelId) {
          useDMStore.getState().removeDMChannel(channelId);
        }
        if (userId) {
          useBlockStore.getState().addBlockedUserId(userId);
        }
      } else if (
        event.payload.case === 'userUnblocked' &&
        event.payload.value
      ) {
        const { userId } = event.payload.value;
        if (userId) {
          useBlockStore.getState().removeBlockedUser(userId);
        }
        fetchDMChannels().catch(() => {});
      } else if (
        event.payload.case === 'friendRequestReceived' &&
        event.payload.value
      ) {
        // Friend events.
        const { user } = event.payload.value;
        if (user) {
          useFriendStore.getState().addIncomingRequest(
            create(FriendRequestEntrySchema, {
              user,
              direction: 'incoming',
              createdAt: new Date().toISOString(),
            }),
          );
          maybePlaySound('dm');
        }
      } else if (
        event.payload.case === 'friendRequestAccepted' &&
        event.payload.value
      ) {
        const { user } = event.payload.value;
        if (user) {
          useFriendStore.getState().acceptFriend(user);
        }
      } else if (
        event.payload.case === 'friendRequestDeclined' &&
        event.payload.value
      ) {
        const { user } = event.payload.value;
        if (user) {
          useFriendStore.getState().removeIncomingRequest(user.id);
        }
      } else if (
        event.payload.case === 'friendRemoved' &&
        event.payload.value
      ) {
        const { user } = event.payload.value;
        if (user) {
          useFriendStore.getState().removeFriend(user.id);
        }
      } else if (
        event.payload.case === 'friendRequestCancelled' &&
        event.payload.value
      ) {
        const { user } = event.payload.value;
        if (user) {
          useFriendStore.getState().removeIncomingRequest(user.id);
        }
      } else if (event.payload.case === 'keyRequest' && event.payload.value) {
        // E2EE key request events.
        const { channelId, userId } = event.payload.value;
        // Don't respond to our own request.
        if (
          userId !== currentUserId &&
          isSessionReady() &&
          hasChannelKey(channelId)
        ) {
          const gen = generation;
          // Random jitter (0–2s) to prevent thundering herd when multiple
          // clients receive the same request simultaneously.
          const jitterMs = Math.random() * 2000;
          setTimeout(() => {
            if (gen !== generation) return;
            (async () => {
              try {
                const pk = await fetchPublicKeyWithRetry(userId, gen);
                if (!pk || gen !== generation) return;
                await distributeKeyToMember(channelId, userId, pk);
              } catch (err) {
                console.error(
                  `[E2EE] key request: failed to distribute key for ${channelId} to ${userId}:`,
                  err,
                );
              }
            })();
          }, jitterMs);
        }
      }
      // Server metadata update events.
      if (event.payload.case === 'serverUpdate' && event.payload.value) {
        const { server } = event.payload.value;
        if (server) {
          useServerStore.getState().addServer(server);
        }
      }
      // User profile update events.
      if (event.payload.case === 'userUpdate' && event.payload.value) {
        const { user } = event.payload.value;
        if (user) {
          const store = useUsersStore.getState();
          const converted = publicUserToStored(user);
          const existing = store.profiles[user.id];
          store.setProfile(
            user.id,
            existing ? { ...existing, ...converted } : converted,
          );
        }
      }
      // Presence update events.
      if (event.payload.case === 'presenceUpdate' && event.payload.value) {
        const { userId, status, statusText } = event.payload.value;
        if (userId) {
          usePresenceStore.getState().setPresence(userId, status, statusText);
        }
      }
      break;
    }
  }
}

// Throttle map: channelId -> last send timestamp
const typingThrottles = new Map<string, number>();

export function sendTyping(channelId: string) {
  const now = Date.now();
  const lastSent = typingThrottles.get(channelId) ?? 0;
  if (now - lastSent < 3000) return;
  typingThrottles.set(channelId, now);

  const userId = useAuthStore.getState().user?.id ?? '';
  const typingEvent = create(TypingEventSchema, { channelId, userId });
  const payload = toBinary(TypingEventSchema, typingEvent);
  sendEnvelope(GatewayOpCode.GATEWAY_OP_TYPING_START, payload);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    // If no ACK received for 1.5 heartbeat cycles, force reconnect
    if (lastHeartbeatAck > 0 && Date.now() - lastHeartbeatAck > 45_000) {
      console.warn('[Gateway] Heartbeat ACK timeout, forcing reconnect');
      if (ws) {
        ws.close();
      }
      return;
    }
    sendEnvelope(GatewayOpCode.GATEWAY_OP_HEARTBEAT);
  }, 30_000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect() {
  // Skip reconnect attempts when offline — the 'online' listener will trigger reconnect
  if (!isOnline) {
    useGatewayStore.getState().setStatus('reconnecting');
    return;
  }
  if (reconnectAttempts >= 10) return;
  reconnectAttempts++;
  const gw = useGatewayStore.getState();
  gw.setStatus('reconnecting');
  gw.setReconnectAttempt(reconnectAttempts);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    const freshToken = useAuthStore.getState().accessToken;
    if (freshToken) connect(freshToken);
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
}

export function disconnect() {
  updatePresence(PresenceStatus.OFFLINE);
  usePresenceStore.getState().setMyStatus(PresenceStatus.OFFLINE);
  generation++;
  stopHeartbeat();
  if (overrideExpiryTimer) {
    clearTimeout(overrideExpiryTimer);
    overrideExpiryTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  typingThrottles.clear();
  keyRetryInFlight.clear();
  signingKeyCache.clear();
  lastHeartbeatAck = 0;
  hasConnectedBefore = false;
  useGatewayStore.getState().setStatus('disconnected');
}

// --- Browser connectivity listeners ---
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    isOnline = true;
    const { status } = useGatewayStore.getState();
    if (status === 'reconnecting') {
      // Network returned — reset backoff and attempt immediately
      reconnectDelay = 1000;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const freshToken = useAuthStore.getState().accessToken;
      if (freshToken) connect(freshToken);
    }
  });

  window.addEventListener('offline', () => {
    isOnline = false;
    // Pause scheduled reconnect attempts
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const { status } = useGatewayStore.getState();
    if (status === 'reconnecting') {
      // Tab became visible while reconnecting — reset backoff for fast retry
      reconnectDelay = 1000;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const freshToken = useAuthStore.getState().accessToken;
      if (freshToken) connect(freshToken);
    } else if (status === 'connected' && ws) {
      // If connected but heartbeat ACK is stale, force reconnect
      if (lastHeartbeatAck > 0 && Date.now() - lastHeartbeatAck > 45_000) {
        console.warn(
          '[Gateway] Stale heartbeat ACK on visibility change, forcing reconnect',
        );
        ws.close();
      }
    }
  });
}
