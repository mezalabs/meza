---
title: "feat: End-to-End Encrypted Voice and Video via LiveKit E2EE"
type: feat
status: active
date: 2026-03-21
---

# End-to-End Encrypted Voice and Video via LiveKit E2EE

## Overview

Extend Meza's universal E2EE to voice and video streams by integrating LiveKit's frame-level encryption. Derive a voice-specific subkey from the existing versioned AES-256-GCM channel key via HKDF, so voice/video encryption is seamless and domain-separated from text encryption.

LiveKit's E2EE uses the **Insertable Streams / Encoded Transforms** Web API to intercept encoded media frames after the codec but before the WebRTC transport, encrypting them with AES-GCM in a dedicated Web Worker. The SFU forwards opaque encrypted frames without modification — no server changes required.

## Problem Statement

Meza encrypts all text messages, files, and reactions end-to-end. However, voice and video streams currently travel through the LiveKit SFU as plaintext DTLS-SRTP. This means LiveKit (or anyone with access to the SFU) could theoretically observe voice/video content. The `VOICEVIDEO.md` doc marks Voice E2EE as **[Planned]** (line 131). This feature closes that gap.

## Threat Model

| Threat Actor | Status | Notes |
|---|---|---|
| Passive SFU observer (content) | **Mitigated** | Frame-level AES-GCM encryption; SFU sees opaque bytes |
| Passive SFU observer (metadata) | **Accepted risk** | SFU sees participant identities, room names, join/leave times, track metadata. Mitigated by TLS. Consider opaque HMAC-based identifiers in a future phase. |
| Active SFU (frame manipulation) | **Partially mitigated** | AES-GCM auth tag detects tampering; SFU can still drop/reorder frames |
| Malicious participant (no E2EE) | **Client-side enforcement** | `isE2EESupported()` gate blocks join; `ParticipantEncryptionStatusChanged` detects and warns/disconnects if a remote participant is unencrypted |
| Removed member still in session | **Accepted** | Key frozen for session duration; `RemoveParticipant` ejects from LiveKit room. Mid-session key rotation is future work. |
| Compromised npm dependency | **Accepted risk** | Pin `livekit-client` to exact version; review E2EE worker source on upgrades |
| Key compromise recovery | **Future work** | No mid-session key rotation; `RotateChannelKey` exists for text but voice has no equivalent yet |

## Proposed Solution

### Architecture

```
Microphone → RNNoise TrackProcessor (pre-encode) → Opus Codec → E2EE Worker (AES-GCM encrypt) → SFU → E2EE Worker (decrypt) → Opus Decode → Playback
```

