package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/meza-chat/meza/internal/models"
)

const defaultQueryTimeout = 5 * time.Second

// AuthStore implements AuthStorer using PostgreSQL.
type AuthStore struct {
	pool *pgxpool.Pool
}

// NewAuthStore creates a new AuthStore backed by a pgxpool.Pool.
func NewAuthStore(pool *pgxpool.Pool) *AuthStore {
	return &AuthStore{pool: pool}
}

func (s *AuthStore) CreateUser(ctx context.Context, user *models.User, authKeyHash string, salt []byte, encryptedBundle models.EncryptedBundle) (*models.User, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx,
		`INSERT INTO users (id, email, username, display_name, avatar_url, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		user.ID, user.Email, user.Username, user.DisplayName, user.AvatarURL, user.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert user: %w", err)
	}

	// Insert user_auth with auth credentials and encrypted identity key bundle.
	_, err = tx.Exec(ctx,
		`INSERT INTO user_auth (user_id, auth_key_hash, salt, encrypted_key_bundle, key_bundle_iv, recovery_encrypted_key_bundle, recovery_key_bundle_iv)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		user.ID, authKeyHash, salt,
		encryptedBundle.EncryptedKeyBundle, encryptedBundle.KeyBundleIV,
		encryptedBundle.RecoveryEncryptedKeyBundle, encryptedBundle.RecoveryKeyBundleIV,
	)
	if err != nil {
		return nil, fmt.Errorf("insert user_auth: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	return user, nil
}

func (s *AuthStore) UserExists(ctx context.Context, userID string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)`, userID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check user existence: %w", err)
	}
	return exists, nil
}

func (s *AuthStore) GetUserByID(ctx context.Context, userID string) (*models.User, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var u models.User
	var audioPrefsJSON []byte
	err := s.pool.QueryRow(ctx,
		`SELECT id, COALESCE(email,''), username, COALESCE(display_name,''), COALESCE(avatar_url,''), emoji_scale, created_at,
		        COALESCE(bio,''), COALESCE(pronouns,''), COALESCE(banner_url,''), COALESCE(theme_color_primary,''), COALESCE(theme_color_secondary,''), simple_mode,
		        audio_preferences, dm_privacy,
		        is_federated, COALESCE(home_server,''), COALESCE(remote_user_id,'')
		 FROM users WHERE id = $1`, userID,
	).Scan(&u.ID, &u.Email, &u.Username, &u.DisplayName, &u.AvatarURL, &u.EmojiScale, &u.CreatedAt,
		&u.Bio, &u.Pronouns, &u.BannerURL, &u.ThemeColorPrimary, &u.ThemeColorSecondary, &u.SimpleMode,
		&audioPrefsJSON, &u.DMPrivacy,
		&u.IsFederated, &u.HomeServer, &u.RemoteUserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("user not found")
		}
		return nil, fmt.Errorf("query user: %w", err)
	}
	u.AudioPreferences = models.DefaultAudioPreferences()
	if len(audioPrefsJSON) > 0 {
		_ = json.Unmarshal(audioPrefsJSON, &u.AudioPreferences)
	}
	return &u, nil
}

func (s *AuthStore) UpdateUser(ctx context.Context, userID string, displayName, avatarURL *string, emojiScale *float32, bio, pronouns, bannerURL, themeColorPrimary, themeColorSecondary *string, simpleMode *bool, audioPreferences *models.AudioPreferences, dmPrivacy *string) (*models.User, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var audioPrefsJSON []byte
	if audioPreferences != nil {
		var err error
		audioPrefsJSON, err = json.Marshal(audioPreferences)
		if err != nil {
			return nil, fmt.Errorf("marshal audio preferences: %w", err)
		}
	}

	var u models.User
	var returnedAudioPrefsJSON []byte
	err := s.pool.QueryRow(ctx,
		`UPDATE users
		 SET display_name = COALESCE($2, display_name),
		     avatar_url = COALESCE($3, avatar_url),
		     emoji_scale = COALESCE($4, emoji_scale),
		     bio = COALESCE($5, bio),
		     pronouns = COALESCE($6, pronouns),
		     banner_url = COALESCE($7, banner_url),
		     theme_color_primary = COALESCE($8, theme_color_primary),
		     theme_color_secondary = COALESCE($9, theme_color_secondary),
		     simple_mode = COALESCE($10, simple_mode),
		     audio_preferences = COALESCE($11, audio_preferences),
		     dm_privacy = COALESCE($12, dm_privacy),
		     updated_at = now()
		 WHERE id = $1
		 RETURNING id, COALESCE(email,''), username, COALESCE(display_name,''), COALESCE(avatar_url,''), emoji_scale, created_at,
		           COALESCE(bio,''), COALESCE(pronouns,''), COALESCE(banner_url,''), COALESCE(theme_color_primary,''), COALESCE(theme_color_secondary,''), simple_mode,
		           audio_preferences, dm_privacy`,
		userID, displayName, avatarURL, emojiScale, bio, pronouns, bannerURL, themeColorPrimary, themeColorSecondary, simpleMode, audioPrefsJSON, dmPrivacy,
	).Scan(&u.ID, &u.Email, &u.Username, &u.DisplayName, &u.AvatarURL, &u.EmojiScale, &u.CreatedAt,
		&u.Bio, &u.Pronouns, &u.BannerURL, &u.ThemeColorPrimary, &u.ThemeColorSecondary, &u.SimpleMode,
		&returnedAudioPrefsJSON, &u.DMPrivacy)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("user not found")
		}
		return nil, fmt.Errorf("update user: %w", err)
	}
	u.AudioPreferences = models.DefaultAudioPreferences()
	if len(returnedAudioPrefsJSON) > 0 {
		_ = json.Unmarshal(returnedAudioPrefsJSON, &u.AudioPreferences)
	}
	return &u, nil
}

func (s *AuthStore) GetUserByEmail(ctx context.Context, email string) (*models.User, *models.AuthData, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var u models.User
	var a models.AuthData
	var audioPrefsJSON []byte
	err := s.pool.QueryRow(ctx,
		`SELECT u.id, COALESCE(u.email,''), u.username, COALESCE(u.display_name,''), COALESCE(u.avatar_url,''), u.emoji_scale, u.created_at,
		        COALESCE(u.bio,''), COALESCE(u.pronouns,''), COALESCE(u.banner_url,''), COALESCE(u.theme_color_primary,''), COALESCE(u.theme_color_secondary,''), u.simple_mode,
		        u.audio_preferences, u.dm_privacy,
		        a.auth_key_hash, a.salt, a.encrypted_key_bundle, a.key_bundle_iv
		 FROM users u JOIN user_auth a ON a.user_id = u.id
		 WHERE u.email = $1`, email,
	).Scan(
		&u.ID, &u.Email, &u.Username, &u.DisplayName, &u.AvatarURL, &u.EmojiScale, &u.CreatedAt,
		&u.Bio, &u.Pronouns, &u.BannerURL, &u.ThemeColorPrimary, &u.ThemeColorSecondary, &u.SimpleMode,
		&audioPrefsJSON, &u.DMPrivacy,
		&a.AuthKeyHash, &a.Salt, &a.EncryptedKeyBundle, &a.KeyBundleIV,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, fmt.Errorf("user not found")
		}
		return nil, nil, fmt.Errorf("query user: %w", err)
	}
	u.AudioPreferences = models.DefaultAudioPreferences()
	if len(audioPrefsJSON) > 0 {
		_ = json.Unmarshal(audioPrefsJSON, &u.AudioPreferences)
	}
	a.UserID = u.ID
	return &u, &a, nil
}

func (s *AuthStore) GetSalt(ctx context.Context, email string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var salt []byte
	err := s.pool.QueryRow(ctx,
		`SELECT a.salt FROM user_auth a JOIN users u ON u.id = a.user_id WHERE u.email = $1`, email,
	).Scan(&salt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("user not found")
		}
		return nil, fmt.Errorf("query salt: %w", err)
	}
	return salt, nil
}

func (s *AuthStore) StoreRefreshToken(ctx context.Context, tokenHash, userID, deviceID string, expiresAt time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO refresh_tokens (token_hash, user_id, device_id, expires_at)
		 VALUES ($1, $2, $3, $4)`,
		tokenHash, userID, deviceID, expiresAt,
	)
	if err != nil {
		return fmt.Errorf("insert refresh token: %w", err)
	}
	return nil
}

