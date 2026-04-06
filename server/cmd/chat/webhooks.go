package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/permissions"
	"github.com/mezalabs/meza/internal/store"
)

const (
	maxWebhooksPerChannel = 15
	maxWebhooksPerServer  = 50
	maxWebhookNameLen     = 80
)

func (s *chatService) CreateWebhook(ctx context.Context, req *connect.Request[v1.CreateWebhookRequest]) (*connect.Response[v1.CreateWebhookResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	if err := validateWebhookName(req.Msg.Name); err != nil {
		return nil, err
	}

	ch, err := s.chatStore.GetChannel(ctx, req.Msg.ChannelId)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
		}
		slog.Error("get channel for webhook", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Webhooks are only allowed on server text channels.
	if ch.ServerID == "" || ch.Type != 1 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("webhooks can only be created on server text channels"))
	}

	if err := s.requireMembership(ctx, userID, ch.ServerID); err != nil {
		return nil, err
	}

	perms, permErr := s.resolvePermissions(ctx, userID, ch.ServerID, ch.ID)
	if permErr != nil {
		return nil, permErr
	}
	if !permissions.Has(perms, permissions.ManageWebhooks) {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ManageWebhooks permission"))
	}

	// Enforce limits.
	channelCount, err := s.webhookStore.CountByChannel(ctx, ch.ID)
	if err != nil {
		slog.Error("count webhooks by channel", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if channelCount >= maxWebhooksPerChannel {
		return nil, connect.NewError(connect.CodeResourceExhausted, fmt.Errorf("maximum %d webhooks per channel", maxWebhooksPerChannel))
	}

	serverCount, err := s.webhookStore.CountByServer(ctx, ch.ServerID)
	if err != nil {
		slog.Error("count webhooks by server", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if serverCount >= maxWebhooksPerServer {
		return nil, connect.NewError(connect.CodeResourceExhausted, fmt.Errorf("maximum %d webhooks per server", maxWebhooksPerServer))
	}

	rawToken, tokenHash, err := store.GenerateWebhookToken()
	if err != nil {
		slog.Error("generate webhook token", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	var avatarURL string
	if req.Msg.AvatarUrl != nil {
		if err := validateWebhookAvatarURL(*req.Msg.AvatarUrl); err != nil {
			return nil, err
		}
		avatarURL = *req.Msg.AvatarUrl
	}

	now := time.Now()
	webhook := &models.Webhook{
		ID:        models.NewID(),
		ChannelID: ch.ID,
		ServerID:  ch.ServerID,
		Name:      req.Msg.Name,
		AvatarURL: avatarURL,
		TokenHash: tokenHash,
		CreatedBy: userID,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := s.webhookStore.CreateWebhook(ctx, webhook); err != nil {
		slog.Error("create webhook", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.CreateWebhookResponse{
		Webhook: webhookToProto(webhook),
		Token:   rawToken,
		Url:     fmt.Sprintf("/webhooks/%s/%s", webhook.ID, rawToken),
	}), nil
}

func (s *chatService) GetWebhook(ctx context.Context, req *connect.Request[v1.GetWebhookRequest]) (*connect.Response[v1.GetWebhookResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	webhook, err := s.webhookStore.GetWebhook(ctx, req.Msg.WebhookId)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("webhook not found"))
		}
		slog.Error("get webhook", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	if err := s.requireMembership(ctx, userID, webhook.ServerID); err != nil {
		return nil, err
	}

	perms, permErr := s.resolvePermissions(ctx, userID, webhook.ServerID, webhook.ChannelID)
	if permErr != nil {
		return nil, permErr
	}
	if !permissions.Has(perms, permissions.ManageWebhooks) {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ManageWebhooks permission"))
	}

	return connect.NewResponse(&v1.GetWebhookResponse{
		Webhook: webhookToProto(webhook),
	}), nil
}

func (s *chatService) UpdateWebhook(ctx context.Context, req *connect.Request[v1.UpdateWebhookRequest]) (*connect.Response[v1.UpdateWebhookResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	webhook, err := s.webhookStore.GetWebhook(ctx, req.Msg.WebhookId)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("webhook not found"))
		}
		slog.Error("get webhook for update", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	if err := s.requireMembership(ctx, userID, webhook.ServerID); err != nil {
		return nil, err
	}

	perms, permErr := s.resolvePermissions(ctx, userID, webhook.ServerID, webhook.ChannelID)
	if permErr != nil {
		return nil, permErr
	}
	if !permissions.Has(perms, permissions.ManageWebhooks) {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ManageWebhooks permission"))
	}

	if req.Msg.Name != nil {
		if err := validateWebhookName(*req.Msg.Name); err != nil {
			return nil, err
		}
	}
	if req.Msg.AvatarUrl != nil {
		if err := validateWebhookAvatarURL(*req.Msg.AvatarUrl); err != nil {
			return nil, err
		}
	}

	updated, err := s.webhookStore.UpdateWebhook(ctx, req.Msg.WebhookId, req.Msg.Name, req.Msg.AvatarUrl)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("webhook not found"))
		}
		slog.Error("update webhook", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.UpdateWebhookResponse{
		Webhook: webhookToProto(updated),
	}), nil
}

func (s *chatService) DeleteWebhook(ctx context.Context, req *connect.Request[v1.DeleteWebhookRequest]) (*connect.Response[v1.DeleteWebhookResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	webhook, err := s.webhookStore.GetWebhook(ctx, req.Msg.WebhookId)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("webhook not found"))
		}
		slog.Error("get webhook for delete", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	if err := s.requireMembership(ctx, userID, webhook.ServerID); err != nil {
		return nil, err
	}

	perms, permErr := s.resolvePermissions(ctx, userID, webhook.ServerID, webhook.ChannelID)
	if permErr != nil {
		return nil, permErr
	}
	if !permissions.Has(perms, permissions.ManageWebhooks) {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ManageWebhooks permission"))
	}

	if err := s.webhookStore.DeleteWebhook(ctx, req.Msg.WebhookId); err != nil {
		slog.Error("delete webhook", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.DeleteWebhookResponse{}), nil
}

func (s *chatService) ListChannelWebhooks(ctx context.Context, req *connect.Request[v1.ListChannelWebhooksRequest]) (*connect.Response[v1.ListChannelWebhooksResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	ch, err := s.chatStore.GetChannel(ctx, req.Msg.ChannelId)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
		}
		slog.Error("get channel for webhook list", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	if ch.ServerID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("webhooks are not available for DM channels"))
	}

	if err := s.requireMembership(ctx, userID, ch.ServerID); err != nil {
		return nil, err
	}

	perms, permErr := s.resolvePermissions(ctx, userID, ch.ServerID, ch.ID)
	if permErr != nil {
		return nil, permErr
	}
	if !permissions.Has(perms, permissions.ManageWebhooks) {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ManageWebhooks permission"))
	}

	webhooks, err := s.webhookStore.ListByChannel(ctx, ch.ID)
	if err != nil {
		slog.Error("list channel webhooks", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.ListChannelWebhooksResponse{
		Webhooks: webhooksToProto(webhooks),
	}), nil
}

func (s *chatService) ListServerWebhooks(ctx context.Context, req *connect.Request[v1.ListServerWebhooksRequest]) (*connect.Response[v1.ListServerWebhooksResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}

	// Server-level listing requires ManageWebhooks at the server level (no channel).
	perms, permErr := s.resolvePermissions(ctx, userID, req.Msg.ServerId, "")
	if permErr != nil {
		return nil, permErr
	}
	if !permissions.Has(perms, permissions.ManageWebhooks) {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ManageWebhooks permission"))
	}

	webhooks, err := s.webhookStore.ListByServer(ctx, req.Msg.ServerId)
	if err != nil {
		slog.Error("list server webhooks", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.ListServerWebhooksResponse{
		Webhooks: webhooksToProto(webhooks),
	}), nil
}

func (s *chatService) RegenerateWebhookToken(ctx context.Context, req *connect.Request[v1.RegenerateWebhookTokenRequest]) (*connect.Response[v1.RegenerateWebhookTokenResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	webhook, err := s.webhookStore.GetWebhook(ctx, req.Msg.WebhookId)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("webhook not found"))
		}
		slog.Error("get webhook for token regen", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	if err := s.requireMembership(ctx, userID, webhook.ServerID); err != nil {
		return nil, err
	}

	perms, permErr := s.resolvePermissions(ctx, userID, webhook.ServerID, webhook.ChannelID)
	if permErr != nil {
		return nil, permErr
	}
	if !permissions.Has(perms, permissions.ManageWebhooks) {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ManageWebhooks permission"))
	}

	rawToken, tokenHash, err := store.GenerateWebhookToken()
	if err != nil {
		slog.Error("generate webhook token", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	if err := s.webhookStore.UpdateTokenHash(ctx, req.Msg.WebhookId, tokenHash); err != nil {
		slog.Error("update token hash", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.RegenerateWebhookTokenResponse{
		Token: rawToken,
		Url:   fmt.Sprintf("/webhooks/%s/%s", webhook.ID, rawToken),
	}), nil
}

func (s *chatService) ListWebhookDeliveries(ctx context.Context, req *connect.Request[v1.ListWebhookDeliveriesRequest]) (*connect.Response[v1.ListWebhookDeliveriesResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	webhook, err := s.webhookStore.GetWebhook(ctx, req.Msg.WebhookId)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("webhook not found"))
		}
		slog.Error("get webhook for deliveries", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	if err := s.requireMembership(ctx, userID, webhook.ServerID); err != nil {
		return nil, err
	}

	perms, permErr := s.resolvePermissions(ctx, userID, webhook.ServerID, webhook.ChannelID)
	if permErr != nil {
		return nil, permErr
	}
	if !permissions.Has(perms, permissions.ManageWebhooks) {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ManageWebhooks permission"))
	}

	limit := int(req.Msg.Limit)
	if limit <= 0 || limit > 25 {
		limit = 25
	}

	deliveries, err := s.webhookStore.ListDeliveries(ctx, webhook.ID, limit)
	if err != nil {
		slog.Error("list webhook deliveries", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoDeliveries := make([]*v1.WebhookDelivery, len(deliveries))
	for i, d := range deliveries {
		protoDeliveries[i] = &v1.WebhookDelivery{
			Id:                 d.ID,
			WebhookId:          d.WebhookID,
			Success:            d.Success,
			ErrorCode:          d.ErrorCode,
			RequestBodyPreview: d.RequestBodyPreview,
			MessageId:          d.MessageID,
			SourceIp:           d.SourceIP,
			LatencyMs:          int32(d.LatencyMs),
			CreatedAt:          timestamppb.New(d.CreatedAt),
		}
	}

	return connect.NewResponse(&v1.ListWebhookDeliveriesResponse{
		Deliveries: protoDeliveries,
	}), nil
}

// --- Helpers ---

func webhookToProto(w *models.Webhook) *v1.Webhook {
	return &v1.Webhook{
		Id:        w.ID,
		ChannelId: w.ChannelID,
		ServerId:  w.ServerID,
		Name:      w.Name,
		AvatarUrl: w.AvatarURL,
		CreatedBy: w.CreatedBy,
		CreatedAt: timestamppb.New(w.CreatedAt),
		UpdatedAt: timestamppb.New(w.UpdatedAt),
	}
}

func webhooksToProto(webhooks []*models.Webhook) []*v1.Webhook {
	result := make([]*v1.Webhook, len(webhooks))
	for i, w := range webhooks {
		result[i] = webhookToProto(w)
	}
	return result
}

func validateWebhookName(name string) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("name is required"))
	}
	if utf8.RuneCountInString(trimmed) > maxWebhookNameLen {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("name exceeds %d characters", maxWebhookNameLen))
	}
	if strings.ContainsRune(name, 0) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("name contains invalid characters"))
	}
	if strings.Contains(name, "<") && strings.Contains(name, ">") {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("name contains invalid characters"))
	}
	return nil
}

func validateWebhookAvatarURL(url string) error {
	if url == "" {
		return nil
	}
	if len(url) > 2048 {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("avatar URL exceeds 2048 characters"))
	}
	if !strings.HasPrefix(url, "https://") {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("avatar URL must use HTTPS"))
	}
	return nil
}
