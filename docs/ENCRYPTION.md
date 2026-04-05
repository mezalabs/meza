# End-to-End Encryption

Meza uses **universal E2EE** with a static channel key model. **All channels** — public, private, and DMs — are encrypted with versioned AES-256-GCM symmetric keys. Keys are distributed using ECIES (ephemeral X25519 DH + HKDF-SHA256 + AES-256-GCM) and messages are signed with Ed25519 for authenticity.

There is no plaintext mode. The `is_private` flag is a UI convenience for default visibility (auto-denies `ViewChannel` on `@everyone`), not an encryption toggle. The server never sees message content for any channel type.

## Design Goal

Users sign up with email and password. They chat. Messages are end-to-end encrypted. They never see the word "key", "recovery phrase", or "verify device" unless they explicitly access recovery settings. The server never sees plaintext message content.

---

## Cryptographic Primitives

| Purpose | Algorithm | Library |
|---------|-----------|---------|
| Password → keys | Argon2id → HKDF-SHA256 | hash-wasm (client), golang.org/x/crypto (server) |
| Identity keypair | Ed25519 (signing) + X25519 (key agreement, derived) | @noble/curves |
| Key bundle encryption | AES-256-GCM | Web Crypto API |
| Channel key wrapping | ECIES: ephemeral X25519 DH + HKDF-SHA256 + AES-256-GCM | @noble/curves + Web Crypto API |
| Message encryption | AES-256-GCM (with channel key) | Web Crypto API |
| Message signing | Ed25519 | @noble/curves |
| Recovery key | PBKDF2-SHA256 (600k iterations) from BIP39 mnemonic | Web Crypto API + @scure/bip39 |
| Random bytes | CSPRNG | crypto.getRandomValues() |

---

## Key Hierarchy

```
User Password
    │
    ▼
Argon2id(password, salt) → 64 bytes
    │
    ▼
HKDF-SHA256 with different info strings
    │
    ├── Master Key (256-bit)                      Auth Key (256-bit)
    │   never leaves client                       sent to server for authentication
    │                                             (server stores Argon2id hash of this)
    ▼
┌───────────────────────────┐
│  Encrypted Identity       │  ← AES-256-GCM(Master Key)
│  (stored in IndexedDB)    │
│                           │
│  Contains:                │
│  ├── Ed25519 secret key (32B)
│  └── Ed25519 public key (32B)
└───────────────────────────┘
    │
    ▼ (decrypted client-side)
Identity Keypair (Ed25519)
    │
    ├── Signs messages (Ed25519)
    ├── Wraps/unwraps channel keys (via X25519 derivation)
    │
    ▼
Channel Keys (AES-256-GCM, versioned per channel)
    │
    └── Encrypt message content (all channels)
```

---

## Key Derivation from Password

1. **Argon2id** stretches the password + salt → 64 bytes (client: `p=4, t=2, m=64MB`; server re-hashes auth key with `p=4, t=3, m=64MB`)
2. **HKDF-SHA256** splits the output into two independent 256-bit keys using different info strings (`meza-master-key`, `meza-auth-key`)

The master key never leaves the client. The auth key is sent to the server, which stores an Argon2id hash of it (not the raw key).

---

## Identity Keypair

Each user has a single Ed25519 identity keypair:

- **Ed25519 secret key** (32 bytes) — signs messages, derives X25519 secret for ECIES
- **Ed25519 public key** (32 bytes) — verifies signatures, derives X25519 public for ECIES

The keypair is generated at registration, encrypted with the master key via AES-256-GCM, and stored in IndexedDB. The public key is also uploaded to the server via `KeyService.RegisterPublicKey` so other users can verify signatures and wrap channel keys.

---

## Channel Key Model

Every channel has a **versioned AES-256-GCM symmetric key**. All users with `ViewChannel` permission share the same key for a given version.

### Key Lifecycle

1. **Channel created** → creator generates a random 256-bit channel key (version 1) and distributes to all members with `ViewChannel`
2. **Key distributed** → key is ECIES-wrapped to each recipient's X25519 public key and uploaded as envelopes
3. **Member joins server** → online member (elected by inviter assignment) distributes keys for all visible channels
4. **Permission change grants `ViewChannel`** → the admin who made the change distributes keys to newly-visible channels
5. **Key cached** → keys are cached in memory and persisted to IndexedDB (blob-encrypted with master key)

