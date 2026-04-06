package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"google.golang.org/protobuf/proto"

	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/store"
	"github.com/mezalabs/meza/internal/subjects"
)

const (
	webhookRateLimitPerMinute = 30
	webhookMaxEmbeds          = 10
	webhookMaxEmbedFields     = 25
	webhookMaxTitleLen         = 256
	webhookMaxDescriptionLen   = 4096
	webhookMaxFieldNameLen     = 256
	webhookMaxFieldValueLen    = 1024
	webhookMaxBodySize         = maxEncryptedContentSize // 64KB, same as messages
	webhookDeliveryKeepCount   = 25
	webhookMaxAuthorNameLen    = 256
)

// webhookExecuteRequest is the JSON body of a webhook POST.
type webhookExecuteRequest struct {
	Content   string         `json:"content"`
	Username  string         `json:"username,omitempty"`
	AvatarURL string         `json:"avatar_url,omitempty"`
	Embeds    []webhookEmbed `json:"embeds,omitempty"`
}

type webhookEmbed struct {
	Title       string              `json:"title,omitempty"`
	Description string              `json:"description,omitempty"`
	URL         string              `json:"url,omitempty"`
	Color       *uint32             `json:"color,omitempty"` // nil = no color, 0 = black
	Author      *webhookEmbedAuthor `json:"author,omitempty"`
	Fields      []webhookEmbedField `json:"fields,omitempty"`
}

type webhookEmbedAuthor struct {
	Name    string `json:"name"`
	IconURL string `json:"icon_url,omitempty"`
	URL     string `json:"url,omitempty"`
}

type webhookEmbedField struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Inline bool   `json:"inline,omitempty"`
}

// webhookMessageContent is the JSON stored in encrypted_content for webhook messages.
type webhookMessageContent struct {
	WebhookID   string         `json:"webhook_id"`
	WebhookName string         `json:"webhook_name"`
	Username    string         `json:"username,omitempty"`
	AvatarURL   string         `json:"avatar_url,omitempty"`
	Content     string         `json:"content,omitempty"`
	Embeds      []webhookEmbed `json:"embeds,omitempty"`
}

