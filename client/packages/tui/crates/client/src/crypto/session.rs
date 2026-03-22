//! E2EE session lifecycle.
//!
//! Manages the master key and identity keypair lifetime.
//! Byte-compatible with the TypeScript web client (`session.ts`).

use ed25519_dalek::{SigningKey, VerifyingKey};
use zeroize::Zeroizing;

use super::identity::{decrypt_identity, encrypt_identity};

/// Holds the decrypted E2EE session state.
///
/// The master key encrypts the identity keypair at rest. The identity keypair
/// (Ed25519) is used for signing messages and (via X25519 derivation) for
/// ECIES key wrapping.
pub struct CryptoSession {
    master_key: Option<Zeroizing<[u8; 32]>>,
    identity: Option<SigningKey>,
    ready: bool,
}

impl CryptoSession {
    /// Create a new, uninitialized session.
    pub fn new() -> Self {
        Self {
            master_key: None,
            identity: None,
            ready: false,
        }
    }

    /// Bootstrap the session by decrypting the identity from an encrypted bundle.
    ///
    /// The encrypted bundle format matches TypeScript's `credentials.ts`:
    /// `[12B nonce][ciphertext (64B plaintext + 16B GCM tag)]`.
    pub fn bootstrap(
        &mut self,
        master_key: Zeroizing<[u8; 32]>,
        encrypted_identity: &[u8],
    ) -> Result<(), String> {
        let signing_key = decrypt_identity(encrypted_identity, &master_key)?;
        self.master_key = Some(master_key);
        self.identity = Some(signing_key);
        self.ready = true;
        Ok(())
    }

    /// Tear down the session: zeroize all key material and mark as not ready.
    pub fn teardown(&mut self) {
        self.master_key = None;
        // SigningKey stores a keypair internally; dropping it releases the memory.
        // ed25519-dalek's SigningKey implements Zeroize via its internal representation.
        self.identity = None;
        self.ready = false;
    }

    /// Returns true if the session has been bootstrapped and is ready for use.
    pub fn is_ready(&self) -> bool {
        self.ready
    }

    /// Get a reference to the signing key, if the session is ready.
    pub fn signing_key(&self) -> Option<&SigningKey> {
        self.identity.as_ref()
    }

    /// Get the verifying (public) key, if the session is ready.
    pub fn verifying_key(&self) -> Option<VerifyingKey> {
        self.identity.as_ref().map(|sk| sk.verifying_key())
    }

    /// Get a reference to the master key, if the session is ready.
    pub fn master_key(&self) -> Option<&[u8; 32]> {
        self.master_key.as_deref()
    }

    /// Re-encrypt the current identity with the current master key.
    /// Useful for persisting after bootstrap.
    pub fn encrypt_identity_bundle(&self) -> Option<Vec<u8>> {
        match (&self.identity, &self.master_key) {
            (Some(sk), Some(mk)) => Some(encrypt_identity(sk, mk)),
            _ => None,
        }
    }
}

impl Default for CryptoSession {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CryptoSession {
    fn drop(&mut self) {
        self.teardown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::identity::{encrypt_identity, generate_keypair};

    #[test]
    fn bootstrap_and_access() {
        let (sk, vk) = generate_keypair();
        let master_key_bytes: [u8; 32] = rand::random();
        let master_key = Zeroizing::new(master_key_bytes);

        let encrypted = encrypt_identity(&sk, &master_key_bytes);

        let mut session = CryptoSession::new();
        assert!(!session.is_ready());
        assert!(session.signing_key().is_none());
        assert!(session.verifying_key().is_none());
        assert!(session.master_key().is_none());

        session.bootstrap(master_key, &encrypted).unwrap();

        assert!(session.is_ready());
        assert_eq!(session.signing_key().unwrap().to_bytes(), sk.to_bytes());
        assert_eq!(session.verifying_key().unwrap(), vk);
        assert_eq!(session.master_key().unwrap(), &master_key_bytes);
    }

    #[test]
    fn teardown_clears_state() {
        let (sk, _) = generate_keypair();
        let master_key_bytes: [u8; 32] = rand::random();
        let encrypted = encrypt_identity(&sk, &master_key_bytes);

        let mut session = CryptoSession::new();
        session
            .bootstrap(Zeroizing::new(master_key_bytes), &encrypted)
            .unwrap();
        assert!(session.is_ready());

        session.teardown();
        assert!(!session.is_ready());
        assert!(session.signing_key().is_none());
        assert!(session.verifying_key().is_none());
        assert!(session.master_key().is_none());
    }

    #[test]
    fn bootstrap_wrong_key_fails() {
        let (sk, _) = generate_keypair();
        let master_key: [u8; 32] = rand::random();
        let wrong_key: [u8; 32] = rand::random();

        let encrypted = encrypt_identity(&sk, &master_key);

        let mut session = CryptoSession::new();
        assert!(session.bootstrap(Zeroizing::new(wrong_key), &encrypted).is_err());
        assert!(!session.is_ready());
    }
}