Member removal does **not** trigger key rotation. This is intentional — the passive-adversary threat model (DB access only) does not require forward secrecy at member-removal boundaries. Removed members lose gateway access and cannot receive new messages.

### Key Distribution Model

Every key distribution event has an online initiator who already has the key:

| Action | Who wraps | Scale |
|--------|-----------|-------|
| Channel creation (public) | Creator | O(server members with `ViewChannel`) |
| Channel creation (private) | Creator | O(1) — just the creator initially |
| DM creation | Initiator | O(participants) |
| Invite acceptance | Elected online member (inviter) | O(channels the joiner can view) |
| Private channel member add | The adder | O(1) |
| Role change grants `ViewChannel` | The admin | O(affected channels) |

**Fallback:** If a user gains channel access without receiving the key (race condition, missed distribution), they create a new key version via `RotateChannelKey(expectedVersion=currentVersion)` for atomic creation. Other members eventually receive the new version. `MAX_VERSIONS_PER_CHANNEL = 3` bounds local cache growth.

### Lazy Initialization (Existing Public Channels)

Existing public channels created before universal E2EE have no channel keys. The first user to open such a channel creates version 1 via `RotateChannelKey(expectedVersion=0)` for atomic creation. Optimistic concurrency ensures only one creator succeeds; others re-fetch the winner's key. Existing plaintext messages (`key_version = 0`) remain readable alongside new encrypted messages.

### ECIES Key Wrapping

Channel keys are distributed by wrapping them with each recipient's public key using ECIES:

```
Wrap (sender → recipient):
  1. Generate ephemeral X25519 keypair
  2. DH: shared = X25519(ephemeral_secret, recipient_x25519_pub)
     (recipient X25519 pub is derived from their Ed25519 pub)
  3. wrapping_key = HKDF-SHA256(shared, salt=ephemeral_pub||recipient_pub, info="meza-key-wrap-v1")
  4. wrapped = AES-256-GCM(wrapping_key, channel_key, aad=buildKeyWrapAAD(channelId, recipientEdPub))
  5. envelope = version(1) || ephemeral_pub(32) || nonce(12) || wrapped(48) = 93 bytes
     version byte = 0x02

Unwrap (recipient):
  1. Parse envelope: version, ephemeral_pub, nonce, wrapped
  2. Verify version == 0x02
  3. Convert own Ed25519 secret → X25519 secret
  4. DH: shared = X25519(own_x25519_secret, ephemeral_pub)
  5. wrapping_key = HKDF-SHA256(shared, salt=ephemeral_pub||own_x25519_pub, info="meza-key-wrap-v1")
  6. channel_key = AES-256-GCM-decrypt(wrapping_key, wrapped, aad=buildKeyWrapAAD(channelId, ownEdPub))
```

Envelopes are stored server-side via the Key Service. The server only sees opaque 93-byte blobs — it cannot derive the wrapping key without the recipient's private key. The server validates envelope size (exactly 93 bytes) and version byte (`0x02`).

### Key Versioning

Channel keys are versioned for availability, not for forward secrecy. Versioning exists solely to handle the fallback mechanism — when a user creates a new key version because they didn't receive the original via distribution.

`RotateChannelKey` uses optimistic concurrency (expected version check) and retries once on version conflict. Up to 3 key versions are retained per channel in the local cache.

---

## Voice & Video E2EE

Voice and video streams are encrypted at the frame level using LiveKit's Insertable Streams / Encoded Transforms API. The SFU forwards opaque encrypted frames without modification.

### Domain Separation

A **voice-specific subkey** is derived from the channel key to prevent multi-context key reuse:

```
voiceKey = HKDF-SHA256(channelKey, salt="meza-voice-e2ee-v1", info=channelId)
```

This ensures the text encryption key (used directly with Meza's AAD scheme) and the voice encryption key (used by LiveKit's SFrame-style encryption) are cryptographically independent. A compromise of one cannot yield the other.

### Key Lifecycle

1. User joins voice channel → `fetchAndCacheChannelKeys(channelId)` ensures key is available
2. `deriveVoiceKey(channelKey, channelId)` produces the voice subkey via HKDF
3. `ExternalE2EEKeyProvider.setKey(voiceKey)` feeds the key to LiveKit's E2EE worker
4. LiveKit worker encrypts outbound frames and decrypts inbound frames in a dedicated Web Worker
5. On disconnect: `setKey(new ArrayBuffer(0))` clears the key provider
6. On logout: `resetE2EEKeyProvider()` is called alongside `clearChannelKeyCache()`