// handleWebhookExecute handles POST /webhooks/{webhookID}/{token}.
func (s *chatService) handleWebhookExecute(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	if r.Method != http.MethodPost {
		writeWebhookError(w, http.StatusMethodNotAllowed, "method_not_allowed", "only POST is allowed")
		return
	}

	// Parse URL: /webhooks/{webhookID}/{token}
	path := strings.TrimPrefix(r.URL.Path, "/webhooks/")
	parts := strings.SplitN(path, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		writeWebhookError(w, http.StatusNotFound, "not_found", "invalid webhook URL")
		return
	}
	webhookID, submittedToken := parts[0], parts[1]
	sourceIP := webhookClientIP(r)

	// Look up webhook (including token hash for validation).
	webhook, err := s.webhookStore.GetWebhookWithToken(r.Context(), webhookID)
	if err != nil {
		if err == store.ErrNotFound {
			writeWebhookError(w, http.StatusNotFound, "webhook_not_found", "webhook not found")
			return
		}
		slog.Error("webhook execute: get webhook", "err", err, "webhook_id", webhookID)
		writeWebhookError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}

	// Validate token (timing-attack safe).
	submittedHash := store.HashWebhookToken(submittedToken)
	if subtle.ConstantTimeCompare(submittedHash, webhook.TokenHash) != 1 {
		writeWebhookError(w, http.StatusUnauthorized, "invalid_token", "invalid webhook token")
		return
	}

	// Per-webhook rate limit via Redis.
	rateKey := fmt.Sprintf("webhook_rate:%s", webhookID)
	rateLimitScript := `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`
	count, rateErr := s.rdb.Eval(r.Context(), rateLimitScript, []string{rateKey}, 60).Int64()
	if rateErr != nil {
		slog.Warn("webhook rate limit check failed, allowing", "key", rateKey, "err", rateErr)
	} else if count > webhookRateLimitPerMinute {
		s.logDelivery(r.Context(), webhookID, false, "rate_limited", "", sourceIP, "", time.Since(start))
		w.Header().Set("Retry-After", "60")
		writeWebhookError(w, http.StatusTooManyRequests, "rate_limited", "rate limit exceeded (30 per minute)")
		return
	}

	// Read and parse body.
	body, err := io.ReadAll(io.LimitReader(r.Body, webhookMaxBodySize+1))
	if err != nil {
		slog.Error("webhook execute: read body", "err", err)
		writeWebhookError(w, http.StatusInternalServerError, "internal_error", "failed to read body")
		return
	}
	if len(body) > webhookMaxBodySize {
		s.logDelivery(r.Context(), webhookID, false, "payload_too_large", truncateString(string(body), 500), sourceIP, "", time.Since(start))
		writeWebhookError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "request body exceeds 64KB")
		return
	}

	var req webhookExecuteRequest
	if err := json.Unmarshal(body, &req); err != nil {
		s.logDelivery(r.Context(), webhookID, false, "invalid_payload", truncateString(string(body), 500), sourceIP, "", time.Since(start))
		writeWebhookError(w, http.StatusBadRequest, "invalid_payload", "invalid JSON body")
		return
	}

	// Validate: need at least content or one embed.
	if strings.TrimSpace(req.Content) == "" && len(req.Embeds) == 0 {
		s.logDelivery(r.Context(), webhookID, false, "invalid_payload", truncateString(string(body), 500), sourceIP, "", time.Since(start))
		writeWebhookError(w, http.StatusBadRequest, "invalid_payload", "content or at least one embed is required")
		return
	}

	if err := validateWebhookPayload(&req); err != nil {
		s.logDelivery(r.Context(), webhookID, false, "invalid_payload", truncateString(string(body), 500), sourceIP, "", time.Since(start))
		writeWebhookError(w, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}

	// Build webhook message content.
	username := req.Username
	if username == "" {
		username = webhook.Name
	}
	avatarURL := req.AvatarURL
	if avatarURL == "" {
		avatarURL = webhook.AvatarURL
	}

	msgContent := webhookMessageContent{
		WebhookID:   webhook.ID,
		WebhookName: webhook.Name,
		Username:    username,
		AvatarURL:   avatarURL,
		Content:     req.Content,
		Embeds:      req.Embeds,
	}

	contentBytes, err := json.Marshal(msgContent)
	if err != nil {
		slog.Error("webhook execute: marshal content", "err", err)
		writeWebhookError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}

	// Create message.
	msg := &models.Message{
		ChannelID:        webhook.ChannelID,
		MessageID:        models.NewID(),
		AuthorID:         webhook.ID, // webhook ID as author — client detects via type=6
		EncryptedContent: contentBytes,
		KeyVersion:       0, // unencrypted
		Type:             6, // MESSAGE_TYPE_WEBHOOK
		CreatedAt:        time.Now(),
	}

	if err := s.messageStore.InsertMessage(r.Context(), msg); err != nil {
		slog.Error("webhook execute: insert message", "err", err)
		s.logDelivery(r.Context(), webhookID, false, "internal_error", truncateString(string(body), 500), sourceIP, "", time.Since(start))
		writeWebhookError(w, http.StatusInternalServerError, "internal_error", "failed to create message")
		return
	}

	// Publish to NATS for real-time delivery.
	event := &v1.Event{
		Type: v1.EventType_EVENT_TYPE_MESSAGE_CREATE,
		Payload: &v1.Event_MessageCreate{
			MessageCreate: messageToProto(msg, nil),
		},
	}
	eventBytes, err := proto.Marshal(event)
	if err != nil {
		slog.Error("webhook execute: marshal event", "err", err)
	} else if err := s.nc.Publish(subjects.DeliverChannel(webhook.ChannelID), eventBytes); err != nil {
		slog.Error("webhook execute: publish event", "err", err)
	}

	// Log successful delivery.
	s.logDelivery(r.Context(), webhookID, true, "", truncateString(string(body), 500), sourceIP, msg.MessageID, time.Since(start))

	// Return success.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"message_id": msg.MessageID,
		"created_at": msg.CreatedAt.Format(time.RFC3339Nano),
	})
}

