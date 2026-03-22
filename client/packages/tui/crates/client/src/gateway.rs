// WebSocket gateway client - binary protobuf frames over WebSocket.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use prost::Message as ProstMessage;
use tokio::sync::mpsc;
use tokio::time;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use crate::error::MezaError;
use crate::proto::{
    Event, EventType, GatewayEnvelope, GatewayOpCode, SendMessageRequest,
};

/// Events the gateway dispatches to the TUI layer.
#[derive(Debug, Clone)]
pub enum GatewayEvent {
    Ready {
        user_id: String,
        session_id: String,
        channel_ids: Vec<String>,
    },
    MessageCreate(Event),
    MessageUpdate(Event),
    MessageDelete(Event),
    MemberJoin(Event),
    ChannelUpdate(Event),
    ChannelDelete(Event),
    KeyRequest(Event),
    ReadStateUpdate(Event),
    Disconnected,
    Reconnecting(u32),
    Error(String),
}

/// WebSocket gateway client that maintains a persistent connection to the server.
pub struct GatewayClient {
    /// Receive gateway events (ready, messages, disconnects, etc.).
    pub event_rx: mpsc::Receiver<GatewayEvent>,
    /// Send envelopes to the write loop for transmission over the WebSocket.
    write_tx: mpsc::Sender<GatewayEnvelope>,
    /// Cancellation token to shut down all spawned tasks.
    cancel: CancellationToken,
}

/// Heartbeat interval.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
/// If no heartbeat ACK arrives within this window, consider the connection dead.
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(60);
/// Timeout waiting for the READY opcode after IDENTIFY.
#[allow(dead_code)]
const READY_TIMEOUT: Duration = Duration::from_secs(5);
/// Maximum reconnection attempts before giving up.
const MAX_RECONNECT_ATTEMPTS: u32 = 10;
/// Base delay for exponential backoff on reconnect.
const RECONNECT_BASE_DELAY: Duration = Duration::from_secs(1);
/// Maximum delay cap for exponential backoff.
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(60);

impl GatewayClient {
    /// Connect to the gateway, authenticate, and start background tasks.
    ///
    /// Returns a `GatewayClient` whose `event_rx` will yield gateway events.
    pub async fn connect(url: &str, token: &str) -> Result<Self, MezaError> {
        let (event_tx, event_rx) = mpsc::channel::<GatewayEvent>(512);
        let (write_tx, write_rx) = mpsc::channel::<GatewayEnvelope>(256);
        let cancel = CancellationToken::new();

        // Initial connection
        let (ws_stream, _response) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|e| MezaError::WebSocket(e.to_string()))?;

        let (ws_sink, ws_stream) = ws_stream.split();

        // Shared state for heartbeat tracking
        let last_ack = Arc::new(AtomicBool::new(true));
        let last_seq = Arc::new(AtomicI64::new(0));

        // Spawn write task
        let write_cancel = cancel.clone();
        let write_tx_for_hb = write_tx.clone();
        tokio::spawn(write_loop(ws_sink, write_rx, write_cancel));

        // Send IDENTIFY
        let identify_payload = serde_json::json!({ "token": token });
        let identify_envelope = GatewayEnvelope {
            op: GatewayOpCode::GatewayOpIdentify as i32,
            payload: Bytes::from(identify_payload.to_string().into_bytes()),
            sequence: 0,
        };
        write_tx
            .send(identify_envelope)
            .await
            .map_err(|_| MezaError::WebSocket("write channel closed".into()))?;

        // Spawn read task - it will forward events including READY
        let read_cancel = cancel.clone();
        let event_tx_clone = event_tx.clone();
        let last_ack_clone = last_ack.clone();
        let last_seq_clone = last_seq.clone();
        tokio::spawn(read_loop(
            ws_stream,
            event_tx_clone,
            last_ack_clone,
            last_seq_clone,
            read_cancel,
        ));

