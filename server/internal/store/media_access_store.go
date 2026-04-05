package store

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mezalabs/meza/internal/models"
)

// MediaAccessStore implements MediaAccessChecker using the Postgres pool.
// It verifies download access based on the attachment's upload_purpose:
//
//   - chat_attachment (linked):   user must have ViewChannel on the channel
//   - chat_attachment (unlinked): only the uploader may access
//   - server_emoji:               user must be a server member (or owner for personal)
//   - soundboard:                 user must be a server member (or owner for personal)
//   - profile_avatar, profile_banner, server_icon, server_banner:
//     public to any authenticated user (avatars appear in message
//     lists; icons appear on invite pages)
type permCacheEntry struct {
	allowed bool
	expires time.Time
}

const permCacheTTL = 5 * time.Minute

type MediaAccessStore struct {
	pool      *pgxpool.Pool
	permChk   *ChannelPermissionStore
	permCache sync.Map // key: "userID:channelID" -> permCacheEntry
}

// NewMediaAccessStore creates a MediaAccessStore.
// permChk is used for channel-level ViewChannel checks on chat attachments.
func NewMediaAccessStore(pool *pgxpool.Pool, permChk *ChannelPermissionStore) *MediaAccessStore {
	return &MediaAccessStore{pool: pool, permChk: permChk}
}

// cachedHasViewChannel wraps HasViewChannel with a short-lived in-memory cache
// to avoid repeated multi-query permission resolution for the same user+channel.
func (s *MediaAccessStore) cachedHasViewChannel(ctx context.Context, userID, channelID string) (bool, error) {
	key := userID + ":" + channelID
	if v, ok := s.permCache.Load(key); ok {
		entry := v.(permCacheEntry)
		if time.Now().Before(entry.expires) {
			return entry.allowed, nil
		}
		s.permCache.Delete(key)
	}

	allowed, err := s.permChk.HasViewChannel(ctx, userID, channelID)
	if err != nil {
		return false, err
	}

	s.permCache.Store(key, permCacheEntry{
		allowed: allowed,
		expires: time.Now().Add(permCacheTTL),
	})
	return allowed, nil
}

func (s *MediaAccessStore) CheckAttachmentAccess(ctx context.Context, attachment *models.Attachment, userID string) error {
	switch attachment.UploadPurpose {
	case "chat_attachment":
		return s.checkChatAttachmentAccess(ctx, attachment, userID)
	case "server_emoji":
		// Emoji images are accessible to any authenticated user. Custom emojis
		// can appear in reactions and messages across servers, so restricting
		// downloads to the emoji's origin server would cause broken images for
		// viewers who aren't members of that server.
		return nil
	case "soundboard":
		return s.checkSoundboardAccess(ctx, attachment, userID)
	case "profile_avatar", "profile_banner", "server_icon", "server_banner":
		// Public to any authenticated user — avatars appear in message
		// lists; icons/banners appear on invite pages.
		return nil
	default:
		// Unknown purpose — fail closed.
		return ErrNotFound
	}
}

// checkChatAttachmentAccess verifies channel-level access for a chat attachment.
// If the attachment is linked to a channel, the user must have ViewChannel.
// If not yet linked (pending upload), only the uploader may access it.
func (s *MediaAccessStore) checkChatAttachmentAccess(ctx context.Context, attachment *models.Attachment, userID string) error {
	if attachment.ChannelID == nil || *attachment.ChannelID == "" {
		// Uploader can always access their own attachments.
		if attachment.UploaderID == userID {
			return nil
		}
		// Pre-migration attachments: linked before channel_id column existed.
		// These have linked_at set but channel_id NULL. Require shared server
		// membership as a defense-in-depth check (E2EE is the primary control).
		if attachment.LinkedAt != nil {
			slog.Warn("pre-migration attachment access (no channel_id)", "attachment", attachment.ID, "uploader", attachment.UploaderID, "requester", userID)
			return s.checkSharedServerMembership(ctx, attachment.UploaderID, userID)
		}
		return ErrNotFound
	}

	allowed, err := s.cachedHasViewChannel(ctx, userID, *attachment.ChannelID)
	if err != nil {
		return fmt.Errorf("check channel access: %w", err)
	}
	if !allowed {
		return ErrNotFound
	}
	return nil
}

// checkEmojiAccess verifies the user can access a server emoji's attachment.
// Personal emojis (no server) are accessible to the owner.
// Server emojis require server membership.
func (s *MediaAccessStore) checkEmojiAccess(ctx context.Context, attachment *models.Attachment, userID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var serverID *string
	var emojiUserID string
	err := s.pool.QueryRow(ctx,
		`SELECT server_id, user_id FROM server_emojis WHERE attachment_id = $1`,
		attachment.ID,
	).Scan(&serverID, &emojiUserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Emoji not found — orphaned attachment, allow uploader only.
			if attachment.UploaderID == userID {
				return nil
			}
			return ErrNotFound
		}
		return fmt.Errorf("lookup emoji: %w", err)
	}

	// Personal emoji: owner only.
	if serverID == nil || *serverID == "" {
		if emojiUserID == userID {
			return nil
		}
		return ErrNotFound
	}

	return s.checkServerMembership(ctx, *serverID, userID)
}

// checkSoundboardAccess verifies the user can access a soundboard sound's attachment.
func (s *MediaAccessStore) checkSoundboardAccess(ctx context.Context, attachment *models.Attachment, userID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var serverID *string
	var soundUserID string
	err := s.pool.QueryRow(ctx,
		`SELECT server_id, user_id FROM soundboard_sounds WHERE attachment_id = $1`,
		attachment.ID,
	).Scan(&serverID, &soundUserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if attachment.UploaderID == userID {
				return nil
			}
			return ErrNotFound
		}
		return fmt.Errorf("lookup soundboard sound: %w", err)
	}

	// Personal sound: owner only.
	if serverID == nil || *serverID == "" {
		if soundUserID == userID {
			return nil
		}
		return ErrNotFound
	}

	return s.checkServerMembership(ctx, *serverID, userID)
}

// checkSharedServerMembership returns nil if both users share at least one server.
func (s *MediaAccessStore) checkSharedServerMembership(ctx context.Context, uploaderID, userID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM members m1
			JOIN members m2 ON m1.server_id = m2.server_id
			WHERE m1.user_id = $1 AND m2.user_id = $2
		)`,
		uploaderID, userID,
	).Scan(&exists)
	if err != nil {
		return fmt.Errorf("check shared server membership: %w", err)
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

// checkServerMembership returns nil if the user is a member, ErrNotFound otherwise.
func (s *MediaAccessStore) checkServerMembership(ctx context.Context, serverID, userID string) error {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM members WHERE server_id = $1 AND user_id = $2)`,
		serverID, userID,
	).Scan(&exists)
	if err != nil {
		return fmt.Errorf("check server membership: %w", err)
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}
