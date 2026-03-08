-- Add recovery verifier hash column for proof-of-phrase during account recovery.
-- SHA-256 hash of an HKDF-derived verifier that proves the client knows the recovery phrase.
-- NULL for existing users (backward compatible — server skips verification when NULL).
ALTER TABLE user_auth ADD COLUMN IF NOT EXISTS recovery_verifier_hash BYTEA;
