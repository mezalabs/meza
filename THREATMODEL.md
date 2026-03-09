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
