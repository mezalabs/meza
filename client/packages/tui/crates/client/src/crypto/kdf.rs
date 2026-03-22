//! Key derivation: Argon2id + HKDF-SHA256
//!
//! Password -> Argon2id(64 bytes) -> HKDF-SHA256 -> master_key (32B) + auth_key (32B)
//!
//! Byte-compatible with the TypeScript web client (`keys.ts`).

use argon2::{Algorithm, Argon2, Params, Version};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

/// HKDF info strings — must match TypeScript exactly.
const HKDF_INFO_MASTER: &[u8] = b"meza-master-key";
const HKDF_INFO_AUTH: &[u8] = b"meza-auth-key";

/// HKDF salt: 32-byte zero array (not empty).
const HKDF_SALT: [u8; 32] = [0u8; 32];

/// Argon2id parameters matching the TypeScript client.
const ARGON2_PARALLELISM: u32 = 4;
const ARGON2_TIME_COST: u32 = 2;
const ARGON2_MEMORY_COST: u32 = 65536; // 64 MiB
const ARGON2_OUTPUT_LENGTH: usize = 64;

/// A 32-byte key wrapped in `Zeroizing` for automatic memory clearing.
pub type ZeroKey = Zeroizing<[u8; 32]>;

/// Derive master_key and auth_key from a password + salt using Argon2id -> HKDF-SHA256.
///
/// Returns `(master_key, auth_key)`, each 32 bytes, wrapped in `Zeroizing`.
pub fn derive_keys(
    password: &[u8],
    salt: &[u8],
) -> Result<(ZeroKey, ZeroKey), String> {
    // Argon2id -> 64 bytes
    let params = Params::new(
        ARGON2_MEMORY_COST,
        ARGON2_TIME_COST,
        ARGON2_PARALLELISM,
        Some(ARGON2_OUTPUT_LENGTH),
    )
    .map_err(|e| format!("Argon2 params error: {e}"))?;

    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut argon_output = Zeroizing::new([0u8; ARGON2_OUTPUT_LENGTH]);
    argon2
        .hash_password_into(password, salt, argon_output.as_mut())
        .map_err(|e| format!("Argon2id error: {e}"))?;

    // HKDF-SHA256: extract from argon output with zero salt
    let hkdf = Hkdf::<Sha256>::new(Some(&HKDF_SALT), argon_output.as_ref());

    // Derive master_key
    let mut master_key = Zeroizing::new([0u8; 32]);
    hkdf.expand(HKDF_INFO_MASTER, master_key.as_mut())
        .map_err(|e| format!("HKDF master key error: {e}"))?;

    // Derive auth_key
    let mut auth_key = Zeroizing::new([0u8; 32]);
    hkdf.expand(HKDF_INFO_AUTH, auth_key.as_mut())
        .map_err(|e| format!("HKDF auth key error: {e}"))?;

    Ok((master_key, auth_key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_keys_deterministic() {
        let password = b"test-password";
        let salt = b"0123456789abcdef"; // 16-byte salt

        let (mk1, ak1) = derive_keys(password, salt).unwrap();
        let (mk2, ak2) = derive_keys(password, salt).unwrap();

        assert_eq!(mk1.as_ref(), mk2.as_ref(), "master key must be deterministic");
        assert_eq!(ak1.as_ref(), ak2.as_ref(), "auth key must be deterministic");
        assert_ne!(mk1.as_ref(), ak1.as_ref(), "master and auth keys must differ");
    }

    #[test]
    fn derive_keys_different_passwords() {
        let salt = b"0123456789abcdef";
        let (mk1, _) = derive_keys(b"password-a", salt).unwrap();
        let (mk2, _) = derive_keys(b"password-b", salt).unwrap();
        assert_ne!(mk1.as_ref(), mk2.as_ref());
    }

    #[test]
    fn derive_keys_different_salts() {
        let password = b"same-password";
        let (mk1, _) = derive_keys(password, b"salt-aaaaaaaaaaaaa").unwrap();
        let (mk2, _) = derive_keys(password, b"salt-bbbbbbbbbbbbb").unwrap();
        assert_ne!(mk1.as_ref(), mk2.as_ref());
    }
}
