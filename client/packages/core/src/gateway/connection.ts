/**
 * Low-level WebSocket connection lifecycle module.
 *
 * Designed for N independent connections (federation satellites).
 * Each Connection manages its own WebSocket and heartbeat. Reconnect
 * scheduling is left to the caller so it can coordinate gateway-level
 * state (tokens, stores, presence) between attempts.
 */

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'
  | 'reconnecting';

export type Connection = {
  url: string;
  ws: WebSocket | null;
  status: ConnectionStatus;
  generation: number;
  lastHeartbeatAck: number;
  reconnectAttempt: number;
  reconnectDelay: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  token: string;
  deviceId: string;
};

export type ConnectionCallbacks = {
  /** Called when a binary message is received from the WebSocket. */
  onMessage: (conn: Connection, data: Uint8Array) => void;
  /** Called when the connection is opened successfully. */
  onOpen: (conn: Connection) => void;
  /** Called when the connection closes. The caller decides whether to reconnect. */
  onClose: (conn: Connection, reason: string) => void;
  /**
   * Called to send the identify payload on connection open.
   * The connection module does not know the wire format.
   */
  sendIdentify: (conn: Connection) => void;
  /**
   * Called on each heartbeat interval (30s). The caller should send the
   * heartbeat frame via sendOnConnection.
   */
  onHeartbeatTick: (conn: Connection) => void;
};

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_ACK_TIMEOUT_MS = 45_000;
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Create a fresh connection state object (does NOT open the WebSocket).
 */
export function makeConnection(
  url: string,
  token: string,
  deviceId: string,
): Connection {
  return {
    url,
    ws: null,
    status: 'disconnected',
    generation: 0,
    lastHeartbeatAck: 0,
    reconnectAttempt: 0,
    reconnectDelay: RECONNECT_BASE_DELAY_MS,
    reconnectTimer: null,
    heartbeatTimer: null,
    token,
    deviceId,
  };
}

/**
 * Open a WebSocket on the given connection.
 * Increments the generation counter to invalidate stale callbacks.
 */
export function openConnection(
  conn: Connection,
  callbacks: ConnectionCallbacks,
): void {
  const gen = ++conn.generation;
  conn.status = 'connecting';

  const socket = new WebSocket(conn.url);
  socket.binaryType = 'arraybuffer';
  conn.ws = socket;

  socket.onopen = () => {
    if (gen !== conn.generation) return;
    callbacks.sendIdentify(conn);
    conn.lastHeartbeatAck = Date.now();
    startHeartbeat(conn, callbacks);
    conn.reconnectDelay = RECONNECT_BASE_DELAY_MS;
    conn.reconnectAttempt = 0;
    conn.status = 'connected';
    callbacks.onOpen(conn);
  };

  socket.onmessage = (e: MessageEvent) => {
    if (gen !== conn.generation) return;
    const data = new Uint8Array(e.data as ArrayBuffer);
    callbacks.onMessage(conn, data);
  };

  socket.onclose = (e?: CloseEvent) => {
    if (gen !== conn.generation) return;
    stopHeartbeat(conn);
    callbacks.onClose(
      conn,
      e?.reason || `WebSocket closed (code ${e?.code ?? 1006})`,
    );
  };

  socket.onerror = () => {
    // onclose fires after onerror — reconnect handled there
  };
}

/**
 * Close the WebSocket and clean up all timers.
 * Increments generation to invalidate in-flight callbacks.
 */
export function closeConnection(conn: Connection): void {
  conn.generation++;
  stopHeartbeat(conn);
  if (conn.reconnectTimer) {
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
  }
  if (conn.ws) {
    conn.ws.close();
    conn.ws = null;
  }
  conn.lastHeartbeatAck = 0;
  conn.status = 'disconnected';
}

/**
 * Send a binary frame on the connection's WebSocket.
 * No-ops if the socket is not open.
 */
export function sendOnConnection(conn: Connection, data: Uint8Array): void {
  if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
  conn.ws.send(data);
}

/**
 * Check if the connection's heartbeat ACK is stale (timed out).
 */
export function isHeartbeatStale(conn: Connection): boolean {
  return (
    conn.lastHeartbeatAck > 0 &&
    Date.now() - conn.lastHeartbeatAck > HEARTBEAT_ACK_TIMEOUT_MS
  );
}

/**
 * Record a heartbeat ACK received from the server.
 */
export function ackHeartbeat(conn: Connection): void {
  conn.lastHeartbeatAck = Date.now();
}

/**
 * Force-close the WebSocket (e.g., on stale heartbeat detection).
 */
export function forceClose(conn: Connection): void {
  if (conn.ws) {
    conn.ws.close();
  }
}

/**
 * Reset reconnect backoff to base delay.
 */
export function resetReconnectDelay(conn: Connection): void {
  conn.reconnectDelay = RECONNECT_BASE_DELAY_MS;
}

/**
 * Cancel any pending reconnect timer.
 */
export function cancelReconnectTimer(conn: Connection): void {
  if (conn.reconnectTimer) {
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
  }
}

/**
 * Schedule a reconnect with exponential backoff.
 * The onFire callback is called when the timer expires (caller does the
 * actual reconnection, e.g. calling connect() with a fresh token).
 */
export function scheduleReconnectTimer(
  conn: Connection,
  onFire: () => void,
): void {
  conn.reconnectAttempt++;
  conn.status = 'reconnecting';
  if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
  conn.reconnectTimer = setTimeout(onFire, conn.reconnectDelay);
  conn.reconnectDelay = Math.min(
    conn.reconnectDelay * 2,
    RECONNECT_MAX_DELAY_MS,
  );
}

// ---------------------------------------------------------------------------
// Heartbeat (internal)
// ---------------------------------------------------------------------------

function startHeartbeat(conn: Connection, callbacks: ConnectionCallbacks) {
  stopHeartbeat(conn);
  conn.heartbeatTimer = setInterval(() => {
    // If no ACK received for 1.5 heartbeat cycles, force reconnect
    if (isHeartbeatStale(conn)) {
      console.warn('[Connection] Heartbeat ACK timeout, forcing reconnect');
      forceClose(conn);
      return;
    }
    callbacks.onHeartbeatTick(conn);
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(conn: Connection) {
  if (conn.heartbeatTimer) {
    clearInterval(conn.heartbeatTimer);
    conn.heartbeatTimer = null;
  }
}
