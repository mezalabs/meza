/**
 * Simplified WebSocket manager for federated spoke connections.
 *
 * Each spoke gets its own WebSocket with IDENTIFY, heartbeat, and reconnect.
 * Events dispatch into shared stores (same as origin) but deliberately skip
 * origin-only logic: E2EE key redistribution, DMs, friends, sounds, emoji sync.
 */
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { EventSchema } from '@meza/gen/meza/v1/chat_pb.ts';
import {
  GatewayEnvelopeSchema,
  GatewayOpCode,
} from '@meza/gen/meza/v1/gateway_pb.ts';
import { removeSpokeTransport } from '../api/federation-transport.ts';
import { useAuthStore } from '../store/auth.ts';
import { useChannelGroupStore } from '../store/channel-groups.ts';
import { useChannelStore } from '../store/channels.ts';
import {
  type SpokeConnectionStatus,
  useFederationStore,
} from '../store/federation.ts';
import { useGatewayStore } from '../store/gateway.ts';
import { useMemberStore } from '../store/members.ts';
import { useMessageStore } from '../store/messages.ts';
import { usePermissionOverrideStore } from '../store/permission-overrides.ts';
import { usePinStore } from '../store/pins.ts';
import { usePresenceStore } from '../store/presence.ts';
import { useReactionStore } from '../store/reactions.ts';
import { useReadStateStore } from '../store/read-state.ts';
import { useRoleStore } from '../store/roles.ts';
import { useServerStore } from '../store/servers.ts';
import { useTypingStore } from '../store/typing.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpokeGateway {
  ws: WebSocket | null;
  generation: number;
  lastHeartbeatSent: number;
  lastHeartbeatAck: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectDelay: number;
  reconnectAttempts: number;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const spokeGateways = new Map<string, SpokeGateway>();
let heartbeatCoordinator: ReturnType<typeof setInterval> | null = null;

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_CHECK_MS = 5_000;
const HEARTBEAT_ACK_TIMEOUT_MS = 45_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_RECONNECT_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Heartbeat coordinator (single timer for all spokes)
// ---------------------------------------------------------------------------

function startHeartbeatCoordinator() {
  if (heartbeatCoordinator) return;
  heartbeatCoordinator = setInterval(() => {
    const now = Date.now();
    for (const [instanceUrl, gw] of spokeGateways) {
      if (!gw.ws || gw.ws.readyState !== WebSocket.OPEN) continue;

      // ACK timeout check
      if (
        gw.lastHeartbeatAck > 0 &&
        now - gw.lastHeartbeatAck > HEARTBEAT_ACK_TIMEOUT_MS
      ) {
        console.warn(`[SpokeGateway] Heartbeat ACK timeout for ${instanceUrl}`);
        gw.ws.close();
        continue;
      }

      // Send heartbeat if due
      if (now - gw.lastHeartbeatSent >= HEARTBEAT_INTERVAL_MS) {
        sendEnvelope(gw, GatewayOpCode.GATEWAY_OP_HEARTBEAT);
        gw.lastHeartbeatSent = now;
      }
    }
  }, HEARTBEAT_CHECK_MS);
}

