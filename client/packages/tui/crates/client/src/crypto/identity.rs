//! Ed25519 keypair management and identity encryption.
//!
//! Byte-compatible with the TypeScript web client (`primitives.ts`, `credentials.ts`).
//! Identity serialization format: [32B secret_key][32B public_key] = 64 bytes.
//! Encrypted storage format: [12B nonce][ciphertext (64B + 16B GCM tag)] = 92 bytes.

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use curve25519_dalek::edwards::CompressedEdwardsY;
use ed25519_dalek::{Signature, SigningKey, VerifyingKey};
use ed25519_dalek::Signer;

use sha2::{Digest, Sha512};
use zeroize::Zeroizing;

/// Generate a new Ed25519 identity keypair using OS randomness.
pub fn generate_keypair() -> (SigningKey, VerifyingKey) {
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    (signing_key, verifying_key)
}

/// Sign a message with an Ed25519 signing key. Returns a 64-byte signature.
pub fn sign(signing_key: &SigningKey, message: &[u8]) -> [u8; 64] {
    signing_key.sign(message).to_bytes()
}

/// Verify an Ed25519 signature using strict RFC 8032 mode (matching TypeScript's zip215: false).
pub fn verify(
    verifying_key: &VerifyingKey,
    message: &[u8],
    signature: &[u8; 64],
) -> Result<(), String> {
    let sig = Signature::from_bytes(signature);
    verifying_key
        .verify_strict(message, &sig)
        .map_err(|e| format!("Signature verification failed: {e}"))
}

/// Convert an Ed25519 signing key to an X25519 static secret.
///
/// Matches `@noble/curves` `toMontgomerySecret`: SHA-512 hash of the secret key,
/// take lower 32 bytes, then clamp.
pub fn ed25519_to_x25519_secret(signing_key: &SigningKey) -> x25519_dalek::StaticSecret {
    let mut hasher = Sha512::new();
    hasher.update(signing_key.to_bytes());
    let hash = hasher.finalize();

    let mut scalar = Zeroizing::new([0u8; 32]);
    scalar.copy_from_slice(&hash[..32]);

    // Clamp per X25519 spec
    scalar[0] &= 248;
    scalar[31] &= 127;
    scalar[31] |= 64;

    x25519_dalek::StaticSecret::from(*scalar)
}

/// Convert an Ed25519 verifying key to an X25519 public key.
///
/// Matches `@noble/curves` `toMontgomery`: Edwards-to-Montgomery conversion.
pub fn ed25519_to_x25519_public(verifying_key: &VerifyingKey) -> x25519_dalek::PublicKey {
    let compressed = CompressedEdwardsY(verifying_key.to_bytes());
    let edwards_point = compressed
        .decompress()
        .expect("VerifyingKey should always decompress to a valid Edwards point");
    let montgomery = edwards_point.to_montgomery();
    x25519_dalek::PublicKey::from(montgomery.to_bytes())
}

/// Encrypt an Ed25519 identity for storage.
///
/// Serializes as [32B secret_key][32B public_key] = 64 bytes, then encrypts
/// with AES-256-GCM. Returns [12B nonce][ciphertext] matching TypeScript's
/// `credentials.ts` format.
pub fn encrypt_identity(signing_key: &SigningKey, master_key: &[u8; 32]) -> Vec<u8> {
    // Serialize: [secret(32)][public(32)]
    let mut plaintext = Zeroizing::new([0u8; 64]);
    plaintext[..32].copy_from_slice(&signing_key.to_bytes());
    plaintext[32..].copy_from_slice(signing_key.verifying_key().as_bytes());

    let cipher = Aes256Gcm::new_from_slice(master_key)
        .expect("AES-256-GCM key length is always 32 bytes");

    // Random 12-byte nonce
    let nonce_bytes: [u8; 12] = rand::random();
    let nonce = Nonce::from(nonce_bytes);

    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_ref())
        .expect("AES-256-GCM encryption should not fail with valid key");

    // Pack: [nonce(12)][ciphertext]
    let mut result = Vec::with_capacity(12 + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);
    result
}

/// Decrypt an Ed25519 identity from encrypted storage.
///
/// Input format: [12B nonce][ciphertext]. Decrypts with AES-256-GCM
/// and reconstructs the SigningKey from the first 32 bytes.
pub fn decrypt_identity(encrypted: &[u8], master_key: &[u8; 32]) -> Result<SigningKey, String> {
    if encrypted.len() < 12 + 64 + 16 {
        return Err(format!(
            "Encrypted identity too short: expected at least 92 bytes, got {}",
            encrypted.len()
        ));
    }

    let nonce = Nonce::from_slice(&encrypted[..12]);
    let ciphertext = &encrypted[12..];

    let cipher = Aes256Gcm::new_from_slice(master_key)
        .map_err(|e| format!("AES-256-GCM key error: {e}"))?;

    let plaintext = Zeroizing::new(
        cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| format!("Identity decryption failed: {e}"))?,
    );

    if plaintext.len() != 64 {
        return Err(format!(
            "Decrypted identity wrong size: expected 64 bytes, got {}",
            plaintext.len()
        ));
    }

    let mut secret_bytes = Zeroizing::new([0u8; 32]);
    secret_bytes.copy_from_slice(&plaintext[..32]);

    let signing_key = SigningKey::from_bytes(&secret_bytes);

    // Verify the public key matches
    let expected_pub = signing_key.verifying_key();
    if expected_pub.as_bytes() != &plaintext[32..64] {
        return Err("Decrypted public key does not match derived public key".to_string());
    }

    Ok(signing_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_and_sign_verify() {
        let (sk, vk) = generate_keypair();
        let message = b"hello meza";
        let sig = sign(&sk, message);
        assert!(verify(&vk, message, &sig).is_ok());
    }

    #[test]
    fn verify_rejects_wrong_message() {
        let (sk, vk) = generate_keypair();
        let sig = sign(&sk, b"original");
        assert!(verify(&vk, b"tampered", &sig).is_err());
    }

    #[test]
    fn encrypt_decrypt_identity_roundtrip() {
        let (sk, _) = generate_keypair();
        let master_key: [u8; 32] = rand::random();

        let encrypted = encrypt_identity(&sk, &master_key);
        assert_eq!(encrypted.len(), 12 + 64 + 16); // nonce + plaintext + GCM tag

        let recovered = decrypt_identity(&encrypted, &master_key).unwrap();
        assert_eq!(recovered.to_bytes(), sk.to_bytes());
        assert_eq!(
            recovered.verifying_key().as_bytes(),
            sk.verifying_key().as_bytes()
        );
    }

    #[test]
    fn decrypt_identity_wrong_key_fails() {
        let (sk, _) = generate_keypair();
        let master_key: [u8; 32] = rand::random();
        let wrong_key: [u8; 32] = rand::random();

        let encrypted = encrypt_identity(&sk, &master_key);
        assert!(decrypt_identity(&encrypted, &wrong_key).is_err());
    }

    #[test]
    fn ed25519_to_x25519_roundtrip() {
        let (sk, vk) = generate_keypair();
        let x_secret = ed25519_to_x25519_secret(&sk);
        let x_public = ed25519_to_x25519_public(&vk);

        // The public key derived from the secret should match the one
        // derived from the verifying key.
        let x_public_from_secret = x25519_dalek::PublicKey::from(&x_secret);
        assert_eq!(x_public.as_bytes(), x_public_from_secret.as_bytes());
    }
}
