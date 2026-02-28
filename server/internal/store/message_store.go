package store

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/gocql/gocql"
	"golang.org/x/sync/errgroup"

	"github.com/meza-chat/meza/internal/models"
)

var deletedContentSentinel = []byte{}

const (
	defaultMessageLimit = 50
	maxMessageLimit     = 100
)

// MessageStore implements MessageStorer using ScyllaDB.
type MessageStore struct {
	session *gocql.Session
}

// NewMessageStore creates a new MessageStore backed by a gocql.Session.
func NewMessageStore(session *gocql.Session) *MessageStore {
	return &MessageStore{session: session}
}

func (s *MessageStore) InsertMessage(_ context.Context, msg *models.Message) error {
	return s.session.Query(
		`INSERT INTO messages (channel_id, message_id, author_id, encrypted_content, attachment_ids, reply_to_id, mentioned_user_ids, mentioned_role_ids, mention_everyone, created_at, deleted, key_version)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		msg.ChannelID, msg.MessageID, msg.AuthorID,
		msg.EncryptedContent, msg.AttachmentIDs,
		msg.ReplyToID, msg.MentionedUserIDs, msg.MentionedRoleIDs, msg.MentionEveryone,
		msg.CreatedAt, false, msg.KeyVersion,
	).Consistency(gocql.One).Exec()
}

func (s *MessageStore) GetMessage(_ context.Context, channelID, messageID string) (*models.Message, error) {
	var msg models.Message
	err := s.session.Query(
		`SELECT channel_id, message_id, author_id, encrypted_content,
		        attachment_ids, reply_to_id, mentioned_user_ids, mentioned_role_ids, mention_everyone,
		        created_at, edited_at, deleted, key_version
		 FROM messages WHERE channel_id = ? AND message_id = ?`,
		channelID, messageID,
	).Consistency(gocql.One).Scan(
		&msg.ChannelID, &msg.MessageID, &msg.AuthorID,
		&msg.EncryptedContent, &msg.AttachmentIDs,
		&msg.ReplyToID, &msg.MentionedUserIDs, &msg.MentionedRoleIDs, &msg.MentionEveryone,
		&msg.CreatedAt, &msg.EditedAt, &msg.Deleted, &msg.KeyVersion,
	)
	if err != nil {
		return nil, fmt.Errorf("query message: %w", err)
	}
	return &msg, nil
}

func (s *MessageStore) EditMessage(_ context.Context, channelID, messageID string, encryptedContent []byte, mentionedUserIDs, mentionedRoleIDs []string, mentionEveryone bool, editedAt time.Time, keyVersion uint32) error {
	// Note: editing mention metadata does NOT re-trigger notification evaluation.
	// The notification service only processes EVENT_TYPE_MESSAGE_CREATE events.
	return s.session.Query(
		`UPDATE messages SET encrypted_content = ?, mentioned_user_ids = ?, mentioned_role_ids = ?, mention_everyone = ?, edited_at = ?, key_version = ?
		 WHERE channel_id = ? AND message_id = ?`,
		encryptedContent, mentionedUserIDs, mentionedRoleIDs, mentionEveryone, editedAt, keyVersion, channelID, messageID,
	).Consistency(gocql.One).Exec()
}

func (s *MessageStore) DeleteMessage(_ context.Context, channelID, messageID string) error {
	return s.session.Query(
		`UPDATE messages SET deleted = true, encrypted_content = ?, attachment_ids = ?
		 WHERE channel_id = ? AND message_id = ?`,
		deletedContentSentinel, []string{}, channelID, messageID,
	).Consistency(gocql.One).Exec()
}

func (s *MessageStore) BulkDeleteMessages(_ context.Context, channelID string, messageIDs []string) error {
	if len(messageIDs) == 0 {
		return nil
	}

	batch := s.session.NewBatch(gocql.LoggedBatch)
	for _, id := range messageIDs {
		batch.Query(
			`UPDATE messages SET deleted = true, encrypted_content = ?
			 WHERE channel_id = ? AND message_id = ?`,
			deletedContentSentinel, channelID, id,
		)
	}
	return s.session.ExecuteBatch(batch)
}

func (s *MessageStore) GetMessages(ctx context.Context, channelID string, opts GetMessagesOpts) ([]*models.Message, bool, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = defaultMessageLimit
	}
	if limit > maxMessageLimit {
		limit = maxMessageLimit
	}

	var messages []*models.Message

	switch {
	case opts.Around != "":
		halfLimit := limit / 2
		if halfLimit < 1 {
			halfLimit = 1
		}

		var beforeMsgs, afterMsgs []*models.Message
		g, gctx := errgroup.WithContext(ctx)

		g.Go(func() error {
			// Messages <= target (native DESC order, includes target)
			msgs, err := s.scanMessages(gctx,
				`SELECT channel_id, message_id, author_id, encrypted_content, attachment_ids, reply_to_id, mentioned_user_ids, mentioned_role_ids, mention_everyone, created_at, edited_at, deleted, key_version
				 FROM messages WHERE channel_id = ? AND message_id <= ? LIMIT ?`,
				channelID, opts.Around, halfLimit+1,
			)
			if err != nil {
				return err
			}
			beforeMsgs = msgs
			return nil
		})

		g.Go(func() error {
			// Messages > target (reverse scan, ASC)
			msgs, err := s.scanMessages(gctx,
				`SELECT channel_id, message_id, author_id, encrypted_content, attachment_ids, reply_to_id, mentioned_user_ids, mentioned_role_ids, mention_everyone, created_at, edited_at, deleted, key_version
				 FROM messages WHERE channel_id = ? AND message_id > ? ORDER BY message_id ASC LIMIT ?`,
				channelID, opts.Around, halfLimit,
			)
			if err != nil {
				return err
			}
			afterMsgs = msgs
			return nil
		})

		if err := g.Wait(); err != nil {
			return nil, false, fmt.Errorf("around query: %w", err)
		}

		// beforeMsgs is in DESC order; reverse to ASC, then append afterMsgs (already ASC)
		slices.Reverse(beforeMsgs)
		messages = append(beforeMsgs, afterMsgs...)

	case opts.Before != "":
		msgs, err := s.scanMessages(ctx,
			`SELECT channel_id, message_id, author_id, encrypted_content, attachment_ids, reply_to_id, mentioned_user_ids, mentioned_role_ids, mention_everyone, created_at, edited_at, deleted, key_version
			 FROM messages WHERE channel_id = ? AND message_id < ? LIMIT ?`,
			channelID, opts.Before, limit,
		)
		if err != nil {
			return nil, false, fmt.Errorf("query messages: %w", err)
		}
		// Native DESC → reverse to ASC (oldest first)
		slices.Reverse(msgs)
		messages = msgs

	case opts.After != "":
		msgs, err := s.scanMessages(ctx,
			`SELECT channel_id, message_id, author_id, encrypted_content, attachment_ids, reply_to_id, mentioned_user_ids, mentioned_role_ids, mention_everyone, created_at, edited_at, deleted, key_version
			 FROM messages WHERE channel_id = ? AND message_id > ? ORDER BY message_id ASC LIMIT ?`,
			channelID, opts.After, limit,
		)
		if err != nil {
			return nil, false, fmt.Errorf("query messages: %w", err)
		}
		// Already ASC from query — no reversal needed
		messages = msgs

	default:
		msgs, err := s.scanMessages(ctx,
			`SELECT channel_id, message_id, author_id, encrypted_content, attachment_ids, reply_to_id, mentioned_user_ids, mentioned_role_ids, mention_everyone, created_at, edited_at, deleted, key_version
			 FROM messages WHERE channel_id = ? LIMIT ?`,
			channelID, limit,
		)
		if err != nil {
			return nil, false, fmt.Errorf("query messages: %w", err)
		}
		// Native DESC → reverse to ASC (oldest first)
		slices.Reverse(msgs)
		messages = msgs
	}

	// Count total before filtering for has_more calculation
	totalFetched := len(messages)

	// Filter out soft-deleted messages in application code.
	// Do NOT use ALLOW FILTERING in CQL — it causes full partition scans.
	messages = slices.DeleteFunc(messages, func(m *models.Message) bool {
		return m.Deleted
	})

	// has_more: for around, means more messages exist before the window;
	// for before/default, means more messages exist (fetched == limit).
	hasMore := totalFetched >= limit

	return messages, hasMore, nil
}

// scanMessages executes a CQL query and scans the results into a slice.
func (s *MessageStore) scanMessages(_ context.Context, cql string, args ...any) ([]*models.Message, error) {
	iter := s.session.Query(cql, args...).Consistency(gocql.One).Iter()
	var messages []*models.Message
	var msg models.Message
	for iter.Scan(
		&msg.ChannelID, &msg.MessageID, &msg.AuthorID,
		&msg.EncryptedContent, &msg.AttachmentIDs,
		&msg.ReplyToID, &msg.MentionedUserIDs, &msg.MentionedRoleIDs, &msg.MentionEveryone,
		&msg.CreatedAt, &msg.EditedAt, &msg.Deleted, &msg.KeyVersion,
	) {
		m := msg
		messages = append(messages, &m)
		msg = models.Message{}
	}
	if err := iter.Close(); err != nil {
		return nil, err
	}
	return messages, nil
}

func (s *MessageStore) CountMessagesAfter(_ context.Context, channelID, afterMessageID string) (int32, error) {
	iter := s.session.Query(
		`SELECT message_id FROM meza.messages
		 WHERE channel_id = ? AND message_id > ?
		 ORDER BY message_id ASC
		 LIMIT 1000`,
		channelID, afterMessageID,
	).Consistency(gocql.One).Iter()

	var count int32
	var messageID string
	for iter.Scan(&messageID) {
		count++
	}
	if err := iter.Close(); err != nil {
		return 0, fmt.Errorf("counting messages after %s: %w", afterMessageID, err)
	}
	return count, nil
}

func (s *MessageStore) GetMessagesByIDs(_ context.Context, channelID string, messageIDs []string) (map[string]*models.Message, error) {
	if len(messageIDs) == 0 {
		return map[string]*models.Message{}, nil
	}

	// Single-partition IN query -- efficient in ScyllaDB.
	iter := s.session.Query(
		`SELECT channel_id, message_id, author_id, encrypted_content,
		        attachment_ids, reply_to_id, mentioned_user_ids, mentioned_role_ids, mention_everyone,
		        created_at, edited_at, deleted, key_version
		 FROM messages WHERE channel_id = ? AND message_id IN ?`,
		channelID, messageIDs,
	).Consistency(gocql.One).Iter()

	result := make(map[string]*models.Message, len(messageIDs))
	var msg models.Message
	for iter.Scan(
		&msg.ChannelID, &msg.MessageID, &msg.AuthorID,
		&msg.EncryptedContent, &msg.AttachmentIDs,
		&msg.ReplyToID, &msg.MentionedUserIDs, &msg.MentionedRoleIDs, &msg.MentionEveryone,
		&msg.CreatedAt, &msg.EditedAt, &msg.Deleted, &msg.KeyVersion,
	) {
		m := msg
		result[m.MessageID] = &m
		msg = models.Message{}
	}
	if err := iter.Close(); err != nil {
		return nil, fmt.Errorf("query messages by IDs: %w", err)
	}
	return result, nil
}

func (s *MessageStore) InsertReplyIndex(_ context.Context, channelID, replyToID, messageID, authorID string, createdAt time.Time) error {
	return s.session.Query(
		`INSERT INTO message_replies (channel_id, reply_to_id, message_id, author_id, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		channelID, replyToID, messageID, authorID, createdAt,
	).Consistency(gocql.One).Exec()
}

func (s *MessageStore) DeleteReplyIndex(_ context.Context, channelID, replyToID, messageID string) error {
	return s.session.Query(
		`DELETE FROM message_replies WHERE channel_id = ? AND reply_to_id = ? AND message_id = ?`,
		channelID, replyToID, messageID,
	).Consistency(gocql.One).Exec()
}

const (
	defaultReplyLimit = 50
	maxReplyLimit     = 50
)

func (s *MessageStore) GetReplies(_ context.Context, channelID, messageID string, limit int) ([]*models.ReplyEntry, int, error) {
	if limit <= 0 {
		limit = defaultReplyLimit
	}
	if limit > maxReplyLimit {
		limit = maxReplyLimit
	}

	// Count total replies in the partition (cheap single-partition query).
	var totalCount int
	if err := s.session.Query(
		`SELECT COUNT(*) FROM message_replies WHERE channel_id = ? AND reply_to_id = ?`,
		channelID, messageID,
	).Consistency(gocql.One).Scan(&totalCount); err != nil {
		return nil, 0, fmt.Errorf("counting replies: %w", err)
	}

	// Fetch reply entries up to limit.
	iter := s.session.Query(
		`SELECT message_id, author_id, created_at
		 FROM message_replies WHERE channel_id = ? AND reply_to_id = ? LIMIT ?`,
		channelID, messageID, limit,
	).Consistency(gocql.One).Iter()

	var entries []*models.ReplyEntry
	var entry models.ReplyEntry
	for iter.Scan(&entry.MessageID, &entry.AuthorID, &entry.CreatedAt) {
		e := entry
		entries = append(entries, &e)
		entry = models.ReplyEntry{}
	}
	if err := iter.Close(); err != nil {
		return nil, 0, fmt.Errorf("querying replies: %w", err)
	}

	return entries, totalCount, nil
}
