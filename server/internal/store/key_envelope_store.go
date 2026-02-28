package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrPublicKeyAlreadyRegistered is returned when a user tries to register a
// different public key after one is already set (first-write-only policy).
var ErrPublicKeyAlreadyRegistered = errors.New("public key already registered")

// ErrVersionMismatch is returned when a RotateChannelKey call's expected version
// does not match the current version (optimistic concurrency control).
var ErrVersionMismatch = errors.New("channel key version mismatch")

// KeyEnvelopeStore implements KeyEnvelopeStorer using PostgreSQL.
type KeyEnvelopeStore struct {
	pool *pgxpool.Pool
}

// NewKeyEnvelopeStore creates a new KeyEnvelopeStore backed by a pgxpool.Pool.
func NewKeyEnvelopeStore(pool *pgxpool.Pool) *KeyEnvelopeStore {
	return &KeyEnvelopeStore{pool: pool}
}

func (s *KeyEnvelopeStore) RegisterPublicKey(ctx context.Context, userID string, publicKey []byte) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	// First-write-only: prevent silent key replacement from a compromised session.
	tag, err := s.pool.Exec(ctx,
		`UPDATE users SET signing_public_key = $1 WHERE id = $2 AND signing_public_key IS NULL`,
		publicKey, userID,
	)
	if err != nil {
		return fmt.Errorf("register public key for user %s: %w", userID, err)
	}
	if tag.RowsAffected() == 0 {
		// Key already registered — check if it's the same key (idempotent re-registration)
		var existing []byte
		err = s.pool.QueryRow(ctx,
			`SELECT signing_public_key FROM users WHERE id = $1`,
			userID,
		).Scan(&existing)
		if err != nil {
			return fmt.Errorf("check existing public key for user %s: %w", userID, err)
		}
		if string(existing) == string(publicKey) {
			return nil // Same key, idempotent
		}
		return ErrPublicKeyAlreadyRegistered
	}
	return nil
}

func (s *KeyEnvelopeStore) GetPublicKeys(ctx context.Context, userIDs []string) (map[string][]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, signing_public_key FROM users WHERE id = ANY($1) AND signing_public_key IS NOT NULL`,
		userIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("get public keys: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]byte, len(userIDs))
	for rows.Next() {
		var id string
		var key []byte
		if err := rows.Scan(&id, &key); err != nil {
			return nil, fmt.Errorf("scan public key row: %w", err)
		}
		result[id] = key
	}
	return result, rows.Err()
}

func (s *KeyEnvelopeStore) StoreKeyEnvelopes(ctx context.Context, channelID string, version uint32, envelopes []KeyEnvelope) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Ensure channel_key_versions entry exists
	_, err = tx.Exec(ctx,
		`INSERT INTO channel_key_versions (channel_id, current_version) VALUES ($1, $2)
		 ON CONFLICT (channel_id) DO NOTHING`,
		channelID, version,
	)
	if err != nil {
		return fmt.Errorf("upsert channel key version: %w", err)
	}

	// Batch UPSERT envelopes (single round-trip for all envelopes)
	batch := &pgx.Batch{}
	for _, env := range envelopes {
		batch.Queue(
			`INSERT INTO channel_key_envelopes (channel_id, user_id, key_version, envelope)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (channel_id, user_id, key_version) DO UPDATE SET envelope = $4, created_at = now()`,
			channelID, env.UserID, version, env.Envelope,
		)
	}
	br := tx.SendBatch(ctx, batch)
	for range envelopes {
		if _, err = br.Exec(); err != nil {
			br.Close()
			return fmt.Errorf("upsert key envelope: %w", err)
		}
	}
	if err = br.Close(); err != nil {
		return fmt.Errorf("close envelope batch: %w", err)
	}

	return tx.Commit(ctx)
}

func (s *KeyEnvelopeStore) GetKeyEnvelopes(ctx context.Context, channelID string, userID string) ([]VersionedEnvelope, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT key_version, envelope FROM channel_key_envelopes
		 WHERE channel_id = $1 AND user_id = $2
		 ORDER BY key_version ASC`,
		channelID, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("get key envelopes: %w", err)
	}
	defer rows.Close()

	var result []VersionedEnvelope
	for rows.Next() {
		var ve VersionedEnvelope
		if err := rows.Scan(&ve.KeyVersion, &ve.Envelope); err != nil {
			return nil, fmt.Errorf("scan key envelope row: %w", err)
		}
		result = append(result, ve)
	}
	return result, rows.Err()
}

