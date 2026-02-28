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

For the open-source path, browser-native WebRTC audio processing is used:
- Echo cancellation
- Noise suppression
- Auto gain control

LiveKit also supports Krisp integration for enhanced noise suppression (client-side).

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

> **[Planned]** Voice E2EE is not yet implemented.

LiveKit supports frame-level encryption via Insertable Streams API. The SFU forwards encrypted frames without being able to decode them. Trade-off: prevents server-side recording and transcription.

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