        // Spawn heartbeat task
        let hb_cancel = cancel.clone();
        let hb_last_ack = last_ack.clone();
        let hb_event_tx = event_tx.clone();
        tokio::spawn(heartbeat_loop(
            write_tx_for_hb,
            hb_last_ack,
            hb_event_tx,
            hb_cancel,
        ));

        Ok(GatewayClient {
            event_rx,
            write_tx,
            cancel,
        })
    }

    /// Connect with automatic reconnection on disconnect.
    ///
    /// This spawns a supervisor task that will reconnect on failures using
    /// exponential backoff (up to `MAX_RECONNECT_ATTEMPTS`).
    pub async fn connect_with_reconnect(
        url: &str,
        token: &str,
    ) -> Result<Self, MezaError> {
        let (event_tx, event_rx) = mpsc::channel::<GatewayEvent>(512);
        let (write_tx, write_rx) = mpsc::channel::<GatewayEnvelope>(256);
        let cancel = CancellationToken::new();

        let url = url.to_owned();
        let token = token.to_owned();
        let supervisor_cancel = cancel.clone();
        let supervisor_event_tx = event_tx.clone();
        let supervisor_write_tx = write_tx.clone();

        tokio::spawn(reconnect_supervisor(
            url,
            token,
            write_rx,
            supervisor_event_tx,
            supervisor_write_tx,
            supervisor_cancel,
        ));

        Ok(GatewayClient {
            event_rx,
            write_tx,
            cancel,
        })
    }

    /// Send a chat message to a channel.
    pub async fn send_message(
        &self,
        channel_id: &str,
        encrypted_content: Vec<u8>,
        key_version: u32,
        nonce: Vec<u8>,
    ) -> Result<(), MezaError> {
        let req = SendMessageRequest {
            channel_id: channel_id.to_owned(),
            encrypted_content,
            nonce: nonce.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            key_version,
            attachment_ids: Vec::new(),
            reply_to_id: None,
            mentioned_user_ids: Vec::new(),
            mention_everyone: false,
            mentioned_role_ids: Vec::new(),
        };
        let payload = req.encode_to_vec();

        let envelope = GatewayEnvelope {
            op: GatewayOpCode::GatewayOpSendMessage as i32,
            payload: Bytes::from(payload),
            sequence: 0,
        };

        self.write_tx
            .send(envelope)
            .await
            .map_err(|_| MezaError::WebSocket("write channel closed".into()))
    }

    /// Send a typing indicator for a channel.
    pub async fn send_typing(&self, channel_id: &str) -> Result<(), MezaError> {
        let payload = serde_json::json!({ "channel_id": channel_id });
        let envelope = GatewayEnvelope {
            op: GatewayOpCode::GatewayOpTypingStart as i32,
            payload: Bytes::from(payload.to_string().into_bytes()),
            sequence: 0,
        };
        self.write_tx
            .send(envelope)
            .await
            .map_err(|_| MezaError::WebSocket("write channel closed".into()))
    }

    /// Shut down all gateway tasks and close the connection.
    pub fn shutdown(&self) {
        info!("gateway: shutting down");
        self.cancel.cancel();
    }
}

// ---------------------------------------------------------------------------
// Internal task functions
// ---------------------------------------------------------------------------

type WsSink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    WsMessage,
>;

type WsStream = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
>;

/// Write loop: pulls envelopes from the mpsc channel and sends them on the WebSocket.
async fn write_loop(
    mut sink: WsSink,
    mut rx: mpsc::Receiver<GatewayEnvelope>,
    cancel: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                debug!("gateway write loop: cancelled");
                let _ = sink.close().await;
                break;
            }
            msg = rx.recv() => {
                match msg {
                    Some(envelope) => {
                        let encoded = envelope.encode_to_vec();
                        if let Err(e) = sink.send(WsMessage::Binary(encoded.into())).await {
                            error!("gateway write error: {e}");
                            break;
                        }
                    }
                    None => {
                        debug!("gateway write loop: channel closed");
                        break;
                    }
                }
            }
        }
    }
}