func (s *AuthStore) DeleteRefreshTokensByUser(ctx context.Context, userID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx, `DELETE FROM refresh_tokens WHERE user_id = $1`, userID)
	if err != nil {
		return fmt.Errorf("delete refresh tokens: %w", err)
	}
	return nil
}

func (s *AuthStore) ConsumeRefreshToken(ctx context.Context, tokenHash string) (string, string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var userID, deviceID string
	err := s.pool.QueryRow(ctx,
		`DELETE FROM refresh_tokens WHERE token_hash = $1 AND expires_at > NOW()
		 RETURNING user_id, device_id`, tokenHash,
	).Scan(&userID, &deviceID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", fmt.Errorf("refresh token not found or expired")
		}
		return "", "", fmt.Errorf("consume refresh token: %w", err)
	}
	return userID, deviceID, nil
}

func (s *AuthStore) GetKeyBundle(ctx context.Context, userID string) (*models.EncryptedBundle, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var bundle models.EncryptedBundle
	err := s.pool.QueryRow(ctx,
		`SELECT encrypted_key_bundle, key_bundle_iv FROM user_auth WHERE user_id = $1`, userID,
	).Scan(&bundle.EncryptedKeyBundle, &bundle.KeyBundleIV)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("user not found")
		}
		return nil, fmt.Errorf("query key bundle: %w", err)
	}
	return &bundle, nil
}

