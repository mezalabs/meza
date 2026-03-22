//! ECIES key wrapping (X25519 + HKDF-SHA256 + AES-256-GCM).
//!
//! Byte-compatible with TypeScript `primitives.ts` wrapChannelKey/unwrapChannelKey.
//!
//! Envelope format (93 bytes):
//!   `version(0x02) || ephemeral_pub(32) || nonce(12) || wrapped_key(48)`
//!   (48 = 32 bytes channel key + 16 bytes GCM auth tag)

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use super::identity::{ed25519_to_x25519_public, ed25519_to_x25519_secret};

/// Envelope version byte (0x02 = AAD-bound ECIES wrapping).
const ENVELOPE_VERSION: u8 = 0x02;

/// HKDF info string — must match TypeScript `primitives.ts:138`.
const KEY_WRAP_INFO: &[u8] = b"meza-key-wrap-v1";

/// Total envelope size.
pub const ENVELOPE_SIZE: usize = 93;

/// Known X25519 low-order points that produce all-zero shared secrets.
/// Hex-encoded, matching TypeScript `primitives.ts:116-122`.
const LOW_ORDER_POINTS: [[u8; 32]; 5] = [
    // All zeros
    [0; 32],
    // Order 1
    {
        let mut p = [0u8; 32];
        p[0] = 1;
        p
    },
    // ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f
    [
        0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0x7f,
    ],
    // e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800
    [
        0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f,
        0xc4, 0x6a, 0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16,
        0x5f, 0x49, 0xb8, 0x00,
    ],
    // 5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157
    [
        0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x55, 0x9c, 0x83,
        0xef, 0x5b, 0x04, 0x44, 0x5c, 0xc4, 0x58, 0x1c, 0x8e, 0x86, 0xd8, 0x22, 0x4e, 0xdd,
        0xd0, 0x9f, 0x11, 0x57,
    ],
];

fn reject_low_order_point(point: &[u8; 32], label: &str) -> Result<(), String> {
    for low in &LOW_ORDER_POINTS {
        if point == low {
            return Err(format!("{label} is a low-order point"));
        }
    }
    Ok(())
}

/// Wrap a channel key for a recipient using ECIES.
///
/// 1. Generate ephemeral X25519 keypair
/// 2. DH with recipient's X25519 public key (derived from Ed25519 pub)
/// 3. HKDF-SHA256(shared, salt=ephemeral_pub||recipient_x25519_pub, info="meza-key-wrap-v1")
/// 4. AES-256-GCM encrypt channel key with AAD
///
/// Returns 93-byte envelope: `[version(1) || ephemeral_pub(32) || nonce(12) || wrapped(48)]`
pub fn wrap_channel_key(
    channel_key: &[u8; 32],
    recipient_ed_pub: &ed25519_dalek::VerifyingKey,
    aad: &[u8],
) -> Result<[u8; ENVELOPE_SIZE], String> {
    // Convert recipient Ed25519 pub to X25519
    let recipient_x25519 = ed25519_to_x25519_public(recipient_ed_pub);
    reject_low_order_point(recipient_x25519.as_bytes(), "recipient X25519 public key")?;

    // Ephemeral X25519 keypair
    let ephemeral_secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
    let ephemeral_public = PublicKey::from(&ephemeral_secret);

    // DH shared secret
    let shared = ephemeral_secret.diffie_hellman(&recipient_x25519);

    // HKDF salt = ephemeral_pub(32) || recipient_x25519_pub(32) = 64 bytes
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(ephemeral_public.as_bytes());
    salt[32..].copy_from_slice(recipient_x25519.as_bytes());

    // Derive wrapping key via HKDF-SHA256
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes());
    let mut wrapping_key = Zeroizing::new([0u8; 32]);
    hkdf.expand(KEY_WRAP_INFO, wrapping_key.as_mut())
        .map_err(|e| format!("HKDF expand error: {e}"))?;

    // AES-256-GCM encrypt channel key with AAD
    let cipher = Aes256Gcm::new_from_slice(wrapping_key.as_ref())
        .map_err(|e| format!("AES key error: {e}"))?;
    let nonce_bytes: [u8; 12] = rand::random();
    let nonce = Nonce::from(nonce_bytes);
    let wrapped = cipher
        .encrypt(&nonce, aes_gcm::aead::Payload { msg: channel_key, aad })
        .map_err(|e| format!("AES-GCM encrypt error: {e}"))?;

    // Pack envelope: [version(1) || ephemeral_pub(32) || nonce(12) || wrapped(48)]
    let mut envelope = [0u8; ENVELOPE_SIZE];
    envelope[0] = ENVELOPE_VERSION;
    envelope[1..33].copy_from_slice(ephemeral_public.as_bytes());
    envelope[33..45].copy_from_slice(&nonce_bytes);
    envelope[45..].copy_from_slice(&wrapped);

    Ok(envelope)
}