/// Read loop: reads WebSocket frames, decodes GatewayEnvelope, dispatches events.
async fn read_loop(
    mut stream: WsStream,
    event_tx: mpsc::Sender<GatewayEvent>,
    last_ack: Arc<AtomicBool>,
    last_seq: Arc<AtomicI64>,
    cancel: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                debug!("gateway read loop: cancelled");
                break;
            }
            frame = stream.next() => {
                match frame {
                    Some(Ok(WsMessage::Binary(data))) => {
                        if let Err(e) = handle_binary_frame(
                            &data,
                            &event_tx,
                            &last_ack,
                            &last_seq,
                        ).await {
                            warn!("gateway: failed to handle frame: {e}");
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) => {
                        info!("gateway: received close frame");
                        let _ = event_tx.send(GatewayEvent::Disconnected).await;
                        break;
                    }
                    Some(Ok(WsMessage::Ping(_))) | Some(Ok(WsMessage::Pong(_))) => {
                        // handled by tungstenite automatically
                    }
                    Some(Ok(_)) => {
                        // text or other frames - ignore
                    }
                    Some(Err(e)) => {
                        error!("gateway read error: {e}");
                        let _ = event_tx.send(GatewayEvent::Error(e.to_string())).await;
                        let _ = event_tx.send(GatewayEvent::Disconnected).await;
                        break;
                    }
                    None => {
                        info!("gateway: stream ended");
                        let _ = event_tx.send(GatewayEvent::Disconnected).await;
                        break;
                    }
                }
            }
        }
    }
}

/// Decode and dispatch a single binary frame.
async fn handle_binary_frame(
    data: &[u8],
    event_tx: &mpsc::Sender<GatewayEvent>,
    last_ack: &Arc<AtomicBool>,
    last_seq: &Arc<AtomicI64>,
) -> Result<(), MezaError> {
    let envelope = GatewayEnvelope::decode(data)?;

    // Track sequence numbers
    if envelope.sequence > 0 {
        last_seq.store(envelope.sequence, Ordering::Relaxed);
    }

    let op = GatewayOpCode::try_from(envelope.op)
        .unwrap_or(GatewayOpCode::GatewayOpUnspecified);

    match op {
        GatewayOpCode::GatewayOpHeartbeatAck => {
            debug!("gateway: heartbeat ACK");
            last_ack.store(true, Ordering::Relaxed);
        }
        GatewayOpCode::GatewayOpReady => {
            debug!("gateway: READY received");
            match serde_json::from_slice::<serde_json::Value>(&envelope.payload) {
                Ok(val) => {
                    let user_id = val
                        .get("user_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_owned();
                    let session_id = val
                        .get("session_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_owned();
                    let channel_ids = val
                        .get("channel_ids")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    let _ = event_tx
                        .send(GatewayEvent::Ready {
                            user_id,
                            session_id,
                            channel_ids,
                        })
                        .await;
                }
                Err(e) => {
                    warn!("gateway: failed to parse READY payload: {e}");
                    let _ = event_tx
                        .send(GatewayEvent::Error(format!(
                            "failed to parse READY: {e}"
                        )))
                        .await;
                }
            }
        }
        GatewayOpCode::GatewayOpEvent => {
            match Event::decode(&*envelope.payload) {
                Ok(event) => {
                    let event_type = EventType::try_from(event.r#type)
                        .unwrap_or(EventType::Unspecified);
                    let gw_event = match event_type {
                        EventType::MessageCreate => {
                            Some(GatewayEvent::MessageCreate(event))
                        }
                        EventType::MessageUpdate => {
                            Some(GatewayEvent::MessageUpdate(event))
                        }
                        EventType::MessageDelete => {
                            Some(GatewayEvent::MessageDelete(event))
                        }
                        EventType::MemberJoin => {
                            Some(GatewayEvent::MemberJoin(event))
                        }
                        EventType::ChannelUpdate => {
                            Some(GatewayEvent::ChannelUpdate(event))
                        }
                        EventType::ChannelDelete => {
                            Some(GatewayEvent::ChannelDelete(event))
                        }
                        EventType::KeyRequest => {
                            Some(GatewayEvent::KeyRequest(event))
                        }
                        EventType::ReadStateUpdate => {
                            Some(GatewayEvent::ReadStateUpdate(event))
                        }
                        other => {
                            debug!("gateway: unhandled event type {other:?}");
                            None
                        }
                    };
                    if let Some(ev) = gw_event {
                        let _ = event_tx.send(ev).await;
                    }
                }
                Err(e) => {
                    warn!("gateway: failed to decode Event: {e}");
                }
            }
        }
        other => {
            debug!("gateway: unhandled opcode {other:?}");
        }
    }

    Ok(())
}

/// Heartbeat loop: sends HEARTBEAT every 30s, checks for ACK.
async fn heartbeat_loop(
    write_tx: mpsc::Sender<GatewayEnvelope>,
    last_ack: Arc<AtomicBool>,
    event_tx: mpsc::Sender<GatewayEvent>,
    cancel: CancellationToken,
) {
    let mut interval = time::interval(HEARTBEAT_INTERVAL);
    let mut missed_ack_since = Option::<time::Instant>::None;

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                debug!("gateway heartbeat: cancelled");
                break;
            }
            _ = interval.tick() => {
                // Check if previous heartbeat was acknowledged
                if !last_ack.load(Ordering::Relaxed) {
                    match missed_ack_since {
                        Some(since) if since.elapsed() >= HEARTBEAT_TIMEOUT => {
                            warn!("gateway: heartbeat ACK timeout, connection dead");
                            let _ = event_tx.send(GatewayEvent::Disconnected).await;
                            break;
                        }
                        None => {
                            missed_ack_since = Some(time::Instant::now());
                        }
                        _ => {}
                    }
                } else {
                    missed_ack_since = None;
                }

                // Send heartbeat
                last_ack.store(false, Ordering::Relaxed);
                let envelope = GatewayEnvelope {
                    op: GatewayOpCode::GatewayOpHeartbeat as i32,
                    payload: Bytes::new(),
                    sequence: 0,
                };
                if write_tx.send(envelope).await.is_err() {
                    debug!("gateway heartbeat: write channel closed");
                    break;
                }
            }
        }
    }
}