func (s *chatService) logDelivery(ctx context.Context, webhookID string, success bool, errorCode, bodyPreview, sourceIP, messageID string, latency time.Duration) {
	delivery := &models.WebhookDelivery{
		ID:                 models.NewID(),
		WebhookID:          webhookID,
		Success:            success,
		ErrorCode:          errorCode,
		RequestBodyPreview: bodyPreview,
		MessageID:          messageID,
		SourceIP:           sourceIP,
		LatencyMs:          int(latency.Milliseconds()),
		CreatedAt:          time.Now(),
	}
	if err := s.webhookStore.InsertDelivery(ctx, delivery); err != nil {
		slog.Warn("failed to log webhook delivery", "err", err, "webhook_id", webhookID)
	}

	// Best-effort cleanup of old deliveries.
	go func() {
		cleanCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.webhookStore.CleanupOldDeliveries(cleanCtx, webhookID, webhookDeliveryKeepCount); err != nil {
			slog.Warn("cleanup old deliveries", "err", err, "webhook_id", webhookID)
		}
	}()
}

// validateExternalURL validates that a URL is a well-formed HTTPS URL.
func validateExternalURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}
	if u.Scheme != "https" {
		return fmt.Errorf("must use HTTPS")
	}
	if u.Host == "" {
		return fmt.Errorf("missing host")
	}
	if u.User != nil {
		return fmt.Errorf("userinfo not allowed")
	}
	return nil
}

