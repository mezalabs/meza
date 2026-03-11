/**
 * AAD (Additional Authenticated Data) builders for AES-256-GCM encryption.
 *
 * AAD binds ciphertext to its context (channel, key version, recipient),
 * preventing ciphertext swapping attacks by a compromised server.
 *
 * Encoding is fixed-width binary per RFC 5116 (injective function requirement):
 *   AAD = purpose(1) || channelId_utf8(26) || context_field(variable)
 */

export const PURPOSE_MESSAGE = 0x01 as const;
export const PURPOSE_KEY_WRAP = 0x02 as const;
export const PURPOSE_FILE_KEY = 0x03 as const;

export type AadPurpose = typeof PURPOSE_MESSAGE | typeof PURPOSE_KEY_WRAP | typeof PURPOSE_FILE_KEY;

/** ULIDs are always 26 characters (ASCII bytes). */
const ULID_LENGTH = 26;

const encoder = new TextEncoder();

/**
 * Build AAD for message encryption or file key wrapping.
 *
 * Layout (31 bytes):
 *   purpose(1) || channelId_utf8(26) || keyVersion_u32be(4)
 */
export function buildContextAAD(
  purpose: AadPurpose,
  channelId: string,
  keyVersion: number,
): Uint8Array {
  if (!Number.isInteger(keyVersion) || keyVersion < 0 || keyVersion > 0xFFFFFFFF) {
    throw new Error(`keyVersion must be a uint32, got ${keyVersion}`);
  }
  const encoded = encoder.encode(channelId);
  if (encoded.length !== ULID_LENGTH) {
    throw new Error(`channelId must be ${ULID_LENGTH} bytes, got ${encoded.length}`);
  }
  const aad = new Uint8Array(1 + ULID_LENGTH + 4);
  aad[0] = purpose;
  aad.set(encoded, 1);
  new DataView(aad.buffer, aad.byteOffset, aad.byteLength).setUint32(1 + ULID_LENGTH, keyVersion);
  return aad;
}

/**
 * Build AAD for ECIES channel key wrapping.
 *
 * Layout (59 bytes):
 *   PURPOSE_KEY_WRAP(1) || channelId_utf8(26) || recipientEdPub(32)
 */
export function buildKeyWrapAAD(
  channelId: string,
  recipientEdPub: Uint8Array,
): Uint8Array {
  const encoded = encoder.encode(channelId);
  if (encoded.length !== ULID_LENGTH) {
    throw new Error(`channelId must be ${ULID_LENGTH} bytes, got ${encoded.length}`);
  }
  if (recipientEdPub.length !== 32) {
    throw new Error(`recipientEdPub must be 32 bytes, got ${recipientEdPub.length}`);
  }
  const aad = new Uint8Array(1 + ULID_LENGTH + 32);
  aad[0] = PURPOSE_KEY_WRAP;
  aad.set(encoded, 1);
  aad.set(recipientEdPub, 1 + ULID_LENGTH);
  return aad;
}