### Threat Model (Voice-Specific)

| Threat | Status |
|--------|--------|
| Passive SFU content observer | Mitigated (frame-level AES-GCM) |
| Passive SFU metadata observer | Accepted risk (participant IDs, room names, join/leave visible via TLS) |
| Malicious participant without E2EE | Client-side detection (`ParticipantEncryptionStatusChanged`) |
| Removed member still in session | Accepted (key frozen for session; `RemoveParticipant` ejects from room) |

### Configuration

- `ratchetWindowSize: 0` — auto-ratchet disabled (no coordination protocol)
- `failureTolerance: 10` — consecutive decryption failures before the worker gives up
- Browser gate: `isE2EESupported()` blocks unsupported browsers entirely

---

## Message Encryption

Messages use a **sign-then-encrypt** scheme. This is stateless — no ratchet state, no ordering dependencies.

### Encrypt (sender)

```
1. Get channel key + version for this channel
2. Sign content with Ed25519 identity key → signature (64 bytes)
3. Build payload: signature(64) || content
4. Build AAD: buildContextAAD(PURPOSE_MESSAGE, channelId, keyVersion)
5. Encrypt payload with AES-256-GCM using channel key + AAD
6. Send: { key_version, encrypted_content: nonce(12) || ciphertext }
```

### Decrypt (recipient)

```
1. Get channel key by version from cache (or fetch from server)
2. Build AAD: buildContextAAD(PURPOSE_MESSAGE, channelId, keyVersion)
3. Decrypt AES-256-GCM with AAD → payload
4. Split: signature(64) || content
5. Verify Ed25519 signature against sender's public key
6. Return content (or throw on verification failure)
```

### Wire Format

```
Cleartext fields (visible to server):
  - sender_id, channel_id, timestamp, key_version

Encrypted content (opaque to server):
  nonce(12) || AES-256-GCM(channel_key, signature(64) || plaintext_content || auth_tag(16))
```

---

## AAD (Additional Authenticated Data) Specification

All AES-256-GCM encryption of channel messages and key wrapping includes AAD that binds ciphertext to its context. This prevents ciphertext swapping attacks where a compromised server moves encrypted data between channels or key versions.

### Encoding: Fixed-Width Binary

Channel IDs are ULIDs (always 26 ASCII bytes). AAD uses fixed-width encoding with a purpose byte per RFC 5116:

```
AAD = purpose(1) || channelId_utf8(26) || context_field(variable)
```

### Purpose Bytes

| Purpose | Byte | Context Field | Total Size |
|---------|------|---------------|------------|
| Message encryption | `0x01` | `keyVersion_u32be(4)` | 31 bytes |
| ECIES key wrapping | `0x02` | `recipientEdPub(32)` | 59 bytes |
| File key wrapping | `0x03` | `keyVersion_u32be(4)` | 31 bytes |

Purpose bytes prevent cross-context confusion — a message ciphertext cannot be substituted for a file key ciphertext even if the same channel key and version are used.

### AAD Scope

| Call site | AAD | Notes |
|-----------|-----|-------|
| `encryptPayload` / `decryptPayload` | `buildContextAAD(PURPOSE_MESSAGE, channelId, keyVersion)` | Required for all message encryption |
| `wrapChannelKey` / `unwrapChannelKey` | `buildKeyWrapAAD(channelId, recipientEdPub)` | Binds envelope to channel + recipient |
| `wrapFileKey` / `unwrapFileKey` | `buildContextAAD(PURPOSE_FILE_KEY, channelId, keyVersion)` | Binds file key to channel |
| `encryptFile` / `decryptFile` | None | Per-file key provides binding (unique random key) |
| `aesGcmEncrypt` / `aesGcmDecrypt` | None | Local storage only (master key provides binding) |
| Session, recovery, device transfer, invite encryption | None | HKDF domain separation or user-specific keys |

### Test Vectors

```
channelId:  "01HZXK5M8E3J6Q9P2RVTYWN4AB"
keyVersion: 3

Message AAD (31 bytes, hex):
  01 3031485a584b354d384533 4a365139503252565459 574e344142 00000003
  ^  ^                                                      ^
  |  channelId UTF-8 (26 bytes)                              keyVersion BE

File Key AAD (31 bytes, hex):
  03 3031485a584b354d384533 4a365139503252565459 574e344142 00000003
  ^  (same channelId)                                        (same keyVersion)
  purpose=FILE_KEY

Key Wrap AAD (59 bytes, hex):
  02 3031485a584b354d384533 4a365139503252565459 574e344142 000102...1f
  ^  (channelId)                                             recipientEdPub (32 bytes)
  purpose=KEY_WRAP
```

