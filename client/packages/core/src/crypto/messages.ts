/**
 * Message encryption and decryption for static channel key E2EE.
 *
 * Wire format:
 *   Cleartext: key_version (uint32)
 *   Encrypted payload (AES-256-GCM with channel key):
 *     nonce(12) || ciphertext(signature(64) + content + auth_tag(16))
 *
 * Flow:
 *   Encrypt: sign(content) → encrypt(signature || content) → { keyVersion, data }
 *   Decrypt: decrypt(data) → verify(signature, content) → content
 *
 * Stateless and idempotent — no ratchet state, no process_message.
 */

import { buildContextAAD, PURPOSE_MESSAGE } from './aad.ts';
import { getChannelKey, getLatestKeyVersion } from './channel-keys.ts';
import {
  decryptPayload,
  encryptPayload,
  signMessage,
  verifySignature,
} from './primitives.ts';
import { getIdentity } from './session.ts';

const SIGNATURE_SIZE = 64;

// --- Content format ---

/**
 * Version prefix for the JSON message format.
 * Messages starting with this byte are parsed as JSON.
 * Messages without it are treated as legacy raw UTF-8.
 */
const FORMAT_V1 = 0x01;

export interface AttachmentMeta {
  /** Base64-encoded micro-thumbnail bytes */
  mt: string;
  /** Original filename */
  fn: string;
  /** Original content type (MIME) */
  ct: string;
}

interface ContentJson {
  /** Message text */
  t: string;
  /** Attachment metadata keyed by attachment ID */
  a?: Record<string, AttachmentMeta>;
}

/**
 * Build encrypted content bytes with optional attachment metadata.
 * Always uses the V1 JSON format (0x01 prefix + JSON).
 */
export function buildMessageContent(
  text: string,
  attachments?: Map<
    string,
    { microThumb: Uint8Array; filename: string; contentType: string }
  >,
): Uint8Array {
  const json: ContentJson = { t: text };

  if (attachments && attachments.size > 0) {
    const a: Record<string, AttachmentMeta> = {};
    for (const [id, meta] of attachments) {
      a[id] = {
        mt: uint8ToBase64(meta.microThumb),
        fn: meta.filename,
        ct: meta.contentType,
      };
    }
    json.a = a;
  }

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const result = new Uint8Array(1 + jsonBytes.length);
  result[0] = FORMAT_V1;
  result.set(jsonBytes, 1);
  return result;
}

export interface ParsedMessageContent {
  text: string;
  attachmentMeta?: Record<string, AttachmentMeta>;
}

/**
 * Parse decrypted content bytes.
 * Detects V1 JSON format (0x01 prefix) vs legacy raw UTF-8.
 */
export function parseMessageContent(content: Uint8Array): ParsedMessageContent {
  if (content.length === 0) {
    return { text: '' };
  }

  if (content[0] === FORMAT_V1) {
    const jsonStr = new TextDecoder().decode(content.subarray(1));
    const json = JSON.parse(jsonStr) as ContentJson;
    return {
      text: json.t,
      attachmentMeta: json.a,
    };
  }

  // Legacy: raw UTF-8 text
  return { text: new TextDecoder().decode(content) };
}

/**
 * Safely parse message content bytes to text, with fallback for corrupt V1 data.
 * Use this at render time to avoid raw JSON leaking to the UI.
 */
export function safeParseMessageText(content: Uint8Array): string {
  try {
    return parseMessageContent(content).text;
  } catch {
    return new TextDecoder().decode(content);
  }
}

// --- Base64 helpers ---

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export interface EncryptedMessage {
  keyVersion: number;
  /** nonce(12) || ciphertext(signature(64) + content + auth_tag(16)) */
  data: Uint8Array;
}

/**
 * Encrypt a message for a channel using sign-then-encrypt.
 *
 * 1. Get the current channel key and version
 * 2. Sign the content with the identity Ed25519 key
 * 3. Build payload: signature(64) || content
 * 4. Encrypt with AES-256-GCM using the channel key
 */
export async function encryptMessage(
  channelId: string,
  content: Uint8Array,
): Promise<EncryptedMessage> {
  const identity = getIdentity();
  if (!identity) {
    throw new Error('E2EE session not initialized');
  }

  const keyVersion = getLatestKeyVersion(channelId);
  if (keyVersion === null) {
    throw new Error(`No channel key available for ${channelId}`);
  }

  const channelKey = await getChannelKey(channelId, keyVersion);

  // Sign content
  const signature = signMessage(identity.secretKey, content);

  // Build payload: signature(64) || content
  const payload = new Uint8Array(SIGNATURE_SIZE + content.length);
  payload.set(signature, 0);
  payload.set(content, SIGNATURE_SIZE);

  // Encrypt payload with AAD binding to channel + key version
  const aad = buildContextAAD(PURPOSE_MESSAGE, channelId, keyVersion);
  const data = await encryptPayload(channelKey, payload, aad);

  return { keyVersion, data };
}

/**
 * Decrypt a message from a channel using decrypt-then-verify.
 *
 * 1. Get the channel key by version
 * 2. Decrypt AES-256-GCM to recover payload
 * 3. Split payload into signature(64) and content
 * 4. Verify Ed25519 signature against sender's public key
 */
export async function decryptMessage(
  channelId: string,
  keyVersion: number,
  data: Uint8Array,
  senderPublicKey: Uint8Array,
): Promise<Uint8Array> {
  const channelKey = await getChannelKey(channelId, keyVersion);

  // Decrypt payload with AAD binding
  const aad = buildContextAAD(PURPOSE_MESSAGE, channelId, keyVersion);
  const payload = await decryptPayload(channelKey, data, aad);

  if (payload.length < SIGNATURE_SIZE) {
    throw new Error('Decrypted payload too short');
  }

  // Split: signature(64) || content
  const signature = payload.slice(0, SIGNATURE_SIZE);
  const content = payload.slice(SIGNATURE_SIZE);

  // Verify signature
  if (!verifySignature(senderPublicKey, signature, content)) {
    throw new Error('Message signature verification failed');
  }

  return content;
}