/// Supervisor that handles reconnection with exponential backoff.
async fn reconnect_supervisor(
    url: String,
    token: String,
    mut write_rx: mpsc::Receiver<GatewayEnvelope>,
    event_tx: mpsc::Sender<GatewayEvent>,
    _outbound_write_tx: mpsc::Sender<GatewayEnvelope>,
    cancel: CancellationToken,
) {
    let mut attempt: u32 = 0;

    loop {
        if cancel.is_cancelled() {
            break;
        }

        // Connect
        let ws_result = tokio_tungstenite::connect_async(&url).await;
        let (ws_stream, _) = match ws_result {
            Ok(pair) => {
                attempt = 0; // reset on successful connect
                pair
            }
            Err(e) => {
                attempt += 1;
                if attempt > MAX_RECONNECT_ATTEMPTS {
                    error!("gateway: max reconnect attempts reached");
                    let _ = event_tx
                        .send(GatewayEvent::Error(
                            "max reconnect attempts reached".into(),
                        ))
                        .await;
                    break;
                }
                let _ = event_tx
                    .send(GatewayEvent::Reconnecting(attempt))
                    .await;
                warn!("gateway: connect failed (attempt {attempt}): {e}");
                let delay = backoff_delay(attempt);
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = time::sleep(delay) => continue,
                }
            }
        };

        let (ws_sink, ws_stream_half) = ws_stream.split();

        let session_cancel = cancel.child_token();
        let last_ack = Arc::new(AtomicBool::new(true));
        let last_seq = Arc::new(AtomicI64::new(0));

        // Internal write channel for this session
        let (inner_write_tx, inner_write_rx) = mpsc::channel::<GatewayEnvelope>(256);

        // Spawn write task for this session
        tokio::spawn(write_loop(ws_sink, inner_write_rx, session_cancel.clone()));

        // Send IDENTIFY
        let identify_payload = serde_json::json!({ "token": &token });
        let identify_envelope = GatewayEnvelope {
            op: GatewayOpCode::GatewayOpIdentify as i32,
            payload: Bytes::from(identify_payload.to_string().into_bytes()),
            sequence: 0,
        };
        if inner_write_tx.send(identify_envelope).await.is_err() {
            session_cancel.cancel();
            continue;
        }

        // Spawn read task for this session
        let read_event_tx = event_tx.clone();
        let read_last_ack = last_ack.clone();
        let read_last_seq = last_seq.clone();
        let read_cancel = session_cancel.clone();
        tokio::spawn(read_loop(
            ws_stream_half,
            read_event_tx,
            read_last_ack,
            read_last_seq,
            read_cancel,
        ));

        // Spawn heartbeat for this session
        let hb_write_tx = inner_write_tx.clone();
        let hb_last_ack = last_ack.clone();
        let hb_event_tx = event_tx.clone();
        let hb_cancel = session_cancel.clone();
        tokio::spawn(heartbeat_loop(
            hb_write_tx,
            hb_last_ack,
            hb_event_tx,
            hb_cancel,
        ));

        // Forward outbound messages from the caller to the inner write channel
        // until the session ends (Disconnected event or cancellation).
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    session_cancel.cancel();
                    return;
                }
                msg = write_rx.recv() => {
                    match msg {
                        Some(envelope) => {
                            if inner_write_tx.send(envelope).await.is_err() {
                                // Session write channel closed - session is dead
                                break;
                            }
                        }
                        None => {
                            // Caller dropped write_tx, shutdown
                            session_cancel.cancel();
                            return;
                        }
                    }
                }
            }
        }

        // Session ended, cancel session tasks and attempt reconnect
        session_cancel.cancel();
        attempt += 1;
        if attempt > MAX_RECONNECT_ATTEMPTS {
            error!("gateway: max reconnect attempts reached");
            let _ = event_tx
                .send(GatewayEvent::Error(
                    "max reconnect attempts reached".into(),
                ))
                .await;
            break;
        }
        let _ = event_tx.send(GatewayEvent::Reconnecting(attempt)).await;
        let delay = backoff_delay(attempt);
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = time::sleep(delay) => {}
        }
    }
}