1. **Key source**: Derive a voice-specific subkey from the existing channel key via HKDF: `voiceKey = HKDF-SHA256(channelKey, salt="meza-voice-e2ee-v1", info=channelId)`. This provides domain separation — a compromise of LiveKit's frame encryption cannot directly yield the text encryption key.
2. **Key provider**: `ExternalE2EEKeyProvider` from `livekit-client` — module-level constant in `PersistentVoiceConnection.tsx`. All participants in a voice channel share the same derived key.
3. **Worker**: LiveKit's pre-built `livekit-client/e2ee-worker` handles frame-level encryption/decryption in a dedicated Web Worker thread.
4. **Integration point**: Pass `encryption: { keyProvider, worker }` via the `options` prop on `<LiveKitRoom>` in `PersistentVoiceConnection.tsx`.
5. **Key lifecycle**: E2EE event listeners added to the existing `VoiceEventHandler` component. Key set before connection, cleared on disconnect, reset on logout.

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Key source | Derive from channel keys via HKDF | Domain separation between text and voice AES-GCM contexts. Prevents cross-context key compromise. One HKDF call (~microseconds). |
| Key format | `setKey(ArrayBuffer)` (HKDF path) | Raw 32-byte derived key. All clients are ours — no cross-SDK compat needed. |
| Rotation model | `setKey()` only, ratchet disabled (`ratchetWindowSize: 0`) | Matches Meza's static channel key model. Auto-ratchet without coordination causes permanent one-sided audio loss. |
| Key rotation during session | Not supported initially | No gateway event for key rotation exists. Key at join time = key for session. |
| Unsupported browsers | Block from joining | Mixed encrypted/unencrypted participants causes silent audio failure. Better to block clearly. |
| Unencrypted participants | Detect and warn/disconnect | `ParticipantEncryptionStatusChanged(false)` triggers warning toast and optional force-disconnect. |
| webAudioMix | Keep enabled, monitor | Needed for per-user volume control. Known AudioContext closure issue (#1655) is not E2EE-specific. |
| Noise cancellation | Compatible | RNNoise TrackProcessor operates pre-encode; E2EE operates post-encode. Different pipeline stages, different threads. |
| Key buffer passing | Defensive copy always | `new Uint8Array(channelKey).buffer` — never share the backing ArrayBuffer with the channel key cache. |

---

## Technical Approach

### Pre-Implementation Verification

Before writing code, verify one thing about LiveKit's E2EE worker:

- [x] **Nonce counter behavior on reconnect**: Read the LiveKit E2EE worker source (`node_modules/livekit-client/dist/livekit-client.e2ee.worker.mjs`) to confirm whether the AES-GCM nonce counter resets on worker restart/reconnection. If it resets while the same key is active, nonce reuse occurs — compromising the key. If counter resets on reconnect, we must rotate the key on reconnect (re-derive from channel key + a session counter).

### Implementation Phases

#### Phase 1: Implementation (Client-Side)

No new files. Modify 2 existing files. No store changes. No server changes.

##### 1.1 E2EE Setup in PersistentVoiceConnection

**File: `client/packages/ui/src/components/voice/PersistentVoiceConnection.tsx`**

Add E2EE worker creation, key provider, and room options at module scope:

```typescript
import {
  ExternalE2EEKeyProvider,
  RoomEvent,
  isE2EESupported,
} from 'livekit-client';

// Module-level key provider — survives channel switches, cleared on logout
const e2eeKeyProvider = new ExternalE2EEKeyProvider({
  ratchetWindowSize: 0, // disabled — no ratchet coordination protocol
  failureTolerance: 10,
});

function createE2EEWorker() {
  return new Worker(
    new URL('livekit-client/e2ee-worker', import.meta.url),
    { type: 'module' },
  );
}

// Reset function — call from session teardown alongside clearChannelKeyCache()
export function resetE2EEKeyProvider() {
  e2eeKeyProvider.setKey(new ArrayBuffer(0));
}
```

If pnpm symlink resolution fails for the worker in dev mode, fallback: add `livekit-client` to `optimizeDeps.exclude` in `client/packages/web/vite.config.ts`, or copy `node_modules/livekit-client/dist/livekit-client.e2ee.worker.mjs` to `public/`.

In the component:

```tsx
function PersistentVoiceConnection({ children }: Props) {
  // ... existing state ...

  // E2EE worker — created once, terminated on unmount
  const e2eeWorker = useMemo(() => createE2EEWorker(), []);
  useEffect(() => () => e2eeWorker.terminate(), [e2eeWorker]);

  const roomOptions: RoomOptions = useMemo(() => ({
    webAudioMix: true,
    encryption: {
      keyProvider: e2eeKeyProvider,
      worker: e2eeWorker,
    },
  }), [e2eeWorker]);

  return (
    <LiveKitRoom
      serverUrl={livekitUrl}
      token={livekitToken}
      options={roomOptions}
      connect={shouldConnect}
      onEncryptionError={handleEncryptionError}
    >
      {/* existing children — VoiceEventHandler, AudioSettingsSync, etc. */}
      {children}
    </LiveKitRoom>
  );
}
```

Add E2EE event listeners to the existing `VoiceEventHandler` component (no new file):

```typescript
// Inside VoiceEventHandler, add to existing useEffect or new useEffect:
useEffect(() => {
  const onStatusChanged = (enabled: boolean, participant: Participant) => {
    if (!enabled) {
      // Warn: "Participant {identity} is not encrypted"
      // Optionally force-disconnect for strict all-encrypted policy
      showToast('warning', `${participant.identity} is not using encryption`);
    }
  };
  room.on(RoomEvent.ParticipantEncryptionStatusChanged, onStatusChanged);
  return () => room.off(RoomEvent.ParticipantEncryptionStatusChanged, onStatusChanged);
}, [room]);

useEffect(() => {
  let errorCount = 0;
  const onError = (error: Error) => {
    errorCount++;
    console.error('[E2EE] Encryption error:', error);
    if (errorCount >= 10) {
      showToast('error', 'Encryption issue — please rejoin the voice channel');
      // Optionally: voiceDisconnect() to force rejoin
    }
  };
  room.on(RoomEvent.EncryptionError, onError);
  return () => room.off(RoomEvent.EncryptionError, onError);
}, [room]);
```

- [x] Add `e2eeKeyProvider` as module-level constant with `ratchetWindowSize: 0`
- [x] Add `createE2EEWorker()` inline function
- [x] Export `resetE2EEKeyProvider()` for session teardown
- [x] Create worker in `useMemo`, terminate in `useEffect` cleanup
- [x] Add `encryption` field to `<LiveKitRoom>` options
- [x] Add `onEncryptionError` handler
- [x] Add E2EE event listeners to `VoiceEventHandler` (encryption status + error)
- [x] On `ParticipantEncryptionStatusChanged(false)` — show warning toast
- [x] On persistent encryption errors (>=10) — show reconnect prompt
- [ ] Verify worker loads correctly in dev mode (Vite) and production build
- [ ] Test in Electron and Capacitor iOS (WKWebView)

##### 1.2 Key Injection and Voice Join

**File: `client/packages/ui/src/hooks/useVoiceConnection.ts`**

Modify `voiceConnect()` to derive and inject the voice key, parallelizing the key fetch with the join RPC:

```typescript
import { isE2EESupported } from 'livekit-client';
import { fetchAndCacheChannelKeys, getChannelKey, getLatestKeyVersion } from '@meza/core/crypto';
import { deriveVoiceKey } from '@meza/core/crypto/primitives';

async function voiceConnect(channelId: string, channelName: string) {
  // 1. Check E2EE support (sync check, no caching needed)
  if (!isE2EESupported()) {
    showToast('error', 'Your browser does not support encrypted voice calls. Please update to Chrome 86+, Firefox 117+, or Safari 15.4+.');
    return;
  }

  // 2. Fetch channel key and join RPC in parallel (independent operations)
  const [_, res] = await Promise.all([
    fetchAndCacheChannelKeys(channelId),
    joinVoiceChannel(channelId),
  ]);

  // 3. Derive voice-specific subkey via HKDF (domain separation)
  const keyVersion = getLatestKeyVersion(channelId);
  const channelKey = await getChannelKey(channelId, keyVersion);
  if (!channelKey) {
    showToast('error', 'Cannot join — encryption key unavailable. Try refreshing.');
    return;
  }

  // 4. HKDF domain separation: derive voice key from channel key
  const voiceKey = await deriveVoiceKey(channelKey, channelId);

  // 5. Set key on provider BEFORE LiveKitRoom connects
  //    Defensive copy — never share ArrayBuffer with channel key cache
  await e2eeKeyProvider.setKey(voiceKey.buffer as ArrayBuffer);

  // 6. Proceed with existing connect flow (setConnected triggers <LiveKitRoom> connect)
  // ... existing logic using res ...
}
```

The `deriveVoiceKey` helper in `primitives.ts`:

```typescript
// client/packages/core/src/crypto/primitives.ts
export async function deriveVoiceKey(
  channelKey: Uint8Array,
  channelId: string,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', channelKey, 'HKDF', false, ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('meza-voice-e2ee-v1'),
      info: new TextEncoder().encode(channelId),
    },
    keyMaterial,
    256,
  );
  return new Uint8Array(derived);
}
```

On voice disconnect, clear the key provider:

```typescript
async function voiceDisconnect() {
  // ... existing disconnect logic ...
  // Clear key material from provider
  await e2eeKeyProvider.setKey(new ArrayBuffer(0));
}
```

On session teardown (logout), call `resetE2EEKeyProvider()` alongside `clearChannelKeyCache()`.

- [x] Add `isE2EESupported()` check at the start of `voiceConnect()` with user-facing error
- [x] Parallelize `fetchAndCacheChannelKeys()` and `joinVoiceChannel()` with `Promise.all()`
- [x] Add `deriveVoiceKey()` helper to `primitives.ts` (HKDF with `salt="meza-voice-e2ee-v1"`, `info=channelId`)
- [x] Call `e2eeKeyProvider.setKey(voiceKey.buffer)` with defensive copy before connection
- [x] Use `await` on `getChannelKey()` (it's async)
- [x] Handle missing key gracefully (toast error, abort join)
- [x] Clear key provider on voice disconnect
- [x] Call `resetE2EEKeyProvider()` on session teardown

##### 1.3 Encryption Status Indicators

**File: `client/packages/ui/src/components/voice/VoicePanel.tsx`**

- [x] Add a lock icon next to each participant in `ParticipantRow` (static — E2EE always enabled when connected)
- [x] Add room-wide "Encrypted" badge in the `VoicePanel` header
- [x] Add encryption status to `VoiceConnectionBar` (the persistent bottom bar)

#### Phase 2: Testing & Validation

##### 2.1 Unit Tests

**File: `client/packages/core/src/crypto/primitives.test.ts`** (extend existing)

- [x] Test `deriveVoiceKey()` produces a 32-byte key different from the input channel key
- [x] Test `deriveVoiceKey()` produces different keys for different channel IDs
- [x] Test `deriveVoiceKey()` produces the same key for the same inputs (deterministic)

**In existing VoiceEventHandler test file:**

- [ ] Test E2EE event listeners are registered on mount and cleaned up on unmount
- [ ] Test `ParticipantEncryptionStatusChanged(false)` triggers warning toast
- [ ] Test `EncryptionError` handler counts errors and shows reconnect prompt after threshold

##### 2.2 Integration Tests

- [ ] Test `voiceConnect()` aborts if `isE2EESupported()` returns false
- [ ] Test `voiceConnect()` aborts if channel key is unavailable
- [ ] Test `voiceConnect()` runs key fetch and join RPC in parallel
- [ ] Test channel switch correctly derives and sets the new channel's voice key
- [ ] Test channel-switch key race: `setKey()` timing relative to old room disconnect
- [ ] Test session teardown: `resetE2EEKeyProvider()` clears stale key material
- [ ] Test mixed encryption state: `ParticipantEncryptionStatusChanged(false)` response behavior

##### 2.3 E2E Tests

**File: `client/e2e/journeys/04-media-voice.spec.ts`**

- [ ] Extend existing voice join test to verify E2EE is enabled after connection
- [ ] Test two participants can hear each other with E2EE enabled
- [ ] Test that encryption status indicators appear in the UI

##### 2.4 Platform Testing

- [ ] Chrome (desktop) — full Insertable Streams support
- [ ] Firefox (desktop) — Encoded Transforms (117+)
- [ ] Safari (desktop) — Encoded Transforms (15.4+)
- [ ] Electron — Chromium engine, should match Chrome
- [ ] Capacitor iOS — WKWebView, test Insertable Streams support
- [ ] Capacitor Android — Chrome WebView, should match Chrome

#### Phase 3: Documentation

- [ ] Update `docs/VOICEVIDEO.md` — replace `[Planned]` with implementation details
- [ ] Update `docs/ENCRYPTION.md` — add Voice E2EE section with: HKDF domain separation, threat model, metadata exposure, key lifecycle
- [ ] Add inline code comments explaining the E2EE pipeline and key lifecycle

---

## Alternative Approaches Considered

### 1. Per-Session Ephemeral Keys

Generate a unique symmetric key per voice session instead of reusing channel keys. Would provide forward secrecy per session.

**Rejected because:** Requires a new key distribution protocol for voice sessions (negotiate ephemeral key among N participants). Meza's existing model is static channel keys — adding a second key management system increases complexity significantly. The threat model (passive adversary with DB access) does not require per-session keys.

### 2. Passphrase-Based Keys via `setKey(string)`

Use a string passphrase (e.g., base64-encoded channel key) instead of raw ArrayBuffer.

**Rejected because:** `setKey(string)` triggers PBKDF2 derivation, adding unnecessary CPU cost on every join. We already have the raw key material — HKDF via `setKey(ArrayBuffer)` is more direct. Cross-SDK compatibility (Swift/Kotlin) is not needed since Capacitor uses the JS SDK.

### 3. Custom Key Provider (Subclass BaseKeyProvider)

Write a custom key provider that integrates directly with the channel-keys module.

**Rejected because:** `ExternalE2EEKeyProvider` with `setKey()` already does what we need. A custom provider adds maintenance burden with no functional benefit.

### 4. Disable webAudioMix When E2EE is Active

Avoid the AudioContext closure issue (#1655) by disabling webAudioMix.

**Rejected because:** webAudioMix is required for per-user volume control (`setVolume()`), which is a core UX feature. The AudioContext issue is not E2EE-specific and affects all webAudioMix users. Better to monitor and fix separately.

### 5. Separate E2EEKeySync Component

Create a new `E2EEKeySync.tsx` component for E2EE event listeners inside `<LiveKitRoom>`.

**Rejected because:** The existing `VoiceEventHandler` already follows the exact same pattern (invisible component that listens to room events). Adding 2 event listeners there is 5-10 lines, not a new file. Reduces new files from 4 to 0.

### 6. Raw Channel Key Reuse (No HKDF Derivation)

Pass the raw channel key directly to LiveKit's `setKey()` without domain separation.

**Rejected because:** Uses the same key bytes for two independent AES-GCM constructions (Meza text + LiveKit frames) with independent nonce generation. While nonce collision risk is astronomically low, a compromise of LiveKit's frame encryption would directly yield the text encryption key. HKDF derivation is one function call and provides clean domain separation.

---

## Acceptance Criteria

### Functional Requirements

- [ ] All voice/video frames are encrypted client-side before reaching the LiveKit SFU
- [ ] Voice key is HKDF-derived from channel key with domain separation (`salt="meza-voice-e2ee-v1"`, `info=channelId`)
- [ ] Voice join is blocked until the channel key is available
- [ ] Participants see a lock icon indicating encrypted status per participant
- [ ] Unsupported browsers are blocked from joining voice with a clear error message
- [ ] Unencrypted remote participants trigger a warning toast
- [ ] Encryption errors surface as non-blocking toasts; persistent errors (>=10) prompt rejoin
- [ ] GIGA noise cancellation (RNNoise) continues to work alongside E2EE
- [ ] Screen sharing works with E2EE enabled
- [ ] Channel switching correctly derives and sets the new channel's voice key
- [ ] Reconnection after network drop preserves E2EE state
- [ ] Key material cleared on voice disconnect and session teardown

### Non-Functional Requirements

- [ ] E2EE encryption/decryption runs in a Web Worker — no main thread jank
- [ ] Voice join latency increase is <500ms (key fetch parallelized with join RPC)
- [ ] Works on Chrome 86+, Firefox 117+, Safari 15.4+, Electron, Capacitor iOS/Android

### Quality Gates

- [ ] Unit tests for `deriveVoiceKey()` and E2EE event handlers in VoiceEventHandler
- [ ] Integration tests for voiceConnect() E2EE flow including parallel fetch, channel switch race, and session teardown
- [ ] E2E test confirming two-participant encrypted voice call
- [ ] Manual platform testing on all 6 targets (Chrome, Firefox, Safari, Electron, iOS, Android)

---

## Files Changed

| File | Change |
|------|--------|
| `client/packages/ui/src/components/voice/PersistentVoiceConnection.tsx` | Add key provider, worker, encryption options, E2EE event listeners in VoiceEventHandler, cleanup |
| `client/packages/ui/src/hooks/useVoiceConnection.ts` | Add E2EE gate, parallel key fetch + join, HKDF voice key derivation, key cleanup on disconnect |
| `client/packages/core/src/crypto/primitives.ts` | Add `deriveVoiceKey()` helper (HKDF-SHA256) |

**No new files.** No store changes. No server changes. No proto changes.

---

## Dependencies & Prerequisites

- **Channel keys already work for voice channels** — voice channels (type=2) use the same key distribution as text channels. Verified: `getChannelKey(channelId)` works for any channel type.
- **LiveKit client SDK v2.17.1** — already installed, includes `ExternalE2EEKeyProvider`, `isE2EESupported()`, and the E2EE worker.
- **No LiveKit server config changes** — the SFU is E2EE-transparent.
- **No proto changes** — `JoinVoiceChannelResponse` already returns everything needed.
- **No Go server changes** — E2EE is entirely client-side.

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Vite worker bundling fails in pnpm monorepo | Medium | Blocks feature | Fallback: copy worker to `public/`. Prototype early. |
| webAudioMix + E2EE causes AudioContext closure | Low | Audio drops | Monitor issue #1655. AudioContext recovery already exists. Can disable webAudioMix as escape hatch. |
| Safari/iOS WKWebView doesn't support E2EE | Medium | No iOS voice encryption | `isE2EESupported()` gate. Document minimum iOS version. |
| Screen share stop breaks E2EE (issue #973) | Medium | Broken audio after screen share | Document as known limitation. Consider serializing stop operations. |
| Key not available at join time (slow server) | Low | Join delay | Key fetch parallelized with join RPC. Channel key usually already cached from viewing. |
| EncryptionError doesn't identify participant (#1722) | Medium | Hard to debug | Log all errors. Show generic toast. Improves when LiveKit fixes upstream. |
| Nonce counter resets on reconnect | Low | Key compromise | Verify worker source pre-implementation. If counter resets, re-derive key with session counter. |

---

## Known Limitations (Phase 1)

1. **No key rotation during active voice sessions** — the key at join time is used for the entire session. Adding mid-session rotation requires a new gateway event (future work).
2. **No forward secrecy per voice session** — derived from the channel key. Acceptable per Meza's threat model.
3. **Stopping screen share may break E2EE** — LiveKit issue #973. Users may need to rejoin voice.
4. **Metadata leakage via LiveKit signaling** — room names (`meza-{channelId}`), participant identities (user IDs), join/leave times, and track metadata are visible to the LiveKit server (TLS only). This exposes the social graph of voice communications. Consider opaque HMAC-based identifiers in a future phase.

---

## Future Considerations

- **Mid-session key rotation** — add a gateway event (`voice.key_rotated`) and subscribe in VoiceEventHandler to re-derive and call `setKey()` with the new version.
- **Opaque LiveKit identifiers** — use `HMAC(serverSecret, userID + roomName)` for participant identity and `HMAC(serverSecret, channelId)` for room name to prevent SFU from mapping to Meza accounts.
- **Per-session ephemeral keys** — derive a session-specific key from the channel key + a shared nonce to add forward secrecy.
- **Encryption verification** — display a safety number or emoji code so participants can verify they share the same key (like Signal).
- **Data channel encryption** — LiveKit E2EE can encrypt data channels too (for future features like in-call text chat).

---

## References & Research

### Internal References

- Voice/video architecture: `docs/VOICEVIDEO.md:129-134` (Voice E2EE planned section)
- E2EE design: `docs/ENCRYPTION.md:120-149` (key wrapping, versioning)
- Channel key management: `client/packages/core/src/crypto/channel-keys.ts:224` (`getChannelKey`)
- Crypto primitives (HKDF): `client/packages/core/src/crypto/primitives.ts`
- PersistentVoiceConnection: `client/packages/ui/src/components/voice/PersistentVoiceConnection.tsx:597` (`<LiveKitRoom>`)
- VoiceEventHandler: `client/packages/ui/src/components/voice/PersistentVoiceConnection.tsx:63`
- Voice connection hook: `client/packages/ui/src/hooks/useVoiceConnection.ts:21` (`voiceConnect`)
- Voice store: `client/packages/core/src/store/voice.ts:10` (state shape)
- Voice participants store: `client/packages/core/src/store/voiceParticipants.ts`
- RNNoise worker pattern: `client/packages/ui/src/audio/rnnoise-processor.ts:19` (worker bundling)
- Vite config: `client/packages/web/vite.config.ts:31` (worker format)
- Voice proto: `proto/meza/v1/voice.proto`
- Voice service (Go): `server/cmd/voice/service.go:218` (token generation)
- Session teardown: `client/packages/core/src/crypto/channel-keys.ts:66` (`clearChannelKeyCache`)

### External References

- [LiveKit E2EE Getting Started](https://docs.livekit.io/transport/encryption/start/)
- [LiveKit E2EE Overview](https://docs.livekit.io/transport/encryption/)
- [ExternalE2EEKeyProvider API](https://docs.livekit.io/reference/client-sdk-js/classes/ExternalE2EEKeyProvider.html)
- [isE2EESupported() API](https://docs.livekit.io/reference/client-sdk-js/functions/isInsertableStreamSupported.html)
- [useIsEncrypted hook](https://docs.livekit.io/reference/components/react/hook/useisencrypted/)
- [LiveKitRoom component](https://docs.livekit.io/reference/components/react/component/livekitroom/)

### Known LiveKit Issues

- [#973: Stopping screen share breaks E2EE](https://github.com/livekit/client-sdk-js/issues/973)
- [#1655: AudioContext closure with webAudioMix](https://github.com/livekit/client-sdk-js/issues/1655)
- [#1722: EncryptionError doesn't expose participant identity](https://github.com/livekit/client-sdk-js/issues/1722)
- [#541: Android crash with E2EE](https://github.com/livekit/client-sdk-android/issues/541)
- [Vite #20859: Worker URL resolution from pre-bundled deps](https://github.com/vitejs/vite/issues/20859)
