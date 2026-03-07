package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/meza-chat/meza/internal/models"
)

// DeviceStore implements DeviceStorer using PostgreSQL.
type DeviceStore struct {
	pool *pgxpool.Pool
}

// NewDeviceStore creates a new DeviceStore backed by a pgxpool.Pool.
func NewDeviceStore(pool *pgxpool.Pool) *DeviceStore {
	return &DeviceStore{pool: pool}
}

func (s *DeviceStore) UpsertDevice(ctx context.Context, device *models.Device) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO devices (id, user_id, device_name, platform, push_endpoint, push_p256dh, push_auth, push_token, push_enabled, device_public_key, device_signature, created_at, updated_at, last_seen_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now(), now())
		 ON CONFLICT (id)
		 DO UPDATE SET device_name = EXCLUDED.device_name,
		               platform = EXCLUDED.platform,
		               push_endpoint = EXCLUDED.push_endpoint,
		               push_p256dh = EXCLUDED.push_p256dh,
		               push_auth = EXCLUDED.push_auth,
		               push_token = EXCLUDED.push_token,
		               push_enabled = EXCLUDED.push_enabled,
		               device_public_key = EXCLUDED.device_public_key,
		               device_signature = EXCLUDED.device_signature,
		               updated_at = now(),
		               last_seen_at = now()`,
		device.ID, device.UserID, device.DeviceName, device.Platform,
		nilIfEmpty(device.PushEndpoint), nilIfEmpty(device.PushP256dh), nilIfEmpty(device.PushAuth),
		nilIfEmpty(device.PushToken), device.PushEnabled,
		nilIfEmpty(device.DevicePublicKey), nilIfEmpty(device.DeviceSignature),
	)
	if err != nil {
		return fmt.Errorf("upsert device: %w", err)
	}
	return nil
}

func (s *DeviceStore) GetDevice(ctx context.Context, userID, deviceID string) (*models.Device, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var d models.Device
	var pushEndpoint, pushP256dh, pushAuth, pushToken, devicePubKey, deviceSig *string
	err := s.pool.QueryRow(ctx,
		`SELECT id, user_id, device_name, platform, push_endpoint, push_p256dh, push_auth, push_token, push_enabled, device_public_key, device_signature, created_at, updated_at, last_seen_at
		 FROM devices WHERE user_id = $1 AND id = $2`,
		userID, deviceID,
	).Scan(&d.ID, &d.UserID, &d.DeviceName, &d.Platform, &pushEndpoint, &pushP256dh, &pushAuth, &pushToken, &d.PushEnabled, &devicePubKey, &deviceSig, &d.CreatedAt, &d.UpdatedAt, &d.LastSeenAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get device: %w", err)
	}
	d.PushEndpoint = derefStr(pushEndpoint)
	d.PushP256dh = derefStr(pushP256dh)
	d.PushAuth = derefStr(pushAuth)
	d.PushToken = derefStr(pushToken)
	d.DevicePublicKey = derefStr(devicePubKey)
	d.DeviceSignature = derefStr(deviceSig)
	return &d, nil
}

func (s *DeviceStore) GetUserDevices(ctx context.Context, userID string) ([]*models.Device, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, user_id, device_name, platform, push_endpoint, push_p256dh, push_auth, push_token, push_enabled, device_public_key, device_signature, created_at, updated_at, last_seen_at
		 FROM devices WHERE user_id = $1 ORDER BY last_seen_at DESC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query devices: %w", err)
	}
	defer rows.Close()
	return scanDevices(rows)
}

func (s *DeviceStore) GetPushEnabledDevices(ctx context.Context, userID string) ([]*models.Device, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, user_id, device_name, platform, push_endpoint, push_p256dh, push_auth, push_token, push_enabled, device_public_key, device_signature, created_at, updated_at, last_seen_at
		 FROM devices WHERE user_id = $1 AND push_enabled = true`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query push-enabled devices: %w", err)
	}
	defer rows.Close()
	return scanDevices(rows)
}

func (s *DeviceStore) GetPushEnabledDevicesForUsers(ctx context.Context, userIDs []string) (map[string][]*models.Device, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, user_id, device_name, platform, push_endpoint, push_p256dh, push_auth, push_token, push_enabled, device_public_key, device_signature, created_at, updated_at, last_seen_at
		 FROM devices WHERE user_id = ANY($1) AND push_enabled = true`,
		userIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("query push-enabled devices for users: %w", err)
	}
	defer rows.Close()

	devices, err := scanDevices(rows)
	if err != nil {
		return nil, err
	}

	result := make(map[string][]*models.Device, len(userIDs))
	for _, d := range devices {
		result[d.UserID] = append(result[d.UserID], d)
	}
	return result, nil
}

func (s *DeviceStore) DeleteDevice(ctx context.Context, userID, deviceID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tag, err := s.pool.Exec(ctx,
		`DELETE FROM devices WHERE user_id = $1 AND id = $2`,
		userID, deviceID,
	)
	if err != nil {
		return fmt.Errorf("delete device: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("device not found")
	}
	return nil
}

func (s *DeviceStore) TouchLastSeen(ctx context.Context, userID, deviceID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`UPDATE devices SET last_seen_at = now() WHERE user_id = $1 AND id = $2`,
		userID, deviceID,
	)
	if err != nil {
		return fmt.Errorf("touch last seen: %w", err)
	}
	return nil
}

func (s *DeviceStore) PruneStaleDevices(ctx context.Context, olderThan time.Duration) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	cutoff := time.Now().Add(-olderThan)
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM devices WHERE last_seen_at < $1`,
		cutoff,
	)
	if err != nil {
		return 0, fmt.Errorf("prune stale devices: %w", err)
	}
	return tag.RowsAffected(), nil
}

func scanDevices(rows pgx.Rows) ([]*models.Device, error) {
	var devices []*models.Device
	for rows.Next() {
		var d models.Device
		var pushEndpoint, pushP256dh, pushAuth, pushToken, devicePubKey, deviceSig *string
		if err := rows.Scan(&d.ID, &d.UserID, &d.DeviceName, &d.Platform, &pushEndpoint, &pushP256dh, &pushAuth, &pushToken, &d.PushEnabled, &devicePubKey, &deviceSig, &d.CreatedAt, &d.UpdatedAt, &d.LastSeenAt); err != nil {
			return nil, fmt.Errorf("scan device: %w", err)
		}
		d.PushEndpoint = derefStr(pushEndpoint)
		d.PushP256dh = derefStr(pushP256dh)
		d.PushAuth = derefStr(pushAuth)
		d.PushToken = derefStr(pushToken)
		d.DevicePublicKey = derefStr(devicePubKey)
		d.DeviceSignature = derefStr(deviceSig)
		devices = append(devices, &d)
	}
	return devices, rows.Err()
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
