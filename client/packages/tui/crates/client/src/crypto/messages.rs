//! Message sign-then-encrypt / decrypt-then-verify.
//!
//! Wire format:
//!   `nonce(12) || ciphertext(signature(64) + content + auth_tag(16))`
//!
//! Byte-compatible with TypeScript `messages.ts`.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use ed25519_dalek::{SigningKey, VerifyingKey};

use super::aad::build_message_aad;
use super::identity;

const SIGNATURE_SIZE: usize = 64;

/// Content format version prefix (V1 = JSON).
const FORMAT_V1: u8 = 0x01;

/// Maximum decrypted content size (64KB safety limit).
const MAX_CONTENT_SIZE: usize = 65536;

/// Build message content bytes from text (V1 JSON format).
///
/// Format: `0x01 || JSON({"t": text})`
pub fn build_message_content(text: &str) -> Vec<u8> {
    let json = serde_json::json!({ "t": text });
    let json_bytes = json.to_string().into_bytes();
    let mut result = Vec::with_capacity(1 + json_bytes.len());
    result.push(FORMAT_V1);
    result.extend_from_slice(&json_bytes);
    result
}

/// Parsed message content.
pub struct ParsedContent {
    pub text: String,
}

/// Parse decrypted content bytes.
///
/// Detects V1 JSON format (0x01 prefix) vs legacy raw UTF-8.
pub fn parse_message_content(content: &[u8]) -> ParsedContent {
    if content.is_empty() {
        return ParsedContent {
            text: String::new(),
        };
    }

    if content[0] == FORMAT_V1 {
        if let Ok(json_str) = std::str::from_utf8(&content[1..]) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(json_str) {
                if let Some(text) = json.get("t").and_then(|v| v.as_str()) {
                    return ParsedContent {
                        text: text.to_string(),
                    };
                }
            }
        }
        // Fallback: treat as raw
        return ParsedContent {
            text: String::from_utf8_lossy(content).to_string(),
        };
    }

    // Legacy: raw UTF-8
    ParsedContent {
        text: String::from_utf8_lossy(content).to_string(),
    }
}