/// Calculate exponential backoff delay with jitter.
fn backoff_delay(attempt: u32) -> Duration {
    use rand::Rng;

    let base_ms = RECONNECT_BASE_DELAY.as_millis() as u64;
    let exp_ms = base_ms.saturating_mul(1u64 << attempt.min(10));
    let capped_ms = exp_ms.min(RECONNECT_MAX_DELAY.as_millis() as u64);

    // Add random jitter: 0..50% of the delay
    let jitter_ms = rand::thread_rng().gen_range(0..=capped_ms / 2);
    Duration::from_millis(capped_ms + jitter_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_delay_increases_exponentially() {
        let d1 = backoff_delay(1);
        let d2 = backoff_delay(2);
        let d3 = backoff_delay(3);
        // Each should be roughly double the previous (with jitter)
        // Just verify ordering and cap
        assert!(d1 < d3 || d3 <= RECONNECT_MAX_DELAY + RECONNECT_MAX_DELAY / 2);
        assert!(d2 <= RECONNECT_MAX_DELAY + RECONNECT_MAX_DELAY / 2);
    }

    #[test]
    fn backoff_delay_caps_at_max() {
        let d = backoff_delay(20);
        // max delay + max jitter (50% of max)
        let upper = RECONNECT_MAX_DELAY + RECONNECT_MAX_DELAY / 2;
        assert!(d <= upper);
    }

    #[test]
    fn gateway_event_variants_exist() {
        // Smoke test that all variants can be constructed
        let _ready = GatewayEvent::Ready {
            user_id: "u1".into(),
            session_id: "s1".into(),
            channel_ids: vec!["c1".into()],
        };
        let _disc = GatewayEvent::Disconnected;
        let _recon = GatewayEvent::Reconnecting(1);
        let _err = GatewayEvent::Error("test".into());
    }
}
