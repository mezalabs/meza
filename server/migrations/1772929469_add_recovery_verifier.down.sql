-- WARNING: Dropping recovery_verifier_hash disables recovery-phrase verification
-- for all users. After re-applying the up migration, users must change their
-- password or recover their account to re-enable verification.
ALTER TABLE user_auth DROP COLUMN IF EXISTS recovery_verifier_hash;
