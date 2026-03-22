# Voice and Video Implementation

## Overview

Meza uses LiveKit as its Selective Forwarding Unit (SFU) for voice and video.
LiveKit is open-source (Apache 2.0), written in Go, and built on the Pion WebRTC
stack. Meza does not implement its own WebRTC server — it delegates all media
routing to LiveKit and manages the lifecycle through a thin Voice Service.

---

## Architecture

```
┌──────────┐   ConnectRPC    ┌───────────────┐   LiveKit SDK    ┌──────────────┐
│  Client  │────────────────►│ Voice Service │────────────────►│   LiveKit    │
│  (React) │                 │    (Go)       │                 │   Server     │
│          │◄────────────────│               │                 │   (SFU)      │
│          │  LiveKit token  │               │                 │              │
│          │                 └───────────────┘                 │              │
│          │                                                   │              │
│          │═══════════════ WebRTC (direct) ═══════════════════│              │
│          │   Audio/Video streams (UDP/DTLS-SRTP)             │              │
└──────────┘                                                   └──────────────┘
```

Key point: The Voice Service only handles room lifecycle and token issuance.
Actual media flows directly between clients and LiveKit via WebRTC — it never
passes through Meza services.

---

## Why SFU (Not P2P or MCU)

| Architecture | CPU Cost | Latency | Scalability | Chosen? |
|-------------|----------|---------|-------------|---------|
| P2P (Mesh) | Zero server | Lowest | Max ~4 users | No |
| MCU (Mixing) | Very high (transcoding) | Medium | Good | No |
| **SFU (Forwarding)** | **Low (forwarding only)** | **Low** | **Hundreds per room** | **Yes** |

SFU receives each participant's stream and forwards it to all others without
transcoding. This matches our "lean infrastructure" goal.

---

## Voice Service (Go)

The Voice Service (`cmd/voice/`) manages the lifecycle:

### Join Flow

1. Client calls `JoinVoiceChannel` RPC with channel ID
2. Service checks `CONNECT_VOICE` permission
3. Creates LiveKit room (name = `meza-{channelId}`, max 50 participants, 5min empty timeout)
4. Generates LiveKit access token with permission-based grants
5. Publishes voice join event to NATS
6. Returns LiveKit URL + token to client

### Room Lifecycle

LiveKit sends webhooks for participant join/leave and room finished events. The Voice Service processes these to keep Meza state in sync via NATS.

---

## Client-Side Voice

Voice is implemented using `@livekit/components-react`:

- **VoicePanel** — Main voice UI with `<LiveKitRoom>`, participant list, and controls
- **VoiceConnectionBar** — Persistent status bar for active connections
- **PersistentVoiceConnection** — Maintains state across pane navigation
- **ScreenSharePane** — Dedicated pane for viewing screen shares
- **SoundboardPanel** — Sound effects in voice channels

The voice store (`packages/core/src/store/voice.ts`) tracks connection state, active channel, and LiveKit credentials.

---

## Video / Screen Share

Video uses the same LiveKit infrastructure. Screen share publishes a screen capture track via `localParticipant.setScreenShareEnabled()`. Viewers receive the track as `Track.Source.ScreenShare`.

---

## Simulcast

LiveKit simulcast is enabled by default — each publisher sends multiple quality layers (high, medium, low). The SFU selects which layer to forward based on subscriber bandwidth and window size.

---

## Audio Processing

Three noise cancellation modes are available:

- **Off** — No noise filtering
- **Standard** — Browser-native WebRTC `noiseSuppression` constraint
- **GIGA** — RNNoise WASM (ML-based, `@jitsi/rnnoise-wasm`) via LiveKit `TrackProcessor` + `AudioWorkletNode`

GIGA mode is the default for devices with >= 4 CPU cores and >= 4GB RAM. It processes 480-sample frames (10ms at 48kHz) through a circular buffer in a dedicated AudioWorklet thread. Browser-native `noiseSuppression` is disabled when GIGA is active to avoid double-processing.

Echo cancellation and auto gain control remain browser-native in all modes.