/// Encrypt a message using sign-then-encrypt.
///
/// 1. Sign content with Ed25519
/// 2. Build payload: `signature(64) || content`
/// 3. Encrypt with AES-256-GCM using channel key + AAD
///
/// Returns `nonce(12) || ciphertext(sig + content + gcm_tag(16))`.
pub fn encrypt_message(
    signing_key: &SigningKey,
    channel_key: &[u8; 32],
    content: &[u8],
    channel_id: &str,
    key_version: u32,
) -> Result<Vec<u8>, String> {
    // Sign content
    let signature = identity::sign(signing_key, content);

    // Build payload: signature(64) || content
    let mut payload = Vec::with_capacity(SIGNATURE_SIZE + content.len());
    payload.extend_from_slice(&signature);
    payload.extend_from_slice(content);

    // Build AAD
    let aad = build_message_aad(channel_id, key_version)?;

    // AES-256-GCM encrypt
    let cipher =
        Aes256Gcm::new_from_slice(channel_key).map_err(|e| format!("AES key error: {e}"))?;
    let nonce_bytes: [u8; 12] = rand::random();
    let nonce = Nonce::from(nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            aes_gcm::aead::Payload {
                msg: &payload,
                aad: &aad,
            },
        )
        .map_err(|e| format!("AES-GCM encrypt error: {e}"))?;

    // Pack: nonce(12) || ciphertext
    let mut result = Vec::with_capacity(12 + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

/// Result of message decryption.
pub struct DecryptedMessage {
    pub content: Vec<u8>,
    pub signature_valid: bool,
}

/// Decrypt a message using decrypt-then-verify.
///
/// Input format: `nonce(12) || ciphertext(sig(64) + content + gcm_tag(16))`
///
/// Returns the decrypted content and whether the signature was valid.
/// Does NOT fail on signature mismatch — returns content with `signature_valid = false`.
pub fn decrypt_message(
    sender_pub: &VerifyingKey,
    channel_key: &[u8; 32],
    encrypted: &[u8],
    channel_id: &str,
    key_version: u32,
) -> Result<DecryptedMessage, String> {
    if encrypted.len() < 12 + SIGNATURE_SIZE + 16 {
        return Err("Ciphertext too short".to_string());
    }

    let nonce = Nonce::from_slice(&encrypted[..12]);
    let ciphertext = &encrypted[12..];

    // Build AAD
    let aad = build_message_aad(channel_id, key_version)?;

    // AES-256-GCM decrypt
    let cipher =
        Aes256Gcm::new_from_slice(channel_key).map_err(|e| format!("AES key error: {e}"))?;
    let payload = cipher
        .decrypt(
            nonce,
            aes_gcm::aead::Payload {
                msg: ciphertext,
                aad: &aad,
            },
        )
        .map_err(|e| format!("AES-GCM decrypt error: {e}"))?;

    if payload.len() < SIGNATURE_SIZE {
        return Err("Decrypted payload too short".to_string());
    }

    if payload.len() > MAX_CONTENT_SIZE + SIGNATURE_SIZE {
        return Err("Decrypted content exceeds size limit".to_string());
    }

    // Split: signature(64) || content
    let sig_bytes: [u8; 64] = payload[..SIGNATURE_SIZE]
        .try_into()
        .map_err(|_| "Failed to extract signature")?;
    let content = payload[SIGNATURE_SIZE..].to_vec();

    // Verify signature (non-fatal — still return content)
    let signature_valid = identity::verify(sender_pub, &content, &sig_bytes).is_ok();

    Ok(DecryptedMessage {
        content,
        signature_valid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::identity::generate_keypair;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let (sender_sk, sender_vk) = generate_keypair();
        let channel_key: [u8; 32] = rand::random();
        let channel_id = "01HQJK5M6N7P8R9S0TABCDEFGH";
        let key_version = 1u32;

        let content = build_message_content("hello meza!");

        let encrypted =
            encrypt_message(&sender_sk, &channel_key, &content, channel_id, key_version).unwrap();

        let decrypted =
            decrypt_message(&sender_vk, &channel_key, &encrypted, channel_id, key_version)
                .unwrap();

        assert!(decrypted.signature_valid);
        assert_eq!(decrypted.content, content);

        let parsed = parse_message_content(&decrypted.content);
        assert_eq!(parsed.text, "hello meza!");
    }

    #[test]
    fn decrypt_wrong_key_fails() {
        let (sender_sk, sender_vk) = generate_keypair();
        let channel_key: [u8; 32] = rand::random();
        let wrong_key: [u8; 32] = rand::random();
        let channel_id = "01HQJK5M6N7P8R9S0TABCDEFGH";

        let content = build_message_content("secret");
        let encrypted =
            encrypt_message(&sender_sk, &channel_key, &content, channel_id, 1).unwrap();

        assert!(decrypt_message(&sender_vk, &wrong_key, &encrypted, channel_id, 1).is_err());
    }

    #[test]
    fn wrong_sender_signature_invalid() {
        let (sender_sk, _) = generate_keypair();
        let (_, wrong_vk) = generate_keypair();
        let channel_key: [u8; 32] = rand::random();
        let channel_id = "01HQJK5M6N7P8R9S0TABCDEFGH";

        let content = build_message_content("test");
        let encrypted =
            encrypt_message(&sender_sk, &channel_key, &content, channel_id, 1).unwrap();

        let decrypted =
            decrypt_message(&wrong_vk, &channel_key, &encrypted, channel_id, 1).unwrap();
        assert!(!decrypted.signature_valid);
        assert_eq!(decrypted.content, content);
    }

    #[test]
    fn parse_v1_format() {
        let content = build_message_content("hello");
        let parsed = parse_message_content(&content);
        assert_eq!(parsed.text, "hello");
    }

    #[test]
    fn parse_legacy_format() {
        let content = b"raw text message";
        let parsed = parse_message_content(content);
        assert_eq!(parsed.text, "raw text message");
    }
}
