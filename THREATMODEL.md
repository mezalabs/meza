# What does Meza protect you from?

**Anyone who can access the server for __any__ reason, cannot read your messages.**

That's it. That's the core promise. The key is that "anyone who can access the server" actually covers quite a lot of ground:

- **The platform selling your data**: Traditional chat platforms read your messages. They can profile you, sell your behavioral data, serve targeted ads. Meza is unable to do this — it only stores encrypted ciphertext in the database.
- **AI trained on your conversations**: Large AI companies have trained their models on user content they have plaintext access to. Meza can't feed your messages to an AI because it never sees them.
- **Data Breaches**: when a chat platform gets hacked, the attackers get not just your account information, but often your entire message history in readable form. With meza, a breach only exposes metadata (who is in what channel, when messages were sent, how many reactions a message got) but message content remains encrypted gibberish.
- **Law enforcement / subpoenas**: governments can demand the server hand over messages. The server can comply — and hand over ciphertext it can't decrypt.
- **A curious server operator**: even if you self-host and someone else has root on the server, or you use a federated instance run by someone you only half-trust, there is no way for them to snoop on your messages.

This model has one core theme - the server is untrusted by design. Not because server operators are bad people or we expect them to act maliciously, but because the best way to protect your messages is to make it so **no one** can abuse them, regardless of intent, incentive or legal pressure.

# Okay but what does this all mean

Lets break down some common scenarios:
## "I just wanna chat with my friends and not be the product"
Congratulations! You are an ideal user of meza, and who we built the platform for. Head on over to meza.chat and set up your account, create a server and invite your friends. Meza is created for the community by the community and has no way to sell your data because we never see it.

## "I want to talk about things I don't want screenshot-able by the platform"
Meza is a great fit here too - but for different reasons. Most platform can read your messages and just promise not to. Meza can't. This isn't simply a policy decision, or a statement made by the team. Every message (whether that is in public channels, private channels or DMs) is encrypted on your device before it even gets sent. There are no backdoors, no keys, no "trust & safety" override that can take a look at your conversations.

If your server operator wanted to read your DMs they would need to steal one of your physical devices. At which point you have much larger problems to solve.

## "I want to control where my data lives"
You can host your own meza server. You decide where messages are stored, what the server limits are, and who gets access. Your data lives on your hardware, in your jurisdiction, under your rules.

And because of E2EE, even you (with full access to the server) can't read your users' messages. 

## "I am concerned about nation state actors exfiltrating my messages"
Probably use Signal.

Meza's threat model assumes a passive adversary - someone who can read the database, not someone who can compromise your device, intercept or impersonate your network traffic, or exploit your browser. Nation states can and do all of these things. Meza has no forward secrecy and runs in a JavaScript runtime that can't guarantee memory erasure. While safety numbers allow users to verify identity keys out-of-band, a compromised server could serve modified client code that bypasses verification entirely. Signal is purpose built for this threat model. Meza was not.

# Explicit Trust Assumptions

For security researchers and contributors, here are the explicit boundaries of the E2EE model:

## Server trust model
The server is assumed to be an **honest-but-curious passive adversary**. It stores encrypted data faithfully but may attempt to read it. By default the server is trusted not to substitute public keys, but users can **independently verify** this trust using **safety numbers** — a 60-digit numeric fingerprint derived from both users' Ed25519 identity keys. Users who compare safety numbers (in person or over a trusted channel) gain resistance against an **active adversary** that substitutes keys for man-in-the-middle attacks. Users who do not verify still benefit from the existing passive-adversary protections and the server's first-write-only key registration policy.

## Forward secrecy
Meza does **not** provide per-message forward secrecy. All messages within a channel key version use the same static AES-256-GCM key. Key rotation creates a new version that excluded members do not receive, but old messages encrypted with prior key versions remain decryptable by anyone who possessed those keys. Forward secrecy is bounded by key rotation events, not individual messages.

## Member removal
When a user is removed from a channel, they lose gateway access and cannot receive new messages. However, they retain any channel keys cached on their device. Key rotation after member removal prevents the removed user from decrypting future messages, but does not retroactively revoke access to messages encrypted before their removal. This is an inherent property of the static channel key model.

## Key derivation layers
The system uses two independent layers of Argon2id. The **client** derives a master key and auth key from the user's password (Argon2id with `p=4, t=2, m=64MB`, 64-byte output, split via HKDF-SHA256). The auth key is sent to the **server**, which treats it as a password and stores an Argon2id hash of it (`p=4, t=3, m=64MB`, 32-byte output). These are separate layers serving different purposes — the client layer protects the master key, the server layer protects against auth key database leaks.

## Voice and video media

Voice and video are **not end-to-end encrypted**. Audio and video streams are routed through LiveKit, a Selective Forwarding Unit (SFU). The SFU can observe all media but does not store or record it by default. This is a deliberate trade-off: real-time media E2EE (via LiveKit's built-in Insertable Streams) is a planned future addition, but is not currently implemented.

### Participant visibility

All participants in a voice channel are visible to each other by default. The stream preview feature uses hidden participants that can observe screen share tracks without appearing in the channel's participant list. Hidden participants:

- Cannot publish any tracks (enforced at the token level via `CanPublish: false`)
- Are filtered from `GetVoiceChannelState` API responses (via `GetPermission().GetHidden()`)
- Are filtered from client-side `ParticipantConnected` events (via identity prefix check)
- Use a synthetic identity (`preview:{userId}`) distinct from the user's real identity
- Have 60-second token TTL (auto-disconnect)
- Are only issued when a screen share is actively published in the target room

A hidden participant can subscribe to any track source in the room. The client restricts subscription to ScreenShare tracks only (`autoSubscribe: false` + manual subscribe), but this is a client-side enforcement. A modified client with a valid preview token could subscribe to audio tracks during the 60-second window. The mitigation is that preview tokens are only issued when a screen share is actively published, and the token cannot be renewed without passing the active-screen-share check again.

### Trust model for media

- The **SFU (LiveKit)** is trusted to route media faithfully. It has access to unencrypted media streams.
- **Server membership** is required to obtain any voice or preview token. Non-members cannot access voice channels.
- **Channel permissions** (Connect, Speak, StreamVideo) are enforced at token issuance time. The LiveKit SFU enforces publish restrictions via the token grant.
- **Subscribe restrictions** are not enforceable at the token level — LiveKit does not support `CanSubscribeSources`. All room participants can subscribe to any published track. This is a known limitation.
- **Rate limiting** on preview token requests (1 per 3 seconds, burst of 3) prevents abuse of the preview endpoint.

## Memory hygiene
JavaScript's garbage collector manages memory; explicit zeroing via `Uint8Array.fill(0)` is best-effort and does not guarantee the runtime won't retain copies. We do not claim cryptographic memory erasure. The master key is stored in `localStorage` to persist across page reloads and app restarts (including Capacitor mobile shells). The threat model assumes the device itself is trusted — an attacker with filesystem access can already extract browser storage, IndexedDB, and profile data.
