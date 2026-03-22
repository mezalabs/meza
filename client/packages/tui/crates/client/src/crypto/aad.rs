//! AAD (Additional Authenticated Data) builders for AES-256-GCM encryption.
//!
//! AAD binds ciphertext to its context (channel, key version, recipient),
//! preventing ciphertext swapping attacks by a compromised server.
//!
//! Byte-compatible with TypeScript `aad.ts`.

/// Purpose byte for message encryption AAD.
pub const PURPOSE_MESSAGE: u8 = 0x01;
/// Purpose byte for key wrap AAD.
pub const PURPOSE_KEY_WRAP: u8 = 0x02;

/// ULID length in bytes (always 26 ASCII characters).
const ULID_LENGTH: usize = 26;

/// Build AAD for message encryption.
///
/// Layout (31 bytes):
///   `purpose(1) || channel_id_utf8(26) || key_version_u32be(4)`
///
/// Matches TypeScript `buildContextAAD(PURPOSE_MESSAGE, ...)`.
pub fn build_message_aad(channel_id: &str, key_version: u32) -> Result<[u8; 31], String> {
    let id_bytes = channel_id.as_bytes();
    if id_bytes.len() != ULID_LENGTH {
        return Err(format!(
            "channel_id must be {ULID_LENGTH} bytes, got {}",
            id_bytes.len()
        ));
    }

    let mut aad = [0u8; 31];
    aad[0] = PURPOSE_MESSAGE;
    aad[1..27].copy_from_slice(id_bytes);
    aad[27..31].copy_from_slice(&key_version.to_be_bytes());
    Ok(aad)
}

/// Build AAD for ECIES channel key wrapping.
///
/// Layout (59 bytes):
///   `PURPOSE_KEY_WRAP(1) || channel_id_utf8(26) || recipient_ed_pub(32)`
///
/// NOTE: No `key_version` field in key wrap AAD (matches TypeScript `buildKeyWrapAAD`).
pub fn build_key_wrap_aad(
    channel_id: &str,
    recipient_ed_pub: &[u8; 32],
) -> Result<[u8; 59], String> {
    let id_bytes = channel_id.as_bytes();
    if id_bytes.len() != ULID_LENGTH {
        return Err(format!(
            "channel_id must be {ULID_LENGTH} bytes, got {}",
            id_bytes.len()
        ));
    }

    let mut aad = [0u8; 59];
    aad[0] = PURPOSE_KEY_WRAP;
    aad[1..27].copy_from_slice(id_bytes);
    aad[27..59].copy_from_slice(recipient_ed_pub);
    Ok(aad)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_aad_layout() {
        let channel_id = "01HQJK5M6N7P8R9S0TABCDEFGH";
        assert_eq!(channel_id.len(), 26);

        let aad = build_message_aad(channel_id, 1).unwrap();
        assert_eq!(aad.len(), 31);
        assert_eq!(aad[0], PURPOSE_MESSAGE);
        assert_eq!(&aad[1..27], channel_id.as_bytes());
        assert_eq!(&aad[27..31], &1u32.to_be_bytes());
    }

    #[test]
    fn key_wrap_aad_layout() {
        let channel_id = "01HQJK5M6N7P8R9S0TABCDEFGH";
        let pub_key = [0xAB; 32];

        let aad = build_key_wrap_aad(channel_id, &pub_key).unwrap();
        assert_eq!(aad.len(), 59);
        assert_eq!(aad[0], PURPOSE_KEY_WRAP);
        assert_eq!(&aad[1..27], channel_id.as_bytes());
        assert_eq!(&aad[27..59], &pub_key);
    }

    #[test]
    fn rejects_invalid_channel_id() {
        assert!(build_message_aad("too-short", 1).is_err());
        assert!(build_key_wrap_aad("too-short", &[0; 32]).is_err());
    }
}
