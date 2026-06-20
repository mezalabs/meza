/**
 * Crypto utilities for seed data.
 *
 * Imports key derivation and encryption from packages/core to stay in sync
 * with the client's actual crypto implementation. Only imports from modules
 * that are Node.js-compatible (no browser-only deps).
 */

export { deriveKeys, aesGcmEncrypt } from '@meza/core/crypto/keys.ts';
export {
  generateIdentityKeypair,
  serializeIdentity,
  generateChannelKey,
  wrapChannelKey,
  signMessage,
  encryptPayload,
} from '@meza/core/crypto/primitives.ts';
export {
  generateRecoveryPhrase,
  deriveRecoveryKey,
  deriveRecoveryVerifier,
  encryptRecoveryBundle,
} from '@meza/core/crypto/recovery.ts';
export {
  buildContextAAD,
  buildKeyWrapAAD,
  PURPOSE_MESSAGE,
} from '@meza/core/crypto/aad.ts';

// buildMessageContent is inlined here because messages.ts imports browser-only
// modules (channel-keys.ts → session.ts). The format is simple: 0x01 || JSON({t: text}).
const FORMAT_V1 = 0x01;

export function buildMessageContent(text: string): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify({ t: text }));
  const result = new Uint8Array(1 + jsonBytes.length);
  result[0] = FORMAT_V1;
  result.set(jsonBytes, 1);
  return result;
}

/**
 * Generate a deterministic 16-byte salt from a username.
 * Uses SHA-256 truncated to 16 bytes so the same username always produces
 * the same salt, making seed data reproducible.
 */
export async function deterministicSalt(username: string): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`meza-seed-salt:${username}`),
  );
  return new Uint8Array(hash).slice(0, 16);
}
