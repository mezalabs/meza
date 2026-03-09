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

Meza's threat model assumes a passive adversary - someone who can read the database, not someone who can compromise your device, intercept or impersonate your network traffic, or exploit your browser. Nation states can and do all of these things. Meza has no forward secrecy, no key verification ceremony, and runs in a JavaScript runtime that can't guarantee memory erasure. Signal is purpose built for this threat model. Meza was not.

# Explicit Trust Assumptions

For security researchers and contributors, here are the explicit boundaries of the E2EE model:

## Server trust model
The server is assumed to be an **honest-but-curious passive adversary**. It stores encrypted data faithfully but may attempt to read it. The server is **trusted not to substitute public keys** — there is no key transparency log or out-of-band verification (safety numbers). A fully compromised server that actively substitutes keys could perform a man-in-the-middle attack on key distribution. Key transparency is a planned future addition.

## Forward secrecy
Meza does **not** provide per-message forward secrecy. All messages within a channel key version use the same static AES-256-GCM key. Key rotation creates a new version that excluded members do not receive, but old messages encrypted with prior key versions remain decryptable by anyone who possessed those keys. Forward secrecy is bounded by key rotation events, not individual messages.

## Member removal
When a user is removed from a channel, they lose gateway access and cannot receive new messages. However, they retain any channel keys cached on their device. Key rotation after member removal prevents the removed user from decrypting future messages, but does not retroactively revoke access to messages encrypted before their removal. This is an inherent property of the static channel key model.

## Key derivation layers
The system uses two independent layers of Argon2id. The **client** derives a master key and auth key from the user's password (Argon2id with `p=4, t=2, m=64MB`, 64-byte output, split via HKDF-SHA256). The auth key is sent to the **server**, which treats it as a password and stores an Argon2id hash of it (`p=4, t=3, m=64MB`, 32-byte output). These are separate layers serving different purposes — the client layer protects the master key, the server layer protects against auth key database leaks.

## Memory hygiene
JavaScript's garbage collector manages memory; explicit zeroing via `Uint8Array.fill(0)` is best-effort and does not guarantee the runtime won't retain copies. We do not claim cryptographic memory erasure. The master key is stored in `sessionStorage` (cleared on tab close), not `localStorage`.
