package search

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/meilisearch/meilisearch-go"
	"github.com/oklog/ulid/v2"
)

const (
	MessagesIndex = "messages"
	DefaultLimit  = 25
	MaxLimit      = 100
)

// MessageDocument represents a message in the Meilisearch index.
// E2EE: only metadata is indexed — encrypted content never touches the search backend.
type MessageDocument struct {
	ID               string   `json:"id"`
	ChannelID        string   `json:"channel_id"`
	ServerID         string   `json:"server_id"`
	AuthorID         string   `json:"author_id"`
	CreatedAt        int64    `json:"created_at"`
	HasAttachment    bool     `json:"has_attachment"`
	MentionedUserIDs []string `json:"mentioned_user_ids"`
}

// Client wraps the Meilisearch client with message-specific helpers.
type Client struct {
	meili meilisearch.ServiceManager
}

// NewClient creates a Meilisearch client and configures the messages index.
func NewClient(host, apiKey string) (*Client, error) {
	meili := meilisearch.New(host, meilisearch.WithAPIKey(apiKey))

	c := &Client{meili: meili}
	if err := c.ensureIndex(); err != nil {
		return nil, fmt.Errorf("configure meilisearch index: %w", err)
	}
	return c, nil
}

func (c *Client) ensureIndex() error {
	_, err := c.meili.GetIndex(MessagesIndex)
	if err != nil {
		task, createErr := c.meili.CreateIndex(&meilisearch.IndexConfig{
			Uid:        MessagesIndex,
			PrimaryKey: "id",
		})
		if createErr != nil {
			return fmt.Errorf("create index: %w", createErr)
		}
		if _, err := c.meili.WaitForTask(task.TaskUID, 100*time.Millisecond); err != nil {
			return fmt.Errorf("wait for index creation: %w", err)
		}
	}

	idx := c.meili.Index(MessagesIndex)

	filterAttrs := []interface{}{
		"channel_id", "server_id", "author_id", "has_attachment", "created_at", "mentioned_user_ids",
	}
	if _, err := idx.UpdateFilterableAttributes(&filterAttrs); err != nil {
		return fmt.Errorf("set filterable attributes: %w", err)
	}

	// E2EE: no content field — search filters on metadata only.
	searchAttrs := []string{"mentioned_user_ids"}
	if _, err := idx.UpdateSearchableAttributes(&searchAttrs); err != nil {
		return fmt.Errorf("set searchable attributes: %w", err)
	}

	sortAttrs := []string{"created_at"}
	if _, err := idx.UpdateSortableAttributes(&sortAttrs); err != nil {
		return fmt.Errorf("set sortable attributes: %w", err)
	}

	return nil
}

// IndexMessage adds or updates a message in the search index.
func (c *Client) IndexMessage(doc MessageDocument) {
	idx := c.meili.Index(MessagesIndex)
	if _, err := idx.AddDocuments([]MessageDocument{doc}, nil); err != nil {
		slog.Error("meilisearch index message", "err", err, "id", doc.ID)
	}
}

// UpdateMessage updates a message document in the index.
func (c *Client) UpdateMessage(doc MessageDocument) {
	idx := c.meili.Index(MessagesIndex)
	if _, err := idx.UpdateDocuments([]MessageDocument{doc}, nil); err != nil {
		slog.Error("meilisearch update message", "err", err, "id", doc.ID)
	}
}

// DeleteMessage removes a message from the search index.
func (c *Client) DeleteMessage(messageID string) {
	idx := c.meili.Index(MessagesIndex)
	if _, err := idx.DeleteDocument(messageID, nil); err != nil {
		slog.Error("meilisearch delete message", "err", err, "id", messageID)
	}
}

// DeleteChannelMessages removes all messages for a channel from the index.
func (c *Client) DeleteChannelMessages(channelID string) {
	idx := c.meili.Index(MessagesIndex)
	filter := fmt.Sprintf("channel_id = %q", channelID)
	if _, err := idx.DeleteDocumentsByFilter(filter, nil); err != nil {
		slog.Error("meilisearch delete channel messages", "err", err, "channel", channelID)
	}
}

// SearchResult holds a single search hit.
// E2EE: no content or highlighting — server only returns metadata matches.
type SearchResult struct {
	Doc MessageDocument
}

// SearchParams holds search query parameters.
type SearchParams struct {
	Query         string
	ServerID      string
	ChannelID     string
	AuthorID      string
	HasAttachment *bool
	Limit         int64
	BeforeID      string // ULID cursor for pagination — only return messages with ID < BeforeID
}

// Search queries the Meilisearch messages index.
func (c *Client) Search(params SearchParams) ([]SearchResult, int64, error) {
	if params.Limit <= 0 {
		params.Limit = DefaultLimit
	}
	if params.Limit > MaxLimit {
		params.Limit = MaxLimit
	}

	filters := buildFilters(params)

	req := &meilisearch.SearchRequest{
		Limit: params.Limit,
		Sort:  []string{"created_at:desc"},
	}
	if len(filters) > 0 {
		req.Filter = filters
	}

	idx := c.meili.Index(MessagesIndex)
	resp, err := idx.Search(params.Query, req)
	if err != nil {
		return nil, 0, fmt.Errorf("meilisearch search: %w", err)
	}

	results := make([]SearchResult, 0, len(resp.Hits))
	for _, hit := range resp.Hits {
		doc := MessageDocument{}
		getRawString(hit, "id", &doc.ID)
		getRawString(hit, "channel_id", &doc.ChannelID)
		getRawString(hit, "server_id", &doc.ServerID)
		getRawString(hit, "author_id", &doc.AuthorID)

		if raw, ok := hit["created_at"]; ok {
			json.Unmarshal(raw, &doc.CreatedAt)
		}
		if raw, ok := hit["has_attachment"]; ok {
			json.Unmarshal(raw, &doc.HasAttachment)
		}

		// Post-filter: exact ULID cursor enforcement. The Meilisearch
		// created_at filter is a coarse pre-filter; this handles same-
		// millisecond ordering by comparing ULID strings lexicographically.
		if params.BeforeID != "" && doc.ID >= params.BeforeID {
			continue
		}

		results = append(results, SearchResult{Doc: doc})
	}

	return results, resp.EstimatedTotalHits, nil
}

func buildFilters(params SearchParams) []string {
	var filters []string
	if params.ServerID != "" {
		filters = append(filters, fmt.Sprintf("server_id = %q", params.ServerID))
	}
	if params.ChannelID != "" {
		filters = append(filters, fmt.Sprintf("channel_id = %q", params.ChannelID))
	}
	if params.AuthorID != "" {
		filters = append(filters, fmt.Sprintf("author_id = %q", params.AuthorID))
	}
	if params.HasAttachment != nil {
		if *params.HasAttachment {
			filters = append(filters, "has_attachment = true")
		} else {
			filters = append(filters, "has_attachment = false")
		}
	}
	if params.BeforeID != "" {
		if id, err := ulid.ParseStrict(params.BeforeID); err == nil {
			// Use the ULID's embedded timestamp as a coarse Meilisearch filter.
			// created_at is stored as Unix millis. We use <= so same-millisecond
			// messages are included here; exact ULID ordering is enforced by
			// post-filtering in Search().
			filters = append(filters, fmt.Sprintf("created_at <= %d", int64(id.Time())))
		}
	}
	return filters
}

func getRawString(m map[string]json.RawMessage, key string, dst *string) {
	if raw, ok := m[key]; ok {
		json.Unmarshal(raw, dst)
	}
}