/// Unwrap a channel key from an ECIES envelope.
///
/// Uses the recipient's Ed25519 signing key to derive the X25519 secret,
/// then reverses the ECIES wrapping.
pub fn unwrap_channel_key(
    envelope: &[u8],
    signing_key: &ed25519_dalek::SigningKey,
    aad: &[u8],
) -> Result<Zeroizing<[u8; 32]>, String> {
    if envelope.len() != ENVELOPE_SIZE {
        return Err(format!(
            "Invalid envelope size: expected {ENVELOPE_SIZE}, got {}",
            envelope.len()
        ));
    }
    if envelope[0] != ENVELOPE_VERSION {
        return Err(format!(
            "Invalid envelope version: expected 0x{ENVELOPE_VERSION:02x}, got 0x{:02x}",
            envelope[0]
        ));
    }

    // Parse envelope
    let ephemeral_pub_bytes: [u8; 32] = envelope[1..33]
        .try_into()
        .map_err(|_| "Failed to parse ephemeral pub")?;
    let nonce_bytes: [u8; 12] = envelope[33..45]
        .try_into()
        .map_err(|_| "Failed to parse nonce")?;
    let wrapped = &envelope[45..];

    reject_low_order_point(&ephemeral_pub_bytes, "ephemeral X25519 public key")?;

    let ephemeral_pub = PublicKey::from(ephemeral_pub_bytes);

    // Convert own Ed25519 to X25519
    let my_x25519_secret = ed25519_to_x25519_secret(signing_key);
    let my_x25519_pub = PublicKey::from(&my_x25519_secret);

    // DH shared secret
    let shared = my_x25519_secret.diffie_hellman(&ephemeral_pub);

    // HKDF salt = ephemeral_pub(32) || recipient_x25519_pub(32)
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(ephemeral_pub.as_bytes());
    salt[32..].copy_from_slice(my_x25519_pub.as_bytes());

    // Derive wrapping key
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes());
    let mut wrapping_key = Zeroizing::new([0u8; 32]);
    hkdf.expand(KEY_WRAP_INFO, wrapping_key.as_mut())
        .map_err(|e| format!("HKDF expand error: {e}"))?;

    // AES-256-GCM decrypt
    let cipher = Aes256Gcm::new_from_slice(wrapping_key.as_ref())
        .map_err(|e| format!("AES key error: {e}"))?;
    let nonce = Nonce::from(nonce_bytes);
    let channel_key_bytes = cipher
        .decrypt(&nonce, aes_gcm::aead::Payload { msg: wrapped, aad })
        .map_err(|e| format!("AES-GCM decrypt error (key unwrap): {e}"))?;

    if channel_key_bytes.len() != 32 {
        return Err(format!(
            "Unwrapped key wrong size: expected 32, got {}",
            channel_key_bytes.len()
        ));
    }

    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&channel_key_bytes);
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::aad::build_key_wrap_aad;
    use crate::crypto::identity::generate_keypair;

    #[test]
    fn wrap_unwrap_roundtrip() {
        let (recipient_sk, recipient_vk) = generate_keypair();
        let channel_key: [u8; 32] = rand::random();
        let channel_id = "01HQJK5M6N7P8R9S0TABCDEFGH";
        let aad = build_key_wrap_aad(channel_id, recipient_vk.as_bytes().try_into().unwrap()).unwrap();

        let envelope = wrap_channel_key(&channel_key, &recipient_vk, &aad).unwrap();
        assert_eq!(envelope.len(), ENVELOPE_SIZE);
        assert_eq!(envelope[0], ENVELOPE_VERSION);

        let unwrapped = unwrap_channel_key(&envelope, &recipient_sk, &aad).unwrap();
        assert_eq!(unwrapped.as_ref(), &channel_key);
    }

    #[test]
    fn unwrap_wrong_key_fails() {
        let (_, recipient_vk) = generate_keypair();
        let (wrong_sk, _) = generate_keypair();
        let channel_key: [u8; 32] = rand::random();
        let channel_id = "01HQJK5M6N7P8R9S0TABCDEFGH";
        let aad = build_key_wrap_aad(channel_id, recipient_vk.as_bytes().try_into().unwrap()).unwrap();

        let envelope = wrap_channel_key(&channel_key, &recipient_vk, &aad).unwrap();
        assert!(unwrap_channel_key(&envelope, &wrong_sk, &aad).is_err());
    }

    #[test]
    fn rejects_low_order_point() {
        // All-zeros public key should be rejected
        let result = reject_low_order_point(&[0u8; 32], "test");
        assert!(result.is_err());
    }
}