Source: `client/packages/core/src/crypto/aad.ts`

---

## Key Service (Proto)

The Key Service (`proto/meza/v1/keys.proto`) manages public keys and channel key envelopes:

| RPC | Purpose |
|-----|---------|
| `RegisterPublicKey` | Upload Ed25519 signing public key (at registration/login) |
| `GetPublicKeys` | Batch-fetch signing public keys for a set of users |
| `StoreKeyEnvelopes` | Upload ECIES-wrapped channel key envelopes for members |
| `GetKeyEnvelopes` | Retrieve all channel key envelopes for the calling user |
| `RotateChannelKey` | Atomically increment key version + store new envelopes (optimistic concurrency) |
| `ListMembersWithViewChannel` | Paginated list of user IDs + public keys for members with `ViewChannel` on a channel |
| `RequestChannelKeys` | Broadcast a key request so online members can distribute keys to the caller (throttled per user+channel, server channels only) |

The Key Service runs on port 8088. Authorization uses `ViewChannel` permission (not `channel_members` membership) for all envelope operations.

---

## Session Lifecycle

### Bootstrap (login / page reload)

```
1. Derive masterKey from password (or load from localStorage on reload)
2. Decrypt identity keypair from IndexedDB using masterKey
3. Initialize channel key module with identity + masterKey
4. Load cached channel keys from IndexedDB (blob-encrypted with masterKey)
5. Session is ready — messages can be encrypted/decrypted
```

The master key is never stored in plaintext. It is encrypted with a random 32-byte session key using AES-256-GCM. The encrypted blob lives in `localStorage` (persistent); the session wrapping key lives in `sessionStorage` (per-tab, cleared on tab close). This split means an XSS attacker must access both storage mechanisms to recover the master key.

### Cross-tab session sharing

When a new tab opens, `sessionStorage` is empty. The app uses the **BroadcastChannel API** (same-origin) to request the session key from another open tab:

1. New tab opens, finds no session key in `sessionStorage`
2. Sends `session-key-request` on `meza-session-sync` BroadcastChannel
3. An existing tab responds with the session key
4. New tab stores the key in `sessionStorage` and decrypts the master key
5. If no tab responds within 1 second, bootstrap fails and the user must re-login

**Security note:** BroadcastChannel is same-origin, so only scripts running on the app's origin can participate. An XSS attacker on the same origin could request the session key via BroadcastChannel (rather than reading `sessionStorage` directly), which is an equivalent attack vector. The dual-storage split primarily limits the exposure window: when all tabs are closed, `sessionStorage` is wiped, and the session key is not recoverable without re-entering the password.

When the master key wrapping key is rotated (e.g. password change), a `session-key-update` message is broadcast so all tabs update their `sessionStorage`.

### Teardown (logout)

```
1. Broadcast session-teardown to all other tabs (triggers their logout)
2. Flush pending channel key persistence to IndexedDB
3. Clear channel key cache (memory)
4. Clear master key from localStorage + session key from sessionStorage
5. Clear all IndexedDB crypto state (key bundles + channel key cache)
6. Clear identity reference
```

When any tab logs out, it broadcasts a `session-teardown` message. All other tabs tear down their sessions and clear auth state, ensuring logout is synchronized across tabs.

---

## Recovery (BIP39)

Users can generate a 12-word BIP39 recovery phrase as a backup for their identity keypair:

1. **Generate**: 128-bit entropy → 12-word English mnemonic
2. **Derive recovery key**: PBKDF2-SHA256(mnemonic, salt="meza-recovery", 600,000 iterations) → 256-bit key
3. **Encrypt**: AES-256-GCM(recovery_key, serialized_identity) → recovery bundle
4. **Upload**: Server stores `recovery_encrypted_key_bundle` + `recovery_key_bundle_iv` alongside the password-encrypted bundle

To recover:
1. User enters 12-word phrase + new password
2. Derive recovery key from phrase
3. Fetch and decrypt recovery bundle from server
4. Re-encrypt identity with new password-derived master key
5. Upload new bundles

---

## Persistence (IndexedDB)

