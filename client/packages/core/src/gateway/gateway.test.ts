import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { EventSchema, TypingEventSchema } from '@meza/gen/meza/v1/chat_pb.ts';
import {
  GatewayEnvelopeSchema,
  GatewayOpCode,
} from '@meza/gen/meza/v1/gateway_pb.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/auth.ts';
import { useChannelStore } from '../store/channels.ts';
import { useEmojiStore } from '../store/emojis.ts';
import { useMemberStore } from '../store/members.ts';
import { useMessageStore } from '../store/messages.ts';
import { usePinStore } from '../store/pins.ts';
import { useReactionStore } from '../store/reactions.ts';
import { useRoleStore } from '../store/roles.ts';
import { useServerStore } from '../store/servers.ts';
import { useSoundStore } from '../store/sounds.ts';
import { useTypingStore } from '../store/typing.ts';
import { useVoiceStore } from '../store/voice.ts';

// ---------------------------------------------------------------------------
// Mock the presence API so it never makes real network calls
// ---------------------------------------------------------------------------
vi.mock('../api/presence.ts', () => ({
  updatePresence: vi.fn(),
}));

const mockListChannels = vi.fn().mockResolvedValue([]);
vi.mock('../api/chat.ts', () => ({
  listChannels: (...args: unknown[]) => mockListChannels(...args),
}));

// ---------------------------------------------------------------------------
// Minimal mock WebSocket that exposes its event handlers for test driving.
// We capture every instance so tests can simulate open / message / close.
// ---------------------------------------------------------------------------
type MockWebSocket = {
  url: string;
  binaryType: string;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

let sockets: MockWebSocket[] = [];

function latestSocket(): MockWebSocket {
  // biome-ignore lint/style/noNonNullAssertion: test helper — socket always exists after connect
  return sockets[sockets.length - 1]!;
}

function createMockWebSocketClass() {
  const WS = function (this: MockWebSocket, url: string) {
    this.url = url;
    this.binaryType = '';
    this.readyState = 0; // CONNECTING
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.send = vi.fn();
    this.close = vi.fn(() => {
      this.readyState = 3; // CLOSED
    });
    sockets.push(this);
  } as unknown as {
    new (url: string): MockWebSocket;
    CONNECTING: number;
    OPEN: number;
    CLOSING: number;
    CLOSED: number;
  };
  WS.CONNECTING = 0;
  WS.OPEN = 1;
  WS.CLOSING = 2;
  WS.CLOSED = 3;
  return WS;
}

// ---------------------------------------------------------------------------
// Helper: simulate the socket opening
// ---------------------------------------------------------------------------
function openSocket(sock: MockWebSocket) {
  sock.readyState = 1; // OPEN
  sock.onopen?.({});
}

// ---------------------------------------------------------------------------
// Helper: build and deliver a gateway envelope to the socket's onmessage
// ---------------------------------------------------------------------------
function deliverEnvelope(
  sock: MockWebSocket,
  op: GatewayOpCode,
  payload: Uint8Array = new Uint8Array(),
) {
  const env = create(GatewayEnvelopeSchema, { op, payload, sequence: 0n });
  const bytes = toBinary(GatewayEnvelopeSchema, env);
  sock.onmessage?.({ data: bytes.buffer as ArrayBuffer });
}

// ---------------------------------------------------------------------------
// Helper: decode the last binary frame sent through ws.send()
// ---------------------------------------------------------------------------
function lastSentEnvelope(sock: MockWebSocket) {
  const calls = sock.send.mock.calls;
  if (calls.length === 0) return null;
  const raw = calls[calls.length - 1]?.[0] as Uint8Array;
  return fromBinary(GatewayEnvelopeSchema, raw);
}

// ---------------------------------------------------------------------------
// Storage mock (same approach as auth.test.ts)
// ---------------------------------------------------------------------------
const mockStorage = new Map<string, string>();

// Monotonically increasing channel suffix so the module-level throttle map
// inside gateway.ts never carries state between tests (each test uses unique
// channel ids).
let channelSeq = 0;

const ME_USER = {
  id: 'me',
  username: 'me',
  displayName: 'Me',
  avatarUrl: '',
  emojiScale: 1,
} as never;

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  channelSeq++;

  // Provide a minimal location stub
  vi.stubGlobal('location', { protocol: 'https:', host: 'example.com' });

  // Stub WebSocket globally with our mock
  vi.stubGlobal('WebSocket', createMockWebSocketClass());

  // Stub localStorage (auth store's loadFromStorage reads it)
  mockStorage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => mockStorage.get(key) ?? null,
    setItem: (key: string, value: string) => mockStorage.set(key, value),
    removeItem: (key: string) => mockStorage.delete(key),
  });

  // Reset stores
  useMessageStore.setState({
    byChannel: {},
    byId: {},
    hasMore: {},
    isLoading: {},
    error: {},
  });
  useAuthStore.setState({
    accessToken: null,
    refreshToken: null,
    user: null,
    isAuthenticated: false,
    isLoading: false,
    error: null,
  });
  useChannelStore.setState({
    byServer: {},
    isLoading: false,
    error: null,
  });
  useTypingStore.setState({
    byChannel: {},
  });
  useMemberStore.setState({ byServer: {}, isLoading: false, error: null });
  useRoleStore.setState({ byServer: {}, isLoading: false, error: null });
  useEmojiStore.setState({ byServer: {}, isLoading: false, error: null });
  usePinStore.setState({
    byChannel: {},
    hasMore: {},
    isLoading: {},
    error: {},
    pinnedIds: {},
  });
  useReactionStore.setState({ byMessage: {} });
  useSoundStore.setState({
    byServer: {},
    personal: [],
    isLoading: false,
    error: null,
  });
  useServerStore.setState({ servers: {}, isLoading: false, error: null });
  useVoiceStore.setState({
    status: 'idle',
    livekitUrl: null,
    livekitToken: null,
    channelId: null,
    channelName: null,
    canScreenShare: false,
    error: null,
  });
  mockListChannels.mockClear();
});