func (s *KeyEnvelopeStore) HasChannelKeyVersion(ctx context.Context, channelID string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM channel_key_versions WHERE channel_id = $1)`,
		channelID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check channel key version for %s: %w", channelID, err)
	}
	return exists, nil
}

func (s *KeyEnvelopeStore) RotateChannelKey(ctx context.Context, channelID string, expectedVersion uint32, envelopes []KeyEnvelope) (uint32, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Optimistic concurrency: increment version only if it matches expected.
	// expectedVersion=0 means atomic initial creation (no row exists yet).
	var newVersion uint32
	if expectedVersion == 0 {
		// INSERT-ON-CONFLICT: atomic initial key creation. Only one caller
		// succeeds; concurrent callers get ErrVersionMismatch.
		err = tx.QueryRow(ctx,
			`INSERT INTO channel_key_versions (channel_id, current_version)
			 VALUES ($1, 1)
			 ON CONFLICT (channel_id) DO NOTHING
			 RETURNING current_version`,
			channelID,
		).Scan(&newVersion)
		if err != nil {
			if err == pgx.ErrNoRows {
				// Row already existed — someone else created v1 first.
				return 0, ErrVersionMismatch
			}
			return 0, fmt.Errorf("initial channel key creation: %w", err)
		}
	} else {
		err = tx.QueryRow(ctx,
			`UPDATE channel_key_versions
			 SET current_version = current_version + 1, updated_at = now()
			 WHERE channel_id = $1 AND current_version = $2
			 RETURNING current_version`,
			channelID, expectedVersion,
		).Scan(&newVersion)
		if err != nil {
			if err == pgx.ErrNoRows {
				return 0, ErrVersionMismatch
			}
			return 0, fmt.Errorf("rotate channel key version: %w", err)
		}
	}

	// Batch insert new envelopes for the new version (single round-trip)
	batch := &pgx.Batch{}
	for _, env := range envelopes {
		batch.Queue(
			`INSERT INTO channel_key_envelopes (channel_id, user_id, key_version, envelope)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (channel_id, user_id, key_version) DO UPDATE SET envelope = $4, created_at = now()`,
			channelID, env.UserID, newVersion, env.Envelope,
		)
	}
	br := tx.SendBatch(ctx, batch)
	for range envelopes {
		if _, err = br.Exec(); err != nil {
			br.Close()
			return 0, fmt.Errorf("insert rotated envelope: %w", err)
		}
	}
	if err = br.Close(); err != nil {
		return 0, fmt.Errorf("close rotated envelope batch: %w", err)
	}

	// Clean up envelopes for users who are no longer in the envelope set.
	// Only delete envelopes for *previous* versions — the new version's
	// envelopes were just inserted above.  This prevents nuking history
	// for members who are still present but whose key-fetch failed on the
	// caller side (the caller simply wouldn't include them in `envelopes`).
	recipientIDs := make([]string, len(envelopes))
	for i, env := range envelopes {
		recipientIDs[i] = env.UserID
	}
	if len(recipientIDs) > 0 {
		_, err = tx.Exec(ctx,
			`DELETE FROM channel_key_envelopes
			 WHERE channel_id = $1
			   AND key_version < $2
			   AND user_id != ALL($3::text[])`,
			channelID, newVersion, recipientIDs,
		)
		if err != nil {
			return 0, fmt.Errorf("clean up removed member envelopes: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit rotate: %w", err)
	}
	return newVersion, nil
}
