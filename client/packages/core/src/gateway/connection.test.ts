import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionCallbacks } from './connection.ts';
import {
  ackHeartbeat,
  cancelReconnectTimer,
  closeConnection,
  forceClose,
  HEARTBEAT_ACK_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  isHeartbeatStale,
  makeConnection,
  openConnection,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  resetReconnectDelay,
  scheduleReconnectTimer,
  sendOnConnection,
} from './connection.ts';

// ---------------------------------------------------------------------------
// Minimal mock WebSocket
// ---------------------------------------------------------------------------
type MockWebSocket = {
  url: string;
  binaryType: string;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: (() => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

let sockets: MockWebSocket[] = [];

function latestSocket(): MockWebSocket {
  // biome-ignore lint/style/noNonNullAssertion: test helper
  return sockets[sockets.length - 1]!;
}

function createMockWebSocketClass() {
  const WS = function (this: MockWebSocket, url: string) {
    this.url = url;
    this.binaryType = '';
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.send = vi.fn();
    this.close = vi.fn(() => {
      this.readyState = 3;
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

function openSocket(sock: MockWebSocket) {
  sock.readyState = 1;
  sock.onopen?.({});
}

function makeCallbacks(
  overrides: Partial<ConnectionCallbacks> = {},
): ConnectionCallbacks {
  return {
    onMessage: vi.fn(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    sendIdentify: vi.fn(),
    onHeartbeatTick: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  vi.stubGlobal('WebSocket', createMockWebSocketClass());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================= TESTS =====================================

describe('connection module', () => {
  // -----------------------------------------------------------------------
  // makeConnection
  // -----------------------------------------------------------------------
  describe('makeConnection', () => {
    it('creates a connection with initial state', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', 'device-1');
      expect(conn.url).toBe('wss://example.com/ws');
      expect(conn.token).toBe('tok');
      expect(conn.deviceId).toBe('device-1');
      expect(conn.ws).toBeNull();
      expect(conn.status).toBe('disconnected');
      expect(conn.generation).toBe(0);
      expect(conn.lastHeartbeatAck).toBe(0);
      expect(conn.reconnectAttempt).toBe(0);
      expect(conn.reconnectDelay).toBe(RECONNECT_BASE_DELAY_MS);
      expect(conn.reconnectTimer).toBeNull();
      expect(conn.heartbeatTimer).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // openConnection
  // -----------------------------------------------------------------------
  describe('openConnection', () => {
    it('creates a WebSocket and increments generation', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);

      expect(conn.generation).toBe(1);
      expect(conn.status).toBe('connecting');
      expect(conn.ws).not.toBeNull();
      expect(latestSocket().url).toBe('wss://example.com/ws');
      expect(latestSocket().binaryType).toBe('arraybuffer');
    });

    it('calls sendIdentify and onOpen when socket opens', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      const sock = latestSocket();
      openSocket(sock);

      expect(cbs.sendIdentify).toHaveBeenCalledWith(conn);
      expect(cbs.onOpen).toHaveBeenCalledWith(conn);
      expect(conn.status).toBe('connected');
      expect(conn.lastHeartbeatAck).toBeGreaterThan(0);
    });

    it('resets reconnect state on successful open', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      conn.reconnectDelay = 16000;
      conn.reconnectAttempt = 5;
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      openSocket(latestSocket());

      expect(conn.reconnectDelay).toBe(RECONNECT_BASE_DELAY_MS);
      expect(conn.reconnectAttempt).toBe(0);
    });

    it('delivers messages via onMessage callback', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      const sock = latestSocket();
      openSocket(sock);

      const payload = new Uint8Array([1, 2, 3]);
      sock.onmessage?.({ data: payload.buffer as ArrayBuffer });

      expect(cbs.onMessage).toHaveBeenCalledTimes(1);
      const receivedData = (cbs.onMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as Uint8Array;
      expect(receivedData).toEqual(payload);
    });

    it('calls onClose when socket closes', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      const sock = latestSocket();
      openSocket(sock);

      sock.onclose?.({ reason: 'test close', code: 1000 });
      expect(cbs.onClose).toHaveBeenCalledWith(conn, 'test close');
    });

    it('provides default close reason when none given', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      const sock = latestSocket();
      openSocket(sock);

      sock.onclose?.({ reason: '', code: 1006 });
      expect(cbs.onClose).toHaveBeenCalledWith(
        conn,
        'WebSocket closed (code 1006)',
      );
    });
  });

  // -----------------------------------------------------------------------
  // Generation counter (stale callback prevention)
  // -----------------------------------------------------------------------
  describe('generation counter', () => {
    it('ignores stale onopen events after generation change', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      const sock = latestSocket();

      // Increment generation to simulate a new connection being opened
      conn.generation++;

      // Stale onopen should be ignored
      openSocket(sock);
      expect(cbs.sendIdentify).not.toHaveBeenCalled();
      expect(cbs.onOpen).not.toHaveBeenCalled();
    });

    it('ignores stale onmessage events after generation change', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      const sock = latestSocket();
      openSocket(sock);

      conn.generation++;

      sock.onmessage?.({ data: new Uint8Array([1]).buffer as ArrayBuffer });
      expect(cbs.onMessage).not.toHaveBeenCalled();
    });

    it('ignores stale onclose events after generation change', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      const sock = latestSocket();
      openSocket(sock);

      conn.generation++;

      sock.onclose?.();
      expect(cbs.onClose).not.toHaveBeenCalled();
    });

    it('closeConnection increments generation', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      openSocket(latestSocket());

      const genBefore = conn.generation;
      closeConnection(conn);
      expect(conn.generation).toBeGreaterThan(genBefore);
    });

    it('events from closed connection are ignored', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      const sock = latestSocket();
      openSocket(sock);

      closeConnection(conn);

      // Simulate stale events
      sock.readyState = 1;
      expect(() => {
        sock.onopen?.({});
        sock.onmessage?.({
          data: new Uint8Array([1]).buffer as ArrayBuffer,
        });
        sock.onclose?.();
      }).not.toThrow();

      // Only the initial onOpen from openSocket should have been called
      expect(cbs.onOpen).toHaveBeenCalledTimes(1);
      // onMessage should not have been called after close
      expect(cbs.onMessage).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------
  describe('heartbeat', () => {
    it('calls onHeartbeatTick every 30 seconds after open', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      openSocket(latestSocket());

      // First tick at 30s
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(cbs.onHeartbeatTick).toHaveBeenCalledTimes(1);
      expect(cbs.onHeartbeatTick).toHaveBeenCalledWith(conn);

      // Simulate ACK received
      ackHeartbeat(conn);

      // Second tick at 60s
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(cbs.onHeartbeatTick).toHaveBeenCalledTimes(2);
    });

    it('force-closes when heartbeat ACK times out (45s)', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      const sock = latestSocket();
      openSocket(sock);

      // Don't send any ACKs. At 30s, first heartbeat fires (delta=30s < 45s).
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(cbs.onHeartbeatTick).toHaveBeenCalledTimes(1);

      // At 60s, delta=60s > 45s — should force close
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(sock.close).toHaveBeenCalled();
      // onHeartbeatTick should NOT have been called a second time
      expect(cbs.onHeartbeatTick).toHaveBeenCalledTimes(1);
    });

    it('does not time out when ACKs are received', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      const sock = latestSocket();
      openSocket(sock);

      // Simulate receiving ACKs before each heartbeat
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
        ackHeartbeat(conn);
      }

      expect(cbs.onHeartbeatTick).toHaveBeenCalledTimes(5);
      // Socket should still be open (close not called by heartbeat logic)
      // Note: close may be called by other means, but not by heartbeat timeout
    });

    it('stops heartbeat when connection is closed', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      openSocket(latestSocket());

      closeConnection(conn);

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
      expect(cbs.onHeartbeatTick).not.toHaveBeenCalled();
    });

    it('stops heartbeat when socket closes', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      const sock = latestSocket();
      openSocket(sock);

      // Simulate socket close
      sock.onclose?.({ reason: 'gone', code: 1001 });

      // Heartbeat ticks should NOT fire after close
      (cbs.onHeartbeatTick as ReturnType<typeof vi.fn>).mockClear();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
      expect(cbs.onHeartbeatTick).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // isHeartbeatStale / ackHeartbeat
  // -----------------------------------------------------------------------
  describe('heartbeat utilities', () => {
    it('isHeartbeatStale returns false when lastHeartbeatAck is 0', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      expect(isHeartbeatStale(conn)).toBe(false);
    });

    it('isHeartbeatStale returns false within timeout window', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      ackHeartbeat(conn);
      vi.advanceTimersByTime(HEARTBEAT_ACK_TIMEOUT_MS - 1);
      expect(isHeartbeatStale(conn)).toBe(false);
    });

    it('isHeartbeatStale returns true after timeout', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      ackHeartbeat(conn);
      vi.advanceTimersByTime(HEARTBEAT_ACK_TIMEOUT_MS + 1);
      expect(isHeartbeatStale(conn)).toBe(true);
    });

    it('ackHeartbeat resets the stale check', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      ackHeartbeat(conn);
      vi.advanceTimersByTime(HEARTBEAT_ACK_TIMEOUT_MS + 1);
      expect(isHeartbeatStale(conn)).toBe(true);

      ackHeartbeat(conn);
      expect(isHeartbeatStale(conn)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // sendOnConnection
  // -----------------------------------------------------------------------
  describe('sendOnConnection', () => {
    it('sends data when socket is open', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      const sock = latestSocket();
      openSocket(sock);

      const data = new Uint8Array([10, 20, 30]);
      sendOnConnection(conn, data);
      expect(sock.send).toHaveBeenCalledWith(data);
    });

    it('no-ops when socket is null', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      expect(() => sendOnConnection(conn, new Uint8Array([1]))).not.toThrow();
    });

    it('no-ops when socket is not open', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      // Socket is in CONNECTING state (readyState=0), not OPEN

      sendOnConnection(conn, new Uint8Array([1]));
      expect(latestSocket().send).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // closeConnection
  // -----------------------------------------------------------------------
  describe('closeConnection', () => {
    it('closes the WebSocket and clears state', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      const sock = latestSocket();
      openSocket(sock);

      closeConnection(conn);

      expect(sock.close).toHaveBeenCalled();
      expect(conn.ws).toBeNull();
      expect(conn.status).toBe('disconnected');
      expect(conn.lastHeartbeatAck).toBe(0);
    });

    it('clears heartbeat timer', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      openSocket(latestSocket());

      expect(conn.heartbeatTimer).not.toBeNull();
      closeConnection(conn);
      expect(conn.heartbeatTimer).toBeNull();
    });

    it('clears reconnect timer', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const onFire = vi.fn();
      scheduleReconnectTimer(conn, onFire);

      expect(conn.reconnectTimer).not.toBeNull();
      closeConnection(conn);
      expect(conn.reconnectTimer).toBeNull();

      // Timer should not fire after close
      vi.advanceTimersByTime(60_000);
      expect(onFire).not.toHaveBeenCalled();
    });

    it('is safe to call multiple times', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      openSocket(latestSocket());

      closeConnection(conn);
      expect(() => closeConnection(conn)).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // scheduleReconnectTimer
  // -----------------------------------------------------------------------
  describe('scheduleReconnectTimer', () => {
    it('fires the callback after the reconnect delay', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const onFire = vi.fn();
      scheduleReconnectTimer(conn, onFire);

      vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS - 1);
      expect(onFire).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onFire).toHaveBeenCalledTimes(1);
    });

    it('increments reconnectAttempt', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      expect(conn.reconnectAttempt).toBe(0);

      scheduleReconnectTimer(conn, vi.fn());
      expect(conn.reconnectAttempt).toBe(1);

      vi.advanceTimersByTime(60_000);
      scheduleReconnectTimer(conn, vi.fn());
      expect(conn.reconnectAttempt).toBe(2);
    });

    it('sets status to reconnecting', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      scheduleReconnectTimer(conn, vi.fn());
      expect(conn.status).toBe('reconnecting');
    });

    it('uses exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped)', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];

      for (const expectedDelay of expectedDelays) {
        const onFire = vi.fn();
        scheduleReconnectTimer(conn, onFire);

        vi.advanceTimersByTime(expectedDelay - 1);
        expect(onFire).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(onFire).toHaveBeenCalledTimes(1);
      }
    });

    it('caps delay at RECONNECT_MAX_DELAY_MS', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');

      // Drive delay past the cap
      for (let i = 0; i < 10; i++) {
        scheduleReconnectTimer(conn, vi.fn());
        vi.advanceTimersByTime(60_000);
      }

      expect(conn.reconnectDelay).toBe(RECONNECT_MAX_DELAY_MS);
    });

    it('cancels previous timer when called again', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const firstFn = vi.fn();
      const secondFn = vi.fn();

      scheduleReconnectTimer(conn, firstFn);
      scheduleReconnectTimer(conn, secondFn);

      vi.advanceTimersByTime(60_000);
      expect(firstFn).not.toHaveBeenCalled();
      expect(secondFn).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // resetReconnectDelay / cancelReconnectTimer
  // -----------------------------------------------------------------------
  describe('reconnect utilities', () => {
    it('resetReconnectDelay sets delay back to base', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      conn.reconnectDelay = 16000;
      resetReconnectDelay(conn);
      expect(conn.reconnectDelay).toBe(RECONNECT_BASE_DELAY_MS);
    });

    it('cancelReconnectTimer prevents timer from firing', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const onFire = vi.fn();
      scheduleReconnectTimer(conn, onFire);

      cancelReconnectTimer(conn);
      expect(conn.reconnectTimer).toBeNull();

      vi.advanceTimersByTime(60_000);
      expect(onFire).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // forceClose
  // -----------------------------------------------------------------------
  describe('forceClose', () => {
    it('closes the WebSocket without clearing conn.ws', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      const cbs = makeCallbacks();
      openConnection(conn, cbs);
      const sock = latestSocket();
      openSocket(sock);

      forceClose(conn);
      expect(sock.close).toHaveBeenCalled();
      // ws is NOT nulled — onclose handler will fire and handle cleanup
      expect(conn.ws).toBe(sock);
    });

    it('is safe when ws is null', () => {
      const conn = makeConnection('wss://example.com/ws', 'tok', '');
      expect(() => forceClose(conn)).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Multiple connections (federation-ready)
  // -----------------------------------------------------------------------
  describe('multiple connections', () => {
    it('can manage independent connection instances', () => {
      const conn1 = makeConnection('wss://home.com/ws', 'tok1', 'dev1');
      const conn2 = makeConnection('wss://satellite.com/ws', 'tok2', 'dev2');

      const cbs1 = makeCallbacks();
      const cbs2 = makeCallbacks();

      openConnection(conn1, cbs1);
      openConnection(conn2, cbs2);

      expect(sockets).toHaveLength(2);
      expect(sockets[0]?.url).toBe('wss://home.com/ws');
      expect(sockets[1]?.url).toBe('wss://satellite.com/ws');

      // biome-ignore lint/style/noNonNullAssertion: test helper — sockets always exist after openConnection
      openSocket(sockets[0]!);
      // biome-ignore lint/style/noNonNullAssertion: test helper
      openSocket(sockets[1]!);

      expect(cbs1.onOpen).toHaveBeenCalledTimes(1);
      expect(cbs2.onOpen).toHaveBeenCalledTimes(1);

      // Close one without affecting the other
      closeConnection(conn1);
      expect(conn1.status).toBe('disconnected');
      expect(conn2.status).toBe('connected');
    });

    it('independent heartbeat timers per connection', () => {
      const conn1 = makeConnection('wss://a.com/ws', 'tok1', '');
      const conn2 = makeConnection('wss://b.com/ws', 'tok2', '');

      const cbs1 = makeCallbacks();
      const cbs2 = makeCallbacks();

      openConnection(conn1, cbs1);
      openConnection(conn2, cbs2);
      // biome-ignore lint/style/noNonNullAssertion: test helper
      openSocket(sockets[0]!);
      // biome-ignore lint/style/noNonNullAssertion: test helper
      openSocket(sockets[1]!);

      // Both should have independent heartbeat timers
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(cbs1.onHeartbeatTick).toHaveBeenCalledTimes(1);
      expect(cbs2.onHeartbeatTick).toHaveBeenCalledTimes(1);

      // ACK only conn1
      ackHeartbeat(conn1);

      // At 60s, conn2 should timeout but conn1 should send second heartbeat
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(cbs1.onHeartbeatTick).toHaveBeenCalledTimes(2);
      expect(cbs2.onHeartbeatTick).toHaveBeenCalledTimes(1); // timed out, no second tick
    });
  });
});