Key files:
- `packages/ui/src/audio/rnnoise-worklet.ts` — AudioWorkletProcessor with circular buffer + RNNoise WASM
- `packages/ui/src/audio/rnnoise-processor.ts` — LiveKit TrackProcessor implementation
- `packages/core/src/store/audioSettings.ts` — `noiseCancellationMode: 'off' | 'standard' | 'giga'`
- `packages/core/src/utils/hardware.ts` — `canRunGiga()` hardware detection

---

## Scaling LiveKit

### Single Node Capacity

- ~500 audio-only participants
- ~200 video participants
- Depends on CPU and bandwidth

### Multi-Node

LiveKit uses Redis for multi-node coordination. Rooms usually fit on one node; cross-node forwarding is handled automatically.

### TURN Server

For clients behind restrictive NATs/firewalls, LiveKit supports TURN relay (UDP 3478, TLS 5349).

---

## Voice E2EE

All voice and video frames are end-to-end encrypted using LiveKit's frame-level encryption (Insertable Streams / Encoded Transforms API). The SFU forwards opaque encrypted frames without being able to decode them.

### Key Derivation

Voice encryption uses a **domain-separated subkey** derived from the channel's AES-256-GCM key via HKDF-SHA256:

```
voiceKey = HKDF-SHA256(channelKey, salt="meza-voice-e2ee-v1", info=channelId)
```

This ensures the same raw key is never used for both text AES-256-GCM encryption and LiveKit frame-level AES-GCM encryption. A compromise of the voice key cannot directly yield the text encryption key.

### Integration

- **Room options**: E2EE config is passed via the `e2ee` key in `RoomOptions` (not `encryption` — the `@livekit/components-react` replacer only handles `"e2ee"` for stable JSON serialization; using `"encryption"` causes an infinite render loop).
- **Activation**: `room.setE2EEEnabled(true)` must be called explicitly after the room is created. The Room constructor only configures the E2EE infrastructure (worker, key provider); the local participant's `encryptionType` stays `NONE` until this call, which tells the worker to actually encrypt frames.
- **Key provider**: `ExternalE2EEKeyProvider` from `livekit-client` with `ratchetWindowSize: 0` (ratchet disabled — no coordination protocol).
- **Worker**: LiveKit's pre-built `livekit-client/e2ee-worker` handles frame encryption/decryption in a dedicated Web Worker. Do not manually terminate the worker — LiveKit's Room manages its lifecycle, and React Strict Mode would otherwise kill a memoized worker that's still in use.
- **Key lifecycle**: Key set on the provider before `setConnected()`, cleared on disconnect, reset on logout.
- **Browser gate**: `isE2EESupported()` blocks unsupported browsers from joining voice.
- **Status tracking**: `ParticipantEncryptionStatusChanged` updates per-participant `isEncrypted` in the voice participants store. A delayed sync polls `participant.isEncrypted` after connection to catch events missed during mount. The server-side participant poll preserves the client-side `isEncrypted` value since the server has no knowledge of LiveKit E2EE state.
- **Enforcement**: Only warns when a previously-encrypted participant loses encryption (not during initial handshake where status starts as `false`).

### Limitations

- No key rotation during active voice sessions (key at join time = key for session).
- No forward secrecy per voice session (derived from the static channel key).
- Stopping screen share may break E2EE (LiveKit issue #973).
- Metadata leakage: room names, participant identities, and track metadata are visible to the LiveKit server (TLS only).

Trade-off: E2EE prevents server-side recording and transcription.

---

## Permissions Matrix

| Permission | Can Join | Can Speak | Can Stream Video | Can Mute Others |
|-----------|---------|-----------|-----------------|----------------|
| CONNECT_VOICE | Yes | No | No | No |
| SPEAK_VOICE | Yes | Yes | No | No |
| STREAM_VIDEO | Yes | Yes | Yes | No |
| MANAGE_CHANNELS | Yes | Yes | Yes | Yes |
| ADMINISTRATOR | Yes | Yes | Yes | Yes |

Permissions are checked in the Voice Service before issuing LiveKit tokens. The token's `VideoGrant` is configured to match the user's permissions (e.g., `CanPublish` requires `SPEAK_VOICE`, `CanPublishSources` for camera/screen requires `STREAM_VIDEO`).