func validateWebhookPayload(req *webhookExecuteRequest) error {
	// Content length (use same limit as regular messages: count bytes, not runes).
	if len(req.Content) > maxEncryptedContentSize {
		return fmt.Errorf("content exceeds maximum length")
	}

	// Sanitize content.
	if strings.ContainsRune(req.Content, 0) {
		return fmt.Errorf("content contains invalid characters")
	}

	// Username validation.
	if req.Username != "" {
		if utf8.RuneCountInString(req.Username) > maxWebhookNameLen {
			return fmt.Errorf("username exceeds %d characters", maxWebhookNameLen)
		}
		if strings.ContainsRune(req.Username, 0) {
			return fmt.Errorf("username contains invalid characters")
		}
	}

	// Avatar URL validation.
	if req.AvatarURL != "" {
		if len(req.AvatarURL) > 2048 {
			return fmt.Errorf("avatar_url exceeds 2048 characters")
		}
		if err := validateExternalURL(req.AvatarURL); err != nil {
			return fmt.Errorf("avatar_url: %w", err)
		}
	}

	// Embeds validation.
	if len(req.Embeds) > webhookMaxEmbeds {
		return fmt.Errorf("maximum %d embeds allowed", webhookMaxEmbeds)
	}
	for i, embed := range req.Embeds {
		// Reject empty embeds.
		if embed.Title == "" && embed.Description == "" && embed.URL == "" && len(embed.Fields) == 0 {
			return fmt.Errorf("embed[%d] must have at least one of title, description, url, or fields", i)
		}

		// Null byte checks.
		if strings.ContainsRune(embed.Title, 0) {
			return fmt.Errorf("embed[%d].title contains invalid characters", i)
		}
		if strings.ContainsRune(embed.Description, 0) {
			return fmt.Errorf("embed[%d].description contains invalid characters", i)
		}
		if strings.ContainsRune(embed.URL, 0) {
			return fmt.Errorf("embed[%d].url contains invalid characters", i)
		}

		if utf8.RuneCountInString(embed.Title) > webhookMaxTitleLen {
			return fmt.Errorf("embed[%d].title exceeds %d characters", i, webhookMaxTitleLen)
		}
		if utf8.RuneCountInString(embed.Description) > webhookMaxDescriptionLen {
			return fmt.Errorf("embed[%d].description exceeds %d characters", i, webhookMaxDescriptionLen)
		}
		if embed.URL != "" {
			if len(embed.URL) > 2048 {
				return fmt.Errorf("embed[%d].url exceeds 2048 characters", i)
			}
			if err := validateExternalURL(embed.URL); err != nil {
				return fmt.Errorf("embed[%d].url: %w", i, err)
			}
		}
		if embed.Color != nil && *embed.Color > 0xFFFFFF {
			return fmt.Errorf("embed[%d].color must be a 24-bit RGB value", i)
		}

		// Author validation.
		if embed.Author != nil {
			if embed.Author.Name == "" {
				return fmt.Errorf("embed[%d].author.name is required", i)
			}
			if utf8.RuneCountInString(embed.Author.Name) > webhookMaxAuthorNameLen {
				return fmt.Errorf("embed[%d].author.name exceeds %d characters", i, webhookMaxAuthorNameLen)
			}
			if strings.ContainsRune(embed.Author.Name, 0) {
				return fmt.Errorf("embed[%d].author.name contains invalid characters", i)
			}
			if embed.Author.IconURL != "" {
				if len(embed.Author.IconURL) > 2048 {
					return fmt.Errorf("embed[%d].author.icon_url exceeds 2048 characters", i)
				}
				if strings.ContainsRune(embed.Author.IconURL, 0) {
					return fmt.Errorf("embed[%d].author.icon_url contains invalid characters", i)
				}
				if err := validateExternalURL(embed.Author.IconURL); err != nil {
					return fmt.Errorf("embed[%d].author.icon_url: %w", i, err)
				}
			}
			if embed.Author.URL != "" {
				if len(embed.Author.URL) > 2048 {
					return fmt.Errorf("embed[%d].author.url exceeds 2048 characters", i)
				}
				if strings.ContainsRune(embed.Author.URL, 0) {
					return fmt.Errorf("embed[%d].author.url contains invalid characters", i)
				}
				if err := validateExternalURL(embed.Author.URL); err != nil {
					return fmt.Errorf("embed[%d].author.url: %w", i, err)
				}
			}
		}

		if len(embed.Fields) > webhookMaxEmbedFields {
			return fmt.Errorf("embed[%d] exceeds maximum %d fields", i, webhookMaxEmbedFields)
		}
		for j, field := range embed.Fields {
			if field.Name == "" {
				return fmt.Errorf("embed[%d].fields[%d].name is required", i, j)
			}
			if strings.ContainsRune(field.Name, 0) {
				return fmt.Errorf("embed[%d].fields[%d].name contains invalid characters", i, j)
			}
			if strings.ContainsRune(field.Value, 0) {
				return fmt.Errorf("embed[%d].fields[%d].value contains invalid characters", i, j)
			}
			if utf8.RuneCountInString(field.Name) > webhookMaxFieldNameLen {
				return fmt.Errorf("embed[%d].fields[%d].name exceeds %d characters", i, j, webhookMaxFieldNameLen)
			}
			if utf8.RuneCountInString(field.Value) > webhookMaxFieldValueLen {
				return fmt.Errorf("embed[%d].fields[%d].value exceeds %d characters", i, j, webhookMaxFieldValueLen)
			}
		}
	}

	return nil
}

func writeWebhookError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{
		"code":    code,
		"message": message,
	})
}

func webhookClientIP(r *http.Request) string {
	if cfIP := r.Header.Get("CF-Connecting-IP"); cfIP != "" {
		if parsed := net.ParseIP(strings.TrimSpace(cfIP)); parsed != nil {
			return parsed.String()
		}
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if comma := strings.IndexByte(xff, ','); comma != -1 {
			xff = xff[:comma]
		}
		if parsed := net.ParseIP(strings.TrimSpace(xff)); parsed != nil {
			return parsed.String()
		}
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if ip == "" {
		ip = r.RemoteAddr
	}
	return ip
}

func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}