func (s *AuthStore) ChangePassword(ctx context.Context, userID, oldAuthKeyHash, newAuthKeyHash string, newSalt []byte, newBundle models.EncryptedBundle) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	result, err := s.pool.Exec(ctx,
		`UPDATE user_auth
		 SET auth_key_hash = $2, salt = $3, encrypted_key_bundle = $4, key_bundle_iv = $5,
		     recovery_encrypted_key_bundle = $6, recovery_key_bundle_iv = $7, updated_at = now()
		 WHERE user_id = $1 AND auth_key_hash = $8`,
		userID, newAuthKeyHash, newSalt,
		newBundle.EncryptedKeyBundle, newBundle.KeyBundleIV,
		newBundle.RecoveryEncryptedKeyBundle, newBundle.RecoveryKeyBundleIV,
		oldAuthKeyHash,
	)
	if err != nil {
		return fmt.Errorf("change password: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("invalid old password")
	}
	return nil
}

func (s *AuthStore) GetRecoveryBundle(ctx context.Context, email string) ([]byte, []byte, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var recoveryBundle, recoveryIV, salt []byte
	err := s.pool.QueryRow(ctx,
		`SELECT a.recovery_encrypted_key_bundle, a.recovery_key_bundle_iv, a.salt
		 FROM user_auth a JOIN users u ON u.id = a.user_id
		 WHERE u.email = $1`, email,
	).Scan(&recoveryBundle, &recoveryIV, &salt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, nil, fmt.Errorf("user not found")
		}
		return nil, nil, nil, fmt.Errorf("query recovery bundle: %w", err)
	}
	if recoveryBundle == nil {
		return nil, nil, nil, fmt.Errorf("no recovery bundle set")
	}
	return recoveryBundle, recoveryIV, salt, nil
}

func (s *AuthStore) RecoverAccount(ctx context.Context, email, newAuthKeyHash string, newSalt []byte, newBundle models.EncryptedBundle) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Update credentials and key bundle.
	var userID string
	err = tx.QueryRow(ctx,
		`UPDATE user_auth SET
		     auth_key_hash = $2, salt = $3,
		     encrypted_key_bundle = $4, key_bundle_iv = $5,
		     recovery_encrypted_key_bundle = $6, recovery_key_bundle_iv = $7,
		     updated_at = now()
		 FROM users u
		 WHERE user_auth.user_id = u.id AND u.email = $1
		 RETURNING user_auth.user_id`,
		email, newAuthKeyHash, newSalt,
		newBundle.EncryptedKeyBundle, newBundle.KeyBundleIV,
		newBundle.RecoveryEncryptedKeyBundle, newBundle.RecoveryKeyBundleIV,
	).Scan(&userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", fmt.Errorf("user not found")
		}
		return "", fmt.Errorf("recover account: %w", err)
	}

	// Invalidate all existing sessions by deleting refresh tokens.
	_, err = tx.Exec(ctx, `DELETE FROM refresh_tokens WHERE user_id = $1`, userID)
	if err != nil {
		return "", fmt.Errorf("delete refresh tokens during recovery: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit recovery tx: %w", err)
	}

	slog.Info("account recovered",
		"user_id", userID,
		"action", "account_recovery",
		"email", email,
	)

	return userID, nil
}
