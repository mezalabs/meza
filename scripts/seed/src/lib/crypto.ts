/**
 * Crypto utilities for seed user registration.
 *
 * Replicates the exact key derivation from packages/core/src/crypto/keys.ts
 * so that seed users are fully loginable through the normal browser UI.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const HKDF_INFO_MASTER = new TextEncoder().encode('meza-master-key');
const HKDF_INFO_AUTH = new TextEncoder().encode('meza-auth-key');
const HKDF_SALT = new Uint8Array(32); // Zero-salt (input is already high-entropy Argon2id output)

let wasmInitialized = false;

/**
 * Initialize the OpenMLS WASM module for Node.js.
 * Must be called before generateKeyBundle().
 */
export async function initWasm(): Promise<void> {
  if (wasmInitialized) return;

  const mls = await import('openmls-wasm');
  const require = createRequire(import.meta.url);
  const pkgDir = dirname(require.resolve('openmls-wasm/package.json'));
  const wasmPath = resolve(pkgDir, 'openmls_wasm_bg.wasm');
  const wasmBytes = readFileSync(wasmPath);

  mls.initSync({ module: wasmBytes });
  wasmInitialized = true;
}

export interface DerivedKeys {
  masterKey: Uint8Array;
  authKey: Uint8Array;
}

/**
 * Derive master_key and auth_key from password + salt.
 * Matches packages/core/src/crypto/keys.ts exactly.
 */
export async function deriveKeys(
  password: string,
  salt: Uint8Array,
): Promise<DerivedKeys> {
  const { argon2id } = await import('hash-wasm');

  const argonHex = await argon2id({
    password,
    salt,
    parallelism: 4,
    iterations: 2,
    memorySize: 65536,
    hashLength: 64,
    outputType: 'hex',
  });
  const argonOutput = hexToBytes(argonHex);

  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    argonOutput,
    'HKDF',
    false,
    ['deriveBits'],
  );

  const masterBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO_MASTER },
    hkdfKey,
    256,
  );

  const authBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO_AUTH },
    hkdfKey,
    256,
  );

  return {
    masterKey: new Uint8Array(masterBits),
    authKey: new Uint8Array(authBits),
  };
}

/**
 * Generate an MLS Identity key bundle (Ed25519 keypair) and return serialized bytes.
 * Requires initWasm() to have been called first.
 */
export async function generateKeyBundle(credentialName: string): Promise<Uint8Array> {
  const mls = await import('openmls-wasm');
  const provider = new mls.Provider();
  const identity = new mls.Identity(provider, credentialName);
  return identity.to_bytes();
}

/**
 * Encrypt a key bundle with AES-256-GCM using the master key.
 * Matches packages/core/src/crypto/keys.ts encryptKeyBundle().
 */
export async function encryptKeyBundle(
  masterKey: Uint8Array,
  plaintext: Uint8Array,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey(
    'raw',
    masterKey,
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    plaintext,
  );
  return { ciphertext: new Uint8Array(ciphertext), iv };
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

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