afterEach(async () => {
  // Dynamically import so each test gets the module's live state.
  // We disconnect to clean up internal timers / state.
  const { disconnect } = await import('./gateway.ts');
  disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================= TESTS =====================================

describe('gateway', () => {
  async function connectAndOpen(): Promise<MockWebSocket> {
    const { connect } = await import('./gateway.ts');
    connect('tok');
    const sock = latestSocket();
    openSocket(sock);
    return sock;
  }

  // -----------------------------------------------------------------------
  // Connection state transitions
  // -----------------------------------------------------------------------
  describe('connection lifecycle', () => {
    it('creates a WebSocket with the correct wss URL and arraybuffer type', async () => {
      const { connect } = await import('./gateway.ts');
      connect('tok-123');

      const sock = latestSocket();
      expect(sock.url).toBe('wss://example.com/ws');
      expect(sock.binaryType).toBe('arraybuffer');
    });

    it('uses ws: protocol when page is served over http:', async () => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3000' });
      const { connect } = await import('./gateway.ts');
      connect('tok');

      expect(latestSocket().url).toBe('ws://localhost:3000/ws');
    });

    it('closes the previous socket when connect is called again', async () => {
      const { connect } = await import('./gateway.ts');
      connect('tok-1');
      const first = latestSocket();

      connect('tok-2');
      expect(first.close).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // IDENTIFY on open
  // -----------------------------------------------------------------------
  describe('IDENTIFY on open', () => {
    it('sends an IDENTIFY envelope containing the token when the socket opens', async () => {
      const { connect } = await import('./gateway.ts');
      connect('my-secret-token');

      const sock = latestSocket();
      openSocket(sock);

      const env = lastSentEnvelope(sock);
      expect(env).not.toBeNull();
      expect(env?.op).toBe(GatewayOpCode.GATEWAY_OP_IDENTIFY);

      const identifyJson = JSON.parse(new TextDecoder().decode(env?.payload));
      expect(identifyJson).toEqual({ token: 'my-secret-token' });
    });

    it('resets reconnect delay on successful open', async () => {
      const sock = await connectAndOpen();

      // Trigger a close so that scheduleReconnect runs
      sock.onclose?.();

      // The first reconnect should use the base delay (1000ms)
      // because onopen reset it.
      useAuthStore.setState({ accessToken: 'tok' });

      const countBefore = sockets.length;
      vi.advanceTimersByTime(1000);

      // A new socket should have been created (reconnect fired)
      expect(sockets.length).toBeGreaterThan(countBefore);
    });
  });

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------
  describe('heartbeat', () => {
    it('sends HEARTBEAT envelopes every 30 seconds after connection opens', async () => {
      const sock = await connectAndOpen();

      // The first call is the IDENTIFY; clear it
      sock.send.mockClear();

      // Advance 30s -> first heartbeat
      vi.advanceTimersByTime(30_000);
      expect(sock.send).toHaveBeenCalledTimes(1);
      let env = lastSentEnvelope(sock);
      expect(env?.op).toBe(GatewayOpCode.GATEWAY_OP_HEARTBEAT);

      // Deliver a HEARTBEAT_ACK so the ACK-timeout check (45s) doesn't fire
      deliverEnvelope(sock, GatewayOpCode.GATEWAY_OP_HEARTBEAT_ACK);

      // Advance another 30s -> second heartbeat
      vi.advanceTimersByTime(30_000);
      expect(sock.send).toHaveBeenCalledTimes(2);
      env = lastSentEnvelope(sock);
      expect(env?.op).toBe(GatewayOpCode.GATEWAY_OP_HEARTBEAT);
    });

    it('stops heartbeats when the socket closes', async () => {
      const sock = await connectAndOpen();
      sock.send.mockClear();

      // Simulate close
      sock.onclose?.();

      // Advance well past a heartbeat interval -- nothing should be sent
      vi.advanceTimersByTime(60_000);
      expect(sock.send).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Message dispatch to stores on EVENT
  // -----------------------------------------------------------------------
  describe('EVENT dispatch', () => {
    it('dispatches messageCreate to the message store', async () => {
      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'messageCreate',
          value: { id: 'm1', channelId: 'c1', authorId: 'u1' } as never,
        },
      });
      const eventBytes = toBinary(EventSchema, event);
      deliverEnvelope(sock, GatewayOpCode.GATEWAY_OP_EVENT, eventBytes);

      const messages = useMessageStore.getState().byChannel.c1;
      expect(messages).toHaveLength(1);
      expect(messages?.[0].id).toBe('m1');
    });

    it('dispatches messageUpdate to the message store', async () => {
      // Seed a message first
      useMessageStore
        .getState()
        .setMessages('c1', [
          { id: 'm1', channelId: 'c1', authorId: 'u1' } as never,
        ]);

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'messageUpdate',
          value: { id: 'm1', channelId: 'c1', authorId: 'u1-updated' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      const messages = useMessageStore.getState().byChannel.c1;
      expect(messages).toHaveLength(1);
      expect(messages?.[0].authorId).toBe('u1-updated');
    });

    it('dispatches messageDelete to the message store', async () => {
      useMessageStore
        .getState()
        .setMessages('c1', [
          { id: 'm1', channelId: 'c1', authorId: 'u1' } as never,
        ]);

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'messageDelete',
          value: { channelId: 'c1', messageId: 'm1' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useMessageStore.getState().byChannel.c1).toHaveLength(0);
    });

    it('dispatches typingStart to the typing store (for other users)', async () => {
      // Set the current user so we can verify it ignores own typing
      useAuthStore.setState({ user: ME_USER });

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'typingStart',
          value: { channelId: 'c1', userId: 'other-user' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      const typing = useTypingStore.getState().byChannel.c1;
      expect(typing).toBeDefined();
      expect(typing?.['other-user']).toBeDefined();
    });

    it('ignores typingStart from the current user', async () => {
      useAuthStore.setState({ user: ME_USER });

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'typingStart',
          value: { channelId: 'c1', userId: 'me' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useTypingStore.getState().byChannel.c1).toBeUndefined();
    });

    it('dispatches channelCreate to the channel store', async () => {
      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'channelCreate',
          value: {
            id: 'ch1',
            serverId: 's1',
            name: 'general',
            position: 0,
          } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      const channels = useChannelStore.getState().byServer.s1;
      expect(channels).toHaveLength(1);
      expect(channels?.[0].id).toBe('ch1');
    });

    it('dispatches channelUpdate to the channel store', async () => {
      useChannelStore.getState().addChannel({
        id: 'ch1',
        serverId: 's1',
        name: 'general',
        position: 0,
      } as never);

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'channelUpdate',
          value: {
            id: 'ch1',
            serverId: 's1',
            name: 'updated',
            position: 0,
          } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      const channels = useChannelStore.getState().byServer.s1;
      expect(channels?.[0].name).toBe('updated');
    });

    it('dispatches channelDelete to the channel store', async () => {
      useChannelStore.getState().addChannel({
        id: 'ch1',
        serverId: 's1',
        name: 'general',
        position: 0,
      } as never);

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'channelDelete',
          value: { channelId: 'ch1', serverId: 's1' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      const channels = useChannelStore.getState().byServer.s1;
      expect(channels).toHaveLength(0);
    });

    it('dispatches memberJoin to the member store', async () => {
      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'memberJoin',
          value: {
            userId: 'u1',
            serverId: 's1',
            roleIds: [],
            nickname: '',
          } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useMemberStore.getState().byServer.s1).toHaveLength(1);
      expect(useMemberStore.getState().byServer.s1?.[0].userId).toBe('u1');
    });

    it('dispatches memberUpdate to the member store', async () => {
      useMemberStore
        .getState()
        .setMembers('s1', [
          { userId: 'u1', serverId: 's1', roleIds: [], nickname: '' } as never,
        ]);

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'memberUpdate',
          value: {
            userId: 'u1',
            serverId: 's1',
            roleIds: ['r1'],
            nickname: 'Updated',
          } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useMemberStore.getState().byServer.s1?.[0].nickname).toBe(
        'Updated',
      );
    });

    it('dispatches memberRemove to the member store', async () => {
      useMemberStore
        .getState()
        .setMembers('s1', [
          { userId: 'u1', serverId: 's1' } as never,
          { userId: 'u2', serverId: 's1' } as never,
        ]);

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'memberRemove',
          value: { serverId: 's1', userId: 'u1' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useMemberStore.getState().byServer.s1).toHaveLength(1);
      expect(useMemberStore.getState().byServer.s1?.[0].userId).toBe('u2');
    });

    it('memberRemove cleans up server state when current user is removed', async () => {
      useAuthStore.setState({ user: ME_USER });
      useServerStore
        .getState()
        .addServer({ id: 's1', name: 'Test', ownerId: 'other' } as never);
      useChannelStore.getState().addChannel({
        id: 'ch1',
        serverId: 's1',
        name: 'gen',
        position: 0,
      } as never);
      useRoleStore.getState().setRoles('s1', [
        {
          id: 'r1',
          serverId: 's1',
          name: 'Admin',
          position: 10,
          permissions: 0n,
          color: 0,
        } as never,
      ]);

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'memberRemove',
          value: { serverId: 's1', userId: 'me' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useServerStore.getState().servers).toEqual({});
      expect(useChannelStore.getState().byServer.s1).toBeUndefined();
      expect(useRoleStore.getState().byServer.s1).toBeUndefined();
    });

    it('dispatches roleCreate to the role store', async () => {
      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'roleCreate',
          value: {
            id: 'r1',
            serverId: 's1',
            name: 'Mod',
            position: 5,
            permissions: 0n,
            color: 0,
          } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useRoleStore.getState().byServer.s1).toHaveLength(1);
      expect(useRoleStore.getState().byServer.s1?.[0].name).toBe('Mod');
    });

    it('dispatches roleUpdate to the role store', async () => {
      useRoleStore.getState().setRoles('s1', [
        {
          id: 'r1',
          serverId: 's1',
          name: 'Mod',
          position: 5,
          permissions: 0n,
          color: 0,
        } as never,
      ]);

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'roleUpdate',
          value: {
            id: 'r1',
            serverId: 's1',
            name: 'Super Mod',
            position: 10,
            permissions: 0n,
            color: 0,
          } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useRoleStore.getState().byServer.s1?.[0].name).toBe('Super Mod');
    });

    it('dispatches roleDelete and strips role from members', async () => {
      useRoleStore.getState().setRoles('s1', [
        {
          id: 'r1',
          serverId: 's1',
          name: 'Mod',
          position: 5,
          permissions: 0n,
          color: 0,
        } as never,
        {
          id: 'r2',
          serverId: 's1',
          name: 'Admin',
          position: 10,
          permissions: 0n,
          color: 0,
        } as never,
      ]);
      useMemberStore.getState().setMembers('s1', [
        {
          userId: 'u1',
          serverId: 's1',
          roleIds: ['r1', 'r2'],
          nickname: '',
        } as never,
      ]);

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'roleDelete',
          value: { serverId: 's1', roleId: 'r1' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useRoleStore.getState().byServer.s1).toHaveLength(1);
      expect(useMemberStore.getState().byServer.s1?.[0].roleIds).toEqual([
        'r2',
      ]);
    });

    it('dispatches pinAdd to the pin store', async () => {
      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'pinAdd',
          value: {
            message: { id: 'm1', channelId: 'c1' },
            pinnedAt: {},
          } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(usePinStore.getState().byChannel.c1).toHaveLength(1);
    });

    it('dispatches pinRemove to the pin store', async () => {
      usePinStore
        .getState()
        .setPinnedMessages(
          'c1',
          [{ message: { id: 'm1', channelId: 'c1' }, pinnedAt: {} } as never],
          false,
        );

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'pinRemove',
          value: { channelId: 'c1', messageId: 'm1' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(usePinStore.getState().byChannel.c1).toHaveLength(0);
    });

    it('dispatches reactionAdd to the reaction store', async () => {
      useAuthStore.setState({ user: ME_USER });

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'reactionAdd',
          value: { messageId: 'm1', emoji: 'fire', userId: 'other' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      const groups = useReactionStore.getState().byMessage.m1;
      expect(groups).toHaveLength(1);
      expect(groups?.[0].emoji).toBe('fire');
      expect(groups?.[0].userIds).toContain('other');
      expect(groups?.[0].me).toBe(false);
    });

    it('dispatches reactionAdd with me=true when userId matches current user', async () => {
      useAuthStore.setState({ user: ME_USER });

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'reactionAdd',
          value: { messageId: 'm1', emoji: 'heart', userId: 'me' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      const groups = useReactionStore.getState().byMessage.m1;
      expect(groups).toHaveLength(1);
      expect(groups?.[0].me).toBe(true);
    });

    it('dispatches reactionRemove to the reaction store', async () => {
      useAuthStore.setState({ user: ME_USER });

      // Seed a reaction first
      useReactionStore.getState().addReaction('m1', 'fire', 'other', false);

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'reactionRemove',
          value: { messageId: 'm1', emoji: 'fire', userId: 'other' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      const groups = useReactionStore.getState().byMessage.m1;
      // The group should be removed entirely since it had only one user
      expect(groups).toHaveLength(0);
    });

    it('dispatches emojiCreate to the emoji store', async () => {
      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'emojiCreate',
          value: {
            id: 'e1',
            serverId: 's1',
            name: 'fire',
            imageUrl: '/media/1',
          } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useEmojiStore.getState().byServer.s1).toHaveLength(1);
    });

    it('dispatches emojiUpdate to the emoji store', async () => {
      useEmojiStore.getState().setEmojis('s1', [
        {
          id: 'e1',
          serverId: 's1',
          name: 'fire',
          imageUrl: '/media/1',
        } as never,
      ]);

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'emojiUpdate',
          value: {
            id: 'e1',
            serverId: 's1',
            name: 'blaze',
            imageUrl: '/media/1',
          } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useEmojiStore.getState().byServer.s1?.[0].name).toBe('blaze');
    });

    it('dispatches emojiDelete to the emoji store', async () => {
      useEmojiStore.getState().setEmojis('s1', [
        {
          id: 'e1',
          serverId: 's1',
          name: 'fire',
          imageUrl: '/media/1',
        } as never,
      ]);

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'emojiDelete',
          value: { serverId: 's1', emojiId: 'e1' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useEmojiStore.getState().byServer.s1).toHaveLength(0);
    });

    it('dispatches soundCreate to the sound store', async () => {
      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'soundCreate',
          value: {
            id: 'snd1',
            serverId: 's1',
            name: 'airhorn',
            audioUrl: '/media/a',
          } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useSoundStore.getState().byServer.s1).toHaveLength(1);
    });

    it('dispatches soundUpdate to the sound store', async () => {
      useSoundStore.getState().setServerSounds('s1', [
        {
          id: 'snd1',
          serverId: 's1',
          name: 'airhorn',
          audioUrl: '/media/a',
        } as never,
      ]);

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'soundUpdate',
          value: {
            id: 'snd1',
            serverId: 's1',
            name: 'horn',
            audioUrl: '/media/a',
          } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useSoundStore.getState().byServer.s1?.[0].name).toBe('horn');
    });

    it('dispatches soundDelete to the sound store', async () => {
      useSoundStore.getState().setServerSounds('s1', [
        {
          id: 'snd1',
          serverId: 's1',
          name: 'airhorn',
          audioUrl: '/media/a',
        } as never,
      ]);

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'soundDelete',
          value: { soundId: 'snd1', serverId: 's1' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useSoundStore.getState().byServer.s1).toHaveLength(0);
    });

    it('channelMemberAdd re-fetches channels for current user', async () => {
      useAuthStore.setState({ user: ME_USER });

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'channelMemberAdd',
          value: { channelId: 'ch1', userId: 'me', serverId: 's1' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(mockListChannels).toHaveBeenCalledWith('s1');
    });

    it('channelMemberRemove re-fetches channels for current user', async () => {
      useAuthStore.setState({ user: ME_USER });

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'channelMemberRemove',
          value: { channelId: 'ch1', userId: 'me', serverId: 's1' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(mockListChannels).toHaveBeenCalledWith('s1');
    });

    it('channelDelete disconnects voice if active channel', async () => {
      useVoiceStore.getState().setConnecting('ch1', 'Voice');
      useVoiceStore.getState().setConnected('wss://lk', 'token', false);

      const sock = await connectAndOpen();

      const event = create(EventSchema, {
        payload: {
          case: 'channelDelete',
          value: { channelId: 'ch1', serverId: 's1' } as never,
        },
      });
      deliverEnvelope(
        sock,
        GatewayOpCode.GATEWAY_OP_EVENT,
        toBinary(EventSchema, event),
      );

      expect(useVoiceStore.getState().status).toBe('idle');
      expect(useVoiceStore.getState().channelId).toBeNull();
    });

    it('handles READY and HEARTBEAT_ACK without errors', async () => {
      const sock = await connectAndOpen();

      // These ops should be silently handled (no-op)
      expect(() => {
        deliverEnvelope(sock, GatewayOpCode.GATEWAY_OP_READY);
        deliverEnvelope(sock, GatewayOpCode.GATEWAY_OP_HEARTBEAT_ACK);
      }).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Reconnection backoff
  // -----------------------------------------------------------------------
  describe('reconnection', () => {
    it('schedules a reconnect with exponential backoff on close', async () => {
      useAuthStore.setState({ accessToken: 'tok' });

      const sock = await connectAndOpen();

      // First close -> reconnect scheduled at 1000ms delay
      sock.onclose?.();
      const countAfterClose1 = sockets.length;

      vi.advanceTimersByTime(999);
      expect(sockets.length).toBe(countAfterClose1); // not yet

      vi.advanceTimersByTime(1);
      expect(sockets.length).toBeGreaterThan(countAfterClose1); // reconnected

      // The reconnected socket was created by connect(), which first
      // called disconnect(). Do NOT open it, so reconnectDelay is not
      // reset. Trigger onclose on the new socket -> delay doubles to 2000ms.
      const sock2 = latestSocket();
      sock2.onclose?.();
      const countAfterClose2 = sockets.length;

      vi.advanceTimersByTime(1999);
      expect(sockets.length).toBe(countAfterClose2); // not yet

      vi.advanceTimersByTime(1);
      expect(sockets.length).toBeGreaterThan(countAfterClose2); // reconnected at 2s
    });

    it('gives up after 10 reconnect attempts', async () => {
      useAuthStore.setState({ accessToken: 'tok' });

      let sock = await connectAndOpen();

      // Simulate 10 close events (each one reconnects).
      // Each reconnect calls connect() internally, which calls disconnect()
      // first (incrementing generation). The onopen resets reconnectAttempts,
      // but we do NOT open the reconnected sockets here, so reconnectAttempts
      // keeps incrementing.
      for (let i = 0; i < 10; i++) {
        sock.onclose?.();
        vi.advanceTimersByTime(60_000); // large enough to exceed any backoff
        sock = latestSocket();
        // Do NOT open: simulates the reconnected socket failing to connect.
        // The reconnect callback calls connect() which resets ws, so the
        // onclose from the *previous* socket is stale. Instead, trigger
        // onclose on the new socket to simulate another failure.
      }

      const countBeforeFinal = sockets.length;
      // The 11th close should NOT trigger a reconnect (attempts >= 10)
      sock.onclose?.();
      vi.advanceTimersByTime(60_000);
      expect(sockets.length).toBe(countBeforeFinal);
    });

    it('does not reconnect if no token is available', async () => {
      // No token in store
      useAuthStore.setState({ accessToken: null });

      const sock = await connectAndOpen();

      sock.onclose?.();
      const countAfterClose = sockets.length;
      vi.advanceTimersByTime(5000);
      // No new socket should be created since there is no fresh token
      expect(sockets.length).toBe(countAfterClose);
    });

    it('caps reconnect delay at 30 seconds', async () => {
      useAuthStore.setState({ accessToken: 'tok' });

      let sock = await connectAndOpen();

      // Drive through enough close/reconnect cycles WITHOUT opening the
      // reconnected sockets so that reconnectDelay doubles each time.
      // Backoff sequence: 1s, 2s, 4s, 8s, 16s -> next would be 32s capped to 30s
      for (let i = 0; i < 5; i++) {
        sock.onclose?.();
        vi.advanceTimersByTime(60_000);
        sock = latestSocket();
        // Do NOT open -- keeps reconnectDelay accumulating
      }

      // After 5 reconnect cycles the delay is min(32000, 30000) = 30000
      sock.onclose?.();
      const countBefore = sockets.length;

      // At 29.999s it should NOT have reconnected yet
      vi.advanceTimersByTime(29_999);
      expect(sockets.length).toBe(countBefore);

      // At 30s it should reconnect
      vi.advanceTimersByTime(1);
      expect(sockets.length).toBeGreaterThan(countBefore);
    });
  });

  // -----------------------------------------------------------------------
  // Disconnect cleanup
  // -----------------------------------------------------------------------
  describe('disconnect', () => {
    it('closes the socket and nullifies it', async () => {
      const { disconnect } = await import('./gateway.ts');
      const sock = await connectAndOpen();

      disconnect();
      expect(sock.close).toHaveBeenCalled();
    });

    it('clears the heartbeat timer', async () => {
      const { disconnect } = await import('./gateway.ts');
      const sock = await connectAndOpen();
      sock.send.mockClear();

      disconnect();

      // Even after 60s no heartbeat should be sent
      vi.advanceTimersByTime(60_000);
      expect(sock.send).not.toHaveBeenCalled();
    });

    it('clears a pending reconnect timer', async () => {
      const { disconnect } = await import('./gateway.ts');
      useAuthStore.setState({ accessToken: 'tok' });

      const sock = await connectAndOpen();

      // Trigger close to start reconnect timer
      sock.onclose?.();
      const countAfterClose = sockets.length;

      // Disconnect before the reconnect fires
      disconnect();
      vi.advanceTimersByTime(60_000);

      // No reconnect should have happened
      expect(sockets.length).toBe(countAfterClose);
    });

    it('ignores stale socket events after disconnect (generation guard)', async () => {
      const { connect, disconnect } = await import('./gateway.ts');
      connect('tok');
      const stale = latestSocket();

      disconnect();

      // Simulate the stale socket firing events after disconnect
      stale.readyState = 1;
      expect(() => {
        stale.onopen?.({});
        stale.onclose?.();
      }).not.toThrow();

      // Nothing should have been sent or scheduled
      expect(stale.send).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // sendTyping
  // -----------------------------------------------------------------------
  describe('sendTyping', () => {
    it('sends a TYPING_START envelope', async () => {
      const { sendTyping } = await import('./gateway.ts');
      useAuthStore.setState({ user: ME_USER });

      const sock = await connectAndOpen();
      sock.send.mockClear();

      // Use a unique channel id to avoid cross-test throttle contamination
      const ch = `typing-send-${channelSeq}`;
      sendTyping(ch);

      expect(sock.send).toHaveBeenCalledTimes(1);
      const env = lastSentEnvelope(sock);
      expect(env?.op).toBe(GatewayOpCode.GATEWAY_OP_TYPING_START);

      // Decode the typing event payload
      // biome-ignore lint/style/noNonNullAssertion: env verified by prior assertion
      const typingEvent = fromBinary(TypingEventSchema, env!.payload);
      expect(typingEvent.channelId).toBe(ch);
      expect(typingEvent.userId).toBe('me');
    });

    it('throttles typing to once every 3 seconds per channel', async () => {
      const { sendTyping } = await import('./gateway.ts');
      useAuthStore.setState({ user: ME_USER });

      const sock = await connectAndOpen();
      sock.send.mockClear();

      // Use a unique channel id
      const ch = `typing-throttle-${channelSeq}`;
      sendTyping(ch);
      sendTyping(ch); // should be throttled
      expect(sock.send).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(3000);
      sendTyping(ch); // should go through now
      expect(sock.send).toHaveBeenCalledTimes(2);
    });

    it('throttles independently per channel', async () => {
      const { sendTyping } = await import('./gateway.ts');
      useAuthStore.setState({ user: ME_USER });

      const sock = await connectAndOpen();
      sock.send.mockClear();

      // Use unique channel ids
      const ch1 = `typing-indep-a-${channelSeq}`;
      const ch2 = `typing-indep-b-${channelSeq}`;
      sendTyping(ch1);
      sendTyping(ch2); // different channel, should NOT be throttled
      expect(sock.send).toHaveBeenCalledTimes(2);
    });
  });
});