function stopHeartbeatCoordinator() {
  if (heartbeatCoordinator) {
    clearInterval(heartbeatCoordinator);
    heartbeatCoordinator = null;
  }
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

function sendEnvelope(
  gw: SpokeGateway,
  op: GatewayOpCode,
  payload?: Uint8Array,
) {
  if (!gw.ws || gw.ws.readyState !== WebSocket.OPEN) return;
  const env = create(GatewayEnvelopeSchema, {
    op,
    payload: payload ?? new Uint8Array(),
  });
  gw.ws.send(toBinary(GatewayEnvelopeSchema, env));
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export function connectSpoke(instanceUrl: string): void {
  // Don't double-connect
  const existing = spokeGateways.get(instanceUrl);
  if (existing?.ws && existing.ws.readyState <= WebSocket.OPEN) return;

  const spoke = useFederationStore.getState().spokes[instanceUrl];
  if (!spoke?.accessToken) return;

  const gw: SpokeGateway = existing ?? {
    ws: null,
    generation: 0,
    lastHeartbeatSent: 0,
    lastHeartbeatAck: 0,
    reconnectTimer: null,
    reconnectDelay: 1000,
    reconnectAttempts: 0,
  };
  gw.generation++;
  const gen = gw.generation;
  spokeGateways.set(instanceUrl, gw);

  updateStatus(instanceUrl, 'connecting');

  const parsed = new URL(instanceUrl);
  const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProto}//${parsed.host}/ws`;
  const socket = new WebSocket(wsUrl);
  socket.binaryType = 'arraybuffer';
  gw.ws = socket;

  socket.onopen = () => {
    if (gen !== gw.generation) return;
    const identifyJson = JSON.stringify({ token: spoke.accessToken });
    sendEnvelope(
      gw,
      GatewayOpCode.GATEWAY_OP_IDENTIFY,
      new TextEncoder().encode(identifyJson),
    );
    gw.lastHeartbeatAck = Date.now();
    gw.lastHeartbeatSent = Date.now();
    gw.reconnectDelay = 1000;
    gw.reconnectAttempts = 0;
    startHeartbeatCoordinator();
  };

  socket.onmessage = (e: MessageEvent) => {
    if (gen !== gw.generation) return;
    const data = new Uint8Array(e.data as ArrayBuffer);
    const env = fromBinary(GatewayEnvelopeSchema, data);
    dispatchSpokeOp(instanceUrl, gw, env.op, env.payload);
  };

  socket.onclose = () => {
    if (gen !== gw.generation) return;
    gw.ws = null;
    scheduleReconnect(instanceUrl, gw);
  };

  socket.onerror = () => {
    // onclose fires after onerror
  };
}

export function disconnectSpoke(instanceUrl: string): void {
  const gw = spokeGateways.get(instanceUrl);
  if (!gw) return;
  gw.generation++;
  if (gw.reconnectTimer) {
    clearTimeout(gw.reconnectTimer);
    gw.reconnectTimer = null;
  }
  if (gw.ws) {
    gw.ws.close();
    gw.ws = null;
  }
  spokeGateways.delete(instanceUrl);
  if (spokeGateways.size === 0) stopHeartbeatCoordinator();
  updateStatus(instanceUrl, 'disconnected');
}

export function disconnectAllSpokes(): void {
  for (const instanceUrl of [...spokeGateways.keys()]) {
    disconnectSpoke(instanceUrl);
  }
}

// ---------------------------------------------------------------------------
// Reconnection
// ---------------------------------------------------------------------------

function scheduleReconnect(instanceUrl: string, gw: SpokeGateway) {
  if (gw.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    updateStatus(instanceUrl, 'error', 'Max reconnect attempts reached');
    return;
  }
  gw.reconnectAttempts++;
  updateStatus(instanceUrl, 'reconnecting');
  if (gw.reconnectTimer) clearTimeout(gw.reconnectTimer);
  gw.reconnectTimer = setTimeout(() => {
    connectSpoke(instanceUrl);
  }, gw.reconnectDelay);
  gw.reconnectDelay = Math.min(gw.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Status helper
// ---------------------------------------------------------------------------

function updateStatus(
  instanceUrl: string,
  status: SpokeConnectionStatus,
  error?: string,
) {
  useFederationStore
    .getState()
    .updateSpokeStatus(instanceUrl, status, error ?? null);
}

// ---------------------------------------------------------------------------
// Spoke cleanup (shared between FederationRemovedEvent, ban, kick)
// ---------------------------------------------------------------------------

export function cleanupSpoke(
  instanceUrl: string,
  serverId: string,
  reason?: string,
) {
  disconnectSpoke(instanceUrl);
  removeSpokeTransport(instanceUrl);
  useFederationStore.getState().removeSpoke(instanceUrl);
  useServerStore.getState().removeServer(serverId);
  useChannelStore.getState().removeServerChannels(serverId);
  useRoleStore.getState().removeServerRoles(serverId);
  useChannelGroupStore.getState().removeServerGroups(serverId);
  if (reason) {
    console.info(`[SpokeGateway] Removed from ${instanceUrl}: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Spoke event dispatch
// ---------------------------------------------------------------------------

function dispatchSpokeOp(
  instanceUrl: string,
  gw: SpokeGateway,
  op: GatewayOpCode,
  payload: Uint8Array,
) {
  const spoke = useFederationStore.getState().spokes[instanceUrl];
  if (!spoke) return;

  switch (op) {
    case GatewayOpCode.GATEWAY_OP_READY:
      updateStatus(instanceUrl, 'connected');
      break;

    case GatewayOpCode.GATEWAY_OP_HEARTBEAT_ACK:
      gw.lastHeartbeatAck = Date.now();
      break;

    case GatewayOpCode.GATEWAY_OP_EVENT:
      dispatchSpokeEvent(instanceUrl, spoke.serverId, payload);
      break;
  }
}

function dispatchSpokeEvent(
  instanceUrl: string,
  expectedServerId: string,
  payload: Uint8Array,
) {
  const event = fromBinary(EventSchema, payload);
  const currentUserId = useAuthStore.getState().user?.id;

  // Security: verify the event belongs to this spoke's server.
  // The Event proto doesn't have a top-level serverId — extract it from the
  // payload value where available (most events carry serverId on the inner message).
  const val = event.payload.value;
  const eventServerId =
    val && typeof val === 'object' && 'serverId' in val
      ? (val as { serverId: string }).serverId
      : undefined;
  if (eventServerId && eventServerId !== expectedServerId) {
    console.warn(
      `[SpokeGateway] Rejected event for ${eventServerId} from spoke ${instanceUrl} (expected ${expectedServerId})`,
    );
    return;
  }

  // --- Message events ---
  if (event.payload.case === 'messageCreate' && event.payload.value) {
    const msg = event.payload.value;
    useMessageStore.getState().addMessage(msg.channelId, msg);
    useTypingStore.getState().clearUser(msg.channelId, msg.authorId);
    if (msg.authorId !== currentUserId) {
      const viewed = useGatewayStore.getState().viewedChannelIds;
      if (!viewed[msg.channelId]) {
        useReadStateStore.getState().incrementUnread(msg.channelId);
      }
    }
  } else if (event.payload.case === 'messageUpdate' && event.payload.value) {
    useMessageStore
      .getState()
      .updateMessage(event.payload.value.channelId, event.payload.value);
  } else if (event.payload.case === 'messageDelete' && event.payload.value) {
    const { channelId, messageId } = event.payload.value;
    useMessageStore.getState().removeMessage(channelId, messageId);
  } else if (
    event.payload.case === 'messageBulkDelete' &&
    event.payload.value
  ) {
    const { channelId, messageIds } = event.payload.value;
    for (const id of messageIds) {
      useMessageStore.getState().removeMessage(channelId, id);
    }

    // --- Typing ---
  } else if (event.payload.case === 'typingStart' && event.payload.value) {
    const { channelId, userId } = event.payload.value;
    if (userId !== currentUserId) {
      useTypingStore.getState().setTyping(channelId, userId);
    }

    // --- Channel events ---
  } else if (event.payload.case === 'channelCreate' && event.payload.value) {
    useChannelStore.getState().addChannel(event.payload.value);
  } else if (event.payload.case === 'channelUpdate' && event.payload.value) {
    useChannelStore.getState().updateChannel(event.payload.value);
  } else if (event.payload.case === 'channelDelete' && event.payload.value) {
    useChannelStore.getState().removeChannel(event.payload.value.channelId);

    // --- Member events ---
  } else if (event.payload.case === 'memberJoin' && event.payload.value) {
    useMemberStore.getState().addMember(event.payload.value);
  } else if (event.payload.case === 'memberUpdate' && event.payload.value) {
    useMemberStore.getState().updateMember(event.payload.value);
  } else if (event.payload.case === 'memberRemove' && event.payload.value) {
    const { serverId: sid, userId } = event.payload.value;
    useMemberStore.getState().removeMember(sid, userId);
    // If we were kicked, clean up the spoke.
    if (userId === currentUserId) {
      cleanupSpoke(instanceUrl, expectedServerId, 'Removed from server');
    }

    // --- Server ---
  } else if (event.payload.case === 'serverUpdate' && event.payload.value) {
    const { server } = event.payload.value;
    if (server) {
      useServerStore.getState().addServer(server);
    }

    // --- Roles ---
  } else if (event.payload.case === 'roleCreate' && event.payload.value) {
    useRoleStore.getState().addRole(event.payload.value);
  } else if (event.payload.case === 'roleUpdate' && event.payload.value) {
    useRoleStore.getState().updateRole(event.payload.value);
  } else if (event.payload.case === 'roleDelete' && event.payload.value) {
    const { serverId: sid, roleId } = event.payload.value;
    useRoleStore.getState().removeRole(sid, roleId);
    useMemberStore.getState().stripRoleFromAll(sid, roleId);
  } else if (event.payload.case === 'rolesReordered' && event.payload.value) {
    const { serverId: sid, roles } = event.payload.value;
    useRoleStore.getState().setRoles(sid, roles);

    // --- Reactions ---
  } else if (event.payload.case === 'reactionAdd' && event.payload.value) {
    const { messageId, emoji, userId } = event.payload.value;
    useReactionStore
      .getState()
      .addReaction(messageId, emoji, userId, userId === currentUserId);
  } else if (event.payload.case === 'reactionRemove' && event.payload.value) {
    const { messageId, emoji, userId } = event.payload.value;
    useReactionStore
      .getState()
      .removeReaction(messageId, emoji, userId, userId === currentUserId);

    // --- Pins ---
  } else if (event.payload.case === 'pinAdd' && event.payload.value) {
    const pin = event.payload.value;
    if (pin.message) {
      usePinStore.getState().addPin(pin.message.channelId, pin);
    }
  } else if (event.payload.case === 'pinRemove' && event.payload.value) {
    const { channelId, messageId } = event.payload.value;
    usePinStore.getState().removePin(channelId, messageId);

    // --- Embeds ---
  } else if (event.payload.case === 'embedsUpdate' && event.payload.value) {
    const { channelId, messageId, embeds } = event.payload.value;
    useMessageStore.getState().patchEmbeds(channelId, messageId, embeds);

    // --- Read state ---
  } else if (event.payload.case === 'readStateUpdate' && event.payload.value) {
    const { channelId, lastReadMessageId, unreadCount } = event.payload.value;
    useReadStateStore
      .getState()
      .updateReadState(channelId, lastReadMessageId, unreadCount);

    // --- Presence ---
  } else if (event.payload.case === 'presenceUpdate' && event.payload.value) {
    const { userId, status, statusText } = event.payload.value;
    usePresenceStore.getState().setPresence(userId, status, statusText);

    // --- Channel members (simplified: no E2EE key distribution for spokes) ---
  } else if (event.payload.case === 'channelMemberAdd' && event.payload.value) {
    // No direct store method for channel member add in the spoke context.
    // The channel store doesn't track individual channel members — the
    // origin gateway re-fetches channels instead. For spokes, this is a no-op.
  } else if (
    event.payload.case === 'channelMemberRemove' &&
    event.payload.value
  ) {
    // Same as above — no-op for spoke context.
    // --- Channel groups ---
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
    const { serverId: sid, channelGroupId } = event.payload.value;
    useChannelGroupStore.getState().removeGroup(sid, channelGroupId);

    // --- Permissions (simplified: no re-fetch, just log) ---
  } else if (
    event.payload.case === 'permissionsUpdated' &&
    event.payload.value
  ) {
    // Spoke permissions updated — no server-side re-fetch available via
    // origin transport. The channel list from initial join stays as-is.
  } else if (
    event.payload.case === 'permissionOverrideUpdate' &&
    event.payload.value
  ) {
    const { override } = event.payload.value;
    if (override) {
      usePermissionOverrideStore
        .getState()
        .upsertOverride(override.targetId, override);
    }
  } else if (
    event.payload.case === 'permissionOverrideDelete' &&
    event.payload.value
  ) {
    const { targetId, overrideId } = event.payload.value;
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
  }
}

// ---------------------------------------------------------------------------
// Startup reconnection
// ---------------------------------------------------------------------------

const RECONNECT_CONCURRENCY = 5;

/**
 * Reconnect to all persisted spokes. Called once the origin gateway is connected.
 * Connects spokes in parallel with a concurrency limit.
 */
export async function reconnectAllSpokes(): Promise<void> {
  const spokes = Object.values(useFederationStore.getState().spokes);
  if (spokes.length === 0) return;

  const queue = [...spokes];
  async function worker() {
    while (queue.length > 0) {
      const spoke = queue.shift();
      if (!spoke) break;
      connectSpoke(spoke.instanceUrl);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(RECONNECT_CONCURRENCY, queue.length) }, () =>
      worker(),
    ),
  );
}

// Auto-reconnect spokes when the origin gateway connects.
// This subscribes once at module load time.
let spokeReconnectScheduled = false;
if (typeof window !== 'undefined') {
  useGatewayStore.subscribe((state, prev) => {
    if (state.status === 'connected' && prev.status !== 'connected') {
      // Debounce: only reconnect once per origin connection cycle.
      if (spokeReconnectScheduled) return;
      spokeReconnectScheduled = true;
      // Small delay to let origin data hydrate first.
      setTimeout(() => {
        spokeReconnectScheduled = false;
        reconnectAllSpokes().catch((err) =>
          console.error('[SpokeGateway] Reconnection failed:', err),
        );
      }, 500);
    }
  });
}