Crypto state is stored in IndexedDB (`meza-crypto`, version 4):

| Store | Contents |
|-------|----------|
| `key-bundle` | Encrypted Ed25519 identity keypair (AES-256-GCM with master key) |
| `channel-keys` | Encrypted channel key cache blob (AES-256-GCM with master key) |

MLS-era stores (`provider-state`, `mls-groups`) are automatically deleted on upgrade to v4.

---

## What the Server Stores

| Data | Encrypted? | Server Can Read? |
|------|-----------|------------------|
| User email | No | Yes |
| Auth key hash (Argon2id) | Hashed | No (one-way) |
| Salt | No | Yes (needed for client key derivation) |
| Encrypted identity bundle | Yes (AES-256-GCM) | No |
| Recovery bundle | Yes (AES-256-GCM) | No |
| Ed25519 signing public key | No | Yes (needed for key wrapping + verification) |
| Channel key envelopes | ECIES-wrapped | No (needs recipient's private key) |
| Message content | Yes (AES-256-GCM) | No |
| Message metadata | No | Yes (sender, channel, timestamp, key_version) |

---

## Security Properties

### Confidentiality
- Messages are encrypted with AES-256-GCM using a shared channel key
- Channel keys are ECIES-wrapped per-member — only the intended recipient can unwrap
- The server sees only opaque ciphertext and 93-byte ECIES envelopes

### Authenticity
- Every message is Ed25519-signed by the sender before encryption
- Recipients verify the signature against the sender's registered public key
- Strict RFC 8032 / FIPS 186-5 verification mode (`zip215: false`) for non-repudiation

### Forward Secrecy

Meza does **not** provide forward secrecy. All messages within a channel version use the same static key. This is intentional — the threat model assumes a passive adversary (database access only). A removed member retains old keys but cannot receive new messages (gateway routing enforces `ViewChannel`).

### Key Compromise Scenarios
- **Password compromised**: Attacker can decrypt identity bundle → change password to re-encrypt with new master key
- **Server compromised**: Attacker gets encrypted bundles + ECIES envelopes. Cannot decrypt without private keys. This applies to ALL channels including public channels — the server never sees plaintext.
- **Channel key leaked**: All messages under that key version are compromised. Manual key rotation via `RotateChannelKey` can be used to limit exposure.

### Memory Hygiene
- JavaScript's garbage collector manages memory; explicit zeroing via `Uint8Array.fill(0)` is best-effort and does not guarantee the runtime won't retain copies (the GC may have already copied the buffer during compaction). We do not claim cryptographic memory erasure.
- Master key stored in `localStorage` for persistence across reloads and app restarts; cleared on logout via `teardownSession()`
- Non-extractable `CryptoKey` objects used where possible



## Safety Numbers (Key Verification)

Users can verify each other's identity keys out-of-band using **safety numbers** — a 60-digit numeric fingerprint displayed as 12 groups of 5 digits in a 4×3 grid.

### Algorithm

Adapted from Signal's `NumericFingerprintGenerator`:

1. For each user, compute 5200 iterations of SHA-512: iteration 0 hashes `version (2 bytes) || Ed25519 public key (32 bytes) || user ID (UTF-8) || Ed25519 public key (32 bytes)`. Subsequent iterations hash `previous hash (64 bytes) || Ed25519 public key (32 bytes)`.
2. Take the first 30 bytes of the final hash. Encode as 6 groups: each 5-byte chunk read as big-endian uint40, mod 100000, zero-padded to 5 digits.
3. Sort both users' 30-digit fingerprints lexicographically. Concatenate to form the 60-digit safety number.

Both users compute the same number regardless of who is "local" vs "remote".

### What safety numbers protect against

- A compromised server operator replacing `signing_public_key` in the database to MITM key distribution.
- A supply chain attack on the server that silently substitutes keys in `GetPublicKeys` responses.

### What safety numbers do NOT protect against

- A compromised server serving modified client-side JavaScript that bypasses verification.
- Metadata leakage (who talks to whom, when, message counts).

### Verification storage

Verification status is stored **client-only** in IndexedDB (`verification` store in `meza-crypto` database v5). The server never learns who you have verified. Verification is bound to a SHA-256 hash of the public key at verification time — if the key changes, verification is automatically invalidated.

---

Client-side crypto code lives in `client/packages/core/src/crypto/`. Server-side auth hashing in `server/internal/auth/`. Key service proto in `proto/meza/v1/keys.proto`.
