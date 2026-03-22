package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/permissions"
	"github.com/mezalabs/meza/internal/subjects"
)

const maxBotsPerUser = 25

var botUsernameRe = regexp.MustCompile(`^[a-zA-Z0-9_]{2,32}$`)

func botToProto(u *models.User) *v1.Bot {
	return &v1.Bot{
		Id:          u.ID,
		Username:    u.Username,
		DisplayName: u.DisplayName,
		AvatarUrl:   u.AvatarURL,
		OwnerId:     u.BotOwnerID,
		CreatedAt:   timestamppb.New(u.CreatedAt),
		Description: u.BotDescription,
	}
}

func botInviteToProto(inv *models.BotInvite) *v1.BotInvite {
	return &v1.BotInvite{
		Code:                 inv.Code,
		BotId:                inv.BotID,
		RequestedPermissions: inv.RequestedPermissions,
		CreatorId:            inv.CreatorID,
		CreatedAt:            timestamppb.New(inv.CreatedAt),
		ExpiresAt:            timestamppb.New(inv.ExpiresAt),
	}
}

const maxInvitesPerBot = 10

func (s *chatService) CreateBot(ctx context.Context, req *connect.Request[v1.CreateBotRequest]) (*connect.Response[v1.CreateBotResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	username := strings.TrimSpace(req.Msg.Username)
	displayName := strings.TrimSpace(req.Msg.DisplayName)
	if username == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("username is required"))
	}
	if !botUsernameRe.MatchString(username) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("username must be 2-32 alphanumeric or underscore characters"))
	}
	if displayName == "" {
		displayName = username
	}
	if len(displayName) > 100 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("display_name must be 100 characters or fewer"))
	}

	// Check bot limit.
	count, err := s.botStore.CountBotsByOwner(ctx, userID)
	if err != nil {
		slog.Error("counting bots", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if count >= maxBotsPerUser {
		return nil, connect.NewError(connect.CodeResourceExhausted, fmt.Errorf("maximum of %d bots per user", maxBotsPerUser))
	}

	// Generate Ed25519 keypair for the bot.
	pubKey, privKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		slog.Error("generating bot keypair", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	now := time.Now()
	botUser := &models.User{
		ID:          models.NewID(),
		Email:       fmt.Sprintf("bot+%s@meza.local", models.NewID()), // synthetic email for uniqueness
		Username:    username,
		DisplayName: displayName,
		IsBot:       true,
		BotOwnerID:  userID,
		CreatedAt:   now,
	}

	_, err = s.botStore.CreateBotUser(ctx, botUser, pubKey)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique") {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("username already taken"))
		}
		slog.Error("creating bot user", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Generate API token.
	token, tokenHash, err := auth.GenerateBotToken()
	if err != nil {
		slog.Error("generating bot token", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	botToken := &models.BotToken{
		ID:        models.NewID(),
		BotUserID: botUser.ID,
		TokenHash: tokenHash,
		CreatedAt: now,
	}
	if err := s.botStore.CreateBotToken(ctx, botToken); err != nil {
		slog.Error("creating bot token", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.CreateBotResponse{
		Bot: &v1.BotWithToken{
			Bot:        botToProto(botUser),
			Token:      token,
			PrivateKey: privKey.Seed(), // 32-byte Ed25519 seed
		},
	}), nil
}

func (s *chatService) DeleteBot(ctx context.Context, req *connect.Request[v1.DeleteBotRequest]) (*connect.Response[v1.DeleteBotResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.BotId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("bot_id is required"))
	}

	bot, err := s.botStore.GetBotUser(ctx, req.Msg.BotId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("bot not found"))
	}
	if bot.BotOwnerID != userID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("you do not own this bot"))
	}

	// Delete the bot user (cascades to tokens, webhooks, members).
	if err := s.botStore.DeleteBotUser(ctx, req.Msg.BotId); err != nil {
		slog.Error("deleting bot", "err", err, "bot", req.Msg.BotId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.DeleteBotResponse{}), nil
}

func (s *chatService) RegenerateBotToken(ctx context.Context, req *connect.Request[v1.RegenerateBotTokenRequest]) (*connect.Response[v1.RegenerateBotTokenResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.BotId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("bot_id is required"))
	}

	bot, err := s.botStore.GetBotUser(ctx, req.Msg.BotId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("bot not found"))
	}
	if bot.BotOwnerID != userID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("you do not own this bot"))
	}

	// Revoke all existing tokens.
	if err := s.botStore.RevokeBotTokens(ctx, req.Msg.BotId); err != nil {
		slog.Error("revoking bot tokens", "err", err, "bot", req.Msg.BotId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Broadcast cache invalidation to all services with bot token caches.
	s.nc.Publish(subjects.InternalBotTokenRevoke(req.Msg.BotId), nil)

	// Generate new token.
	token, tokenHash, err := auth.GenerateBotToken()
	if err != nil {
		slog.Error("generating new bot token", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	botToken := &models.BotToken{
		ID:        models.NewID(),
		BotUserID: req.Msg.BotId,
		TokenHash: tokenHash,
		CreatedAt: time.Now(),
	}
	if err := s.botStore.CreateBotToken(ctx, botToken); err != nil {
		slog.Error("creating new bot token", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.RegenerateBotTokenResponse{
		Token: token,
	}), nil
}

func (s *chatService) ListBots(ctx context.Context, req *connect.Request[v1.ListBotsRequest]) (*connect.Response[v1.ListBotsResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	bots, err := s.botStore.ListBotsByOwner(ctx, userID)
	if err != nil {
		slog.Error("listing bots", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	var protoBots []*v1.Bot
	for _, b := range bots {
		protoBots = append(protoBots, botToProto(b))
	}

	return connect.NewResponse(&v1.ListBotsResponse{
		Bots: protoBots,
	}), nil
}

func (s *chatService) GetBot(ctx context.Context, req *connect.Request[v1.GetBotRequest]) (*connect.Response[v1.GetBotResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.BotId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("bot_id is required"))
	}

	bot, err := s.botStore.GetBotUser(ctx, req.Msg.BotId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("bot not found"))
	}
	if bot.BotOwnerID != userID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("you do not own this bot"))
	}

	return connect.NewResponse(&v1.GetBotResponse{
		Bot: botToProto(bot),
	}), nil
}

func (s *chatService) AddBotToServer(ctx context.Context, req *connect.Request[v1.AddBotToServerRequest]) (*connect.Response[v1.AddBotToServerResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.BotId == "" || req.Msg.ServerId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("bot_id and server_id are required"))
	}

	// Verify caller has ManageServer permission.
	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}
	_, _, _, err := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.ManageBots)
	if err != nil {
		return nil, err
	}

	// Verify the bot exists.
	bot, err := s.botStore.GetBotUser(ctx, req.Msg.BotId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("bot not found"))
	}
	if !bot.IsBot {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user is not a bot"))
	}

	// Check if bot is banned.
	banned, err := s.banStore.IsBanned(ctx, req.Msg.ServerId, req.Msg.BotId)
	if err != nil {
		slog.Error("checking ban", "err", err, "bot", req.Msg.BotId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if banned {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("bot is banned from this server"))
	}

	// Check if already a member.
	isMember, err := s.chatStore.IsMember(ctx, req.Msg.BotId, req.Msg.ServerId)
	if err != nil {
		slog.Error("checking membership", "err", err, "bot", req.Msg.BotId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if isMember {
		return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("bot is already a member"))
	}

	// Add bot as member.
	if err := s.chatStore.AddMember(ctx, req.Msg.BotId, req.Msg.ServerId); err != nil {
		slog.Error("adding bot to server", "err", err, "bot", req.Msg.BotId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	now := time.Now()

	// Publish member join event.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_MEMBER_JOIN,
		Timestamp: timestamppb.New(now),
		Payload: &v1.Event_MemberJoin{
			MemberJoin: &v1.Member{
				UserId:        req.Msg.BotId,
				ServerId:      req.Msg.ServerId,
				JoinedAt:      timestamppb.New(now),
				InviterUserId: userID,
			},
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		if err := s.nc.Publish(subjects.ServerMember(req.Msg.ServerId), eventData); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.ServerMember(req.Msg.ServerId), "err", err)
		}
	}

	// Signal gateway to refresh the bot's channel subscriptions.
	s.nc.Publish(subjects.UserSubscription(req.Msg.BotId), nil)

	// Emit system message for bot join.
	s.publishServerSystemMessage(ctx, req.Msg.ServerId,
		uint32(v1.MessageType_MESSAGE_TYPE_MEMBER_JOIN), "join",
		MemberEventContent{UserID: req.Msg.BotId},
		map[string]string{"user": bot.DisplayName},
	)

	return connect.NewResponse(&v1.AddBotToServerResponse{
		Member: &v1.Member{
			UserId:   req.Msg.BotId,
			ServerId: req.Msg.ServerId,
			JoinedAt: timestamppb.New(now),
		},
	}), nil
}

func (s *chatService) RemoveBotFromServer(ctx context.Context, req *connect.Request[v1.RemoveBotFromServerRequest]) (*connect.Response[v1.RemoveBotFromServerResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.BotId == "" || req.Msg.ServerId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("bot_id and server_id are required"))
	}

	// Verify the bot exists and is a bot.
	bot, err := s.botStore.GetBotUser(ctx, req.Msg.BotId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("bot not found"))
	}

	// Allow removal by: server admin (ManageBots) OR bot owner.
	if bot.BotOwnerID != userID {
		if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
			return nil, err
		}
		_, _, _, err := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.ManageBots)
		if err != nil {
			return nil, err
		}
	}

	// Check the bot is actually a member.
	isMember, err := s.chatStore.IsMember(ctx, req.Msg.BotId, req.Msg.ServerId)
	if err != nil {
		slog.Error("checking membership", "err", err, "bot", req.Msg.BotId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("bot is not a member of this server"))
	}

	// Remove bot from server.
	if err := s.chatStore.RemoveMember(ctx, req.Msg.BotId, req.Msg.ServerId); err != nil {
		slog.Error("removing bot from server", "err", err, "bot", req.Msg.BotId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Clean up channel_members for the bot in this server.
	if err := s.chatStore.RemoveChannelMembersForServer(ctx, req.Msg.BotId, req.Msg.ServerId); err != nil {
		slog.Error("removing channel members for bot", "err", err, "bot", req.Msg.BotId, "server", req.Msg.ServerId)
	}

	// Publish member remove event.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_MEMBER_REMOVE,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_MemberRemove{
			MemberRemove: &v1.MemberRemoveEvent{
				ServerId: req.Msg.ServerId,
				UserId:   req.Msg.BotId,
			},
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		if err := s.nc.Publish(subjects.ServerMember(req.Msg.ServerId), eventData); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.ServerMember(req.Msg.ServerId), "err", err)
		}
	}

	// Signal gateway to refresh the bot's subscriptions.
	s.nc.Publish(subjects.UserSubscription(req.Msg.BotId), nil)

	// Emit system message for bot removal.
	s.publishServerSystemMessage(ctx, req.Msg.ServerId,
		uint32(v1.MessageType_MESSAGE_TYPE_MEMBER_LEAVE), "leave",
		MemberEventContent{UserID: req.Msg.BotId},
		map[string]string{"user": bot.DisplayName},
	)

	return connect.NewResponse(&v1.RemoveBotFromServerResponse{}), nil
}

// Webhook management RPCs

func (s *chatService) CreateWebhook(ctx context.Context, req *connect.Request[v1.CreateWebhookRequest]) (*connect.Response[v1.CreateWebhookResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.BotId == "" || req.Msg.ServerId == "" || req.Msg.Url == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("bot_id, server_id, and url are required"))
	}
	if !strings.HasPrefix(req.Msg.Url, "https://") {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("webhook URL must use HTTPS"))
	}

	// Require ManageWebhooks permission.
	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}
	_, _, _, err := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.ManageWebhooks)
	if err != nil {
		return nil, err
	}

	// Verify bot is a member of the server.
	isMember, err := s.chatStore.IsMember(ctx, req.Msg.BotId, req.Msg.ServerId)
	if err != nil {
		slog.Error("checking bot membership", "err", err, "bot", req.Msg.BotId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("bot must be a member of the server"))
	}

	// Generate HMAC secret.
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		slog.Error("generating webhook secret", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	webhook := &models.BotWebhook{
		ID:        models.NewID(),
		BotUserID: req.Msg.BotId,
		ServerID:  req.Msg.ServerId,
		URL:       req.Msg.Url,
		Secret:    secret,
		CreatedAt: time.Now(),
	}

	_, err = s.botStore.CreateWebhook(ctx, webhook)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique") {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("webhook already exists for this bot and server"))
		}
		slog.Error("creating webhook", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Signal webhook service to reload.
	s.nc.Publish(subjects.InternalWebhookReload(), nil)

	return connect.NewResponse(&v1.CreateWebhookResponse{
		Webhook: &v1.Webhook{
			Id:        webhook.ID,
			BotUserId: webhook.BotUserID,
			ServerId:  webhook.ServerID,
			Url:       webhook.URL,
			Secret:    fmt.Sprintf("%x", webhook.Secret), // hex-encoded, shown once
			CreatedAt: timestamppb.New(webhook.CreatedAt),
		},
	}), nil
}

func (s *chatService) DeleteWebhook(ctx context.Context, req *connect.Request[v1.DeleteWebhookRequest]) (*connect.Response[v1.DeleteWebhookResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.WebhookId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("webhook_id is required"))
	}

	webhook, err := s.botStore.GetWebhook(ctx, req.Msg.WebhookId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("webhook not found"))
	}

	// Allow deletion by: server admin (ManageWebhooks) OR bot owner.
	bot, err := s.botStore.GetBotUser(ctx, webhook.BotUserID)
	if err != nil || bot.BotOwnerID != userID {
		// Check ManageWebhooks permission.
		if err := s.requireMembership(ctx, userID, webhook.ServerID); err != nil {
			return nil, err
		}
		_, _, _, err := s.requirePermission(ctx, userID, webhook.ServerID, permissions.ManageWebhooks)
		if err != nil {
			return nil, err
		}
	}

	if err := s.botStore.DeleteWebhook(ctx, req.Msg.WebhookId); err != nil {
		slog.Error("deleting webhook", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Signal webhook service to reload.
	s.nc.Publish(subjects.InternalWebhookReload(), nil)

	return connect.NewResponse(&v1.DeleteWebhookResponse{}), nil
}

func (s *chatService) ListWebhooks(ctx context.Context, req *connect.Request[v1.ListWebhooksRequest]) (*connect.Response[v1.ListWebhooksResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ServerId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id is required"))
	}

	// Require ManageWebhooks permission.
	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}
	_, _, _, err := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.ManageWebhooks)
	if err != nil {
		return nil, err
	}

	webhooks, err := s.botStore.ListWebhooksByServer(ctx, req.Msg.ServerId)
	if err != nil {
		slog.Error("listing webhooks", "err", err, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	var protoWebhooks []*v1.Webhook
	for _, w := range webhooks {
		protoWebhooks = append(protoWebhooks, &v1.Webhook{
			Id:        w.ID,
			BotUserId: w.BotUserID,
			ServerId:  w.ServerID,
			Url:       w.URL,
			// Secret is NOT returned in list — only shown at creation.
			CreatedAt: timestamppb.New(w.CreatedAt),
		})
	}

	return connect.NewResponse(&v1.ListWebhooksResponse{
		Webhooks: protoWebhooks,
	}), nil
}

// Bot invite RPCs

func generateInviteCode() (string, error) {
	b := make([]byte, 16) // 128 bits
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func (s *chatService) CreateBotInvite(ctx context.Context, req *connect.Request[v1.CreateBotInviteRequest]) (*connect.Response[v1.CreateBotInviteResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.BotId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("bot_id is required"))
	}

	// Verify ownership.
	bot, err := s.botStore.GetBotUser(ctx, req.Msg.BotId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("bot not found"))
	}
	if bot.BotOwnerID != userID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("you do not own this bot"))
	}

	// Check invite limit.
	count, err := s.botStore.CountBotInvites(ctx, req.Msg.BotId)
	if err != nil {
		slog.Error("counting bot invites", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if count >= maxInvitesPerBot {
		return nil, connect.NewError(connect.CodeResourceExhausted, fmt.Errorf("maximum %d active invites per bot", maxInvitesPerBot))
	}

	code, err := generateInviteCode()
	if err != nil {
		slog.Error("generating invite code", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	now := time.Now()
	invite := &models.BotInvite{
		Code:                 code,
		BotID:                req.Msg.BotId,
		RequestedPermissions: req.Msg.RequestedPermissions,
		CreatorID:            userID,
		CreatedAt:            now,
		ExpiresAt:            now.Add(7 * 24 * time.Hour),
	}

	if err := s.botStore.CreateBotInvite(ctx, invite); err != nil {
		slog.Error("creating bot invite", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.CreateBotInviteResponse{
		Invite: botInviteToProto(invite),
	}), nil
}

func (s *chatService) ResolveBotInvite(ctx context.Context, req *connect.Request[v1.ResolveBotInviteRequest]) (*connect.Response[v1.ResolveBotInviteResponse], error) {
	// Public RPC — no auth required.
	if req.Msg.Code == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("code is required"))
	}

	invite, err := s.botStore.GetBotInvite(ctx, req.Msg.Code)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("invite not found"))
	}
	if time.Now().After(invite.ExpiresAt) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("invite has expired"))
	}

	bot, err := s.botStore.GetBotUser(ctx, invite.BotID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("bot not found"))
	}

	// Get owner username for display.
	owner, err := s.authStore.GetUserByID(ctx, invite.CreatorID)
	ownerUsername := ""
	if err == nil {
		ownerUsername = owner.Username
	}

	return connect.NewResponse(&v1.ResolveBotInviteResponse{
		Invite:        botInviteToProto(invite),
		Bot:           botToProto(bot),
		OwnerUsername: ownerUsername,
	}), nil
}

func (s *chatService) AcceptBotInvite(ctx context.Context, req *connect.Request[v1.AcceptBotInviteRequest]) (*connect.Response[v1.AcceptBotInviteResponse], error) {
	_, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.Code == "" || req.Msg.ServerId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("code and server_id are required"))
	}

	// Resolve the invite.
	invite, err := s.botStore.GetBotInvite(ctx, req.Msg.Code)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("invite not found"))
	}
	if time.Now().After(invite.ExpiresAt) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("invite has expired"))
	}

	// Delegate to AddBotToServer — context already carries the caller's auth.
	addReq := connect.NewRequest(&v1.AddBotToServerRequest{
		BotId:    invite.BotID,
		ServerId: req.Msg.ServerId,
	})

	addResp, err := s.AddBotToServer(ctx, addReq)
	if err != nil {
		return nil, err
	}

	return connect.NewResponse(&v1.AcceptBotInviteResponse{
		Member: addResp.Msg.Member,
	}), nil
}

func (s *chatService) ListBotInvites(ctx context.Context, req *connect.Request[v1.ListBotInvitesRequest]) (*connect.Response[v1.ListBotInvitesResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.BotId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("bot_id is required"))
	}

	// Verify ownership.
	bot, err := s.botStore.GetBotUser(ctx, req.Msg.BotId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("bot not found"))
	}
	if bot.BotOwnerID != userID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("you do not own this bot"))
	}

	invites, err := s.botStore.ListBotInvites(ctx, req.Msg.BotId)
	if err != nil {
		slog.Error("listing bot invites", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	var protoInvites []*v1.BotInvite
	for _, inv := range invites {
		protoInvites = append(protoInvites, botInviteToProto(inv))
	}

	return connect.NewResponse(&v1.ListBotInvitesResponse{
		Invites: protoInvites,
	}), nil
}

func (s *chatService) DeleteBotInvite(ctx context.Context, req *connect.Request[v1.DeleteBotInviteRequest]) (*connect.Response[v1.DeleteBotInviteResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.Code == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("code is required"))
	}

	// Verify ownership via the invite's bot.
	invite, err := s.botStore.GetBotInvite(ctx, req.Msg.Code)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("invite not found"))
	}
	bot, err := s.botStore.GetBotUser(ctx, invite.BotID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("bot not found"))
	}
	if bot.BotOwnerID != userID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("you do not own this bot"))
	}

	if err := s.botStore.DeleteBotInvite(ctx, req.Msg.Code); err != nil {
		slog.Error("deleting bot invite", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.DeleteBotInviteResponse{}), nil
}

// UpdateBot RPC

func (s *chatService) UpdateBot(ctx context.Context, req *connect.Request[v1.UpdateBotRequest]) (*connect.Response[v1.UpdateBotResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.BotId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("bot_id is required"))
	}

	// Verify ownership.
	bot, err := s.botStore.GetBotUser(ctx, req.Msg.BotId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("bot not found"))
	}
	if bot.BotOwnerID != userID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("you do not own this bot"))
	}

	// Apply partial updates: use existing values as defaults.
	displayName := bot.DisplayName
	description := bot.BotDescription
	avatarURL := bot.AvatarURL

	if req.Msg.DisplayName != nil {
		displayName = strings.TrimSpace(*req.Msg.DisplayName)
		if displayName == "" {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("display_name cannot be empty"))
		}
		if len(displayName) > 100 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("display_name must be 100 characters or fewer"))
		}
	}
	if req.Msg.Description != nil {
		description = strings.TrimSpace(*req.Msg.Description)
		if len(description) > 500 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("description must be 500 characters or fewer"))
		}
	}
	if req.Msg.AvatarUrl != nil {
		avatarURL = strings.TrimSpace(*req.Msg.AvatarUrl)
		if avatarURL != "" && !strings.HasPrefix(avatarURL, "https://") && !strings.HasPrefix(avatarURL, "http://") {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("avatar_url must be an HTTP(S) URL"))
		}
	}

	if err := s.botStore.UpdateBotProfile(ctx, req.Msg.BotId, displayName, description, avatarURL); err != nil {
		slog.Error("updating bot profile", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Return updated bot.
	bot.DisplayName = displayName
	bot.BotDescription = description
	bot.AvatarURL = avatarURL

	return connect.NewResponse(&v1.UpdateBotResponse{
		Bot: botToProto(bot),
	}), nil
}

// Incoming webhook RPCs

func (s *chatService) CreateIncomingWebhook(ctx context.Context, req *connect.Request[v1.CreateIncomingWebhookRequest]) (*connect.Response[v1.CreateIncomingWebhookResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.BotId == "" || req.Msg.ServerId == "" || req.Msg.ChannelId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("bot_id, server_id, and channel_id are required"))
	}

	// Require ManageWebhooks permission.
	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}
	_, _, _, err := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.ManageWebhooks)
	if err != nil {
		return nil, err
	}

	// Verify bot is a member of the server.
	isMember, err := s.chatStore.IsMember(ctx, req.Msg.BotId, req.Msg.ServerId)
	if err != nil {
		slog.Error("checking bot membership", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("bot must be a member of the server"))
	}

	// Generate secret.
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		slog.Error("generating incoming webhook secret", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	secretHash := sha256.Sum256(secret)

	wh := &models.IncomingWebhook{
		ID:         models.NewID(),
		BotUserID:  req.Msg.BotId,
		ServerID:   req.Msg.ServerId,
		ChannelID:  req.Msg.ChannelId,
		SecretHash: secretHash[:],
		CreatorID:  userID,
		CreatedAt:  time.Now(),
	}

	if err := s.botStore.CreateIncomingWebhook(ctx, wh); err != nil {
		if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique") {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("incoming webhook already exists for this bot and channel"))
		}
		slog.Error("creating incoming webhook", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.CreateIncomingWebhookResponse{
		Webhook: &v1.IncomingWebhookWithSecret{
			Webhook: &v1.IncomingWebhook{
				Id:        wh.ID,
				BotUserId: wh.BotUserID,
				ServerId:  wh.ServerID,
				ChannelId: wh.ChannelID,
				CreatorId: wh.CreatorID,
				CreatedAt: timestamppb.New(wh.CreatedAt),
			},
			Secret: fmt.Sprintf("%x", secret), // hex-encoded, shown once
		},
	}), nil
}

func (s *chatService) DeleteIncomingWebhook(ctx context.Context, req *connect.Request[v1.DeleteIncomingWebhookRequest]) (*connect.Response[v1.DeleteIncomingWebhookResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.WebhookId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("webhook_id is required"))
	}

	wh, err := s.botStore.GetIncomingWebhook(ctx, req.Msg.WebhookId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("incoming webhook not found"))
	}

	// Allow deletion by: server admin (ManageWebhooks) OR bot owner.
	bot, err := s.botStore.GetBotUser(ctx, wh.BotUserID)
	if err != nil || bot.BotOwnerID != userID {
		if err := s.requireMembership(ctx, userID, wh.ServerID); err != nil {
			return nil, err
		}
		_, _, _, err := s.requirePermission(ctx, userID, wh.ServerID, permissions.ManageWebhooks)
		if err != nil {
			return nil, err
		}
	}

	if err := s.botStore.DeleteIncomingWebhook(ctx, req.Msg.WebhookId); err != nil {
		slog.Error("deleting incoming webhook", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.DeleteIncomingWebhookResponse{}), nil
}

func (s *chatService) ListIncomingWebhooks(ctx context.Context, req *connect.Request[v1.ListIncomingWebhooksRequest]) (*connect.Response[v1.ListIncomingWebhooksResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ServerId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id is required"))
	}

	// Require ManageWebhooks permission.
	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}
	_, _, _, err := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.ManageWebhooks)
	if err != nil {
		return nil, err
	}

	webhooks, err := s.botStore.ListIncomingWebhooksByServer(ctx, req.Msg.ServerId)
	if err != nil {
		slog.Error("listing incoming webhooks", "err", err, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	var protoWebhooks []*v1.IncomingWebhook
	for _, wh := range webhooks {
		protoWebhooks = append(protoWebhooks, &v1.IncomingWebhook{
			Id:        wh.ID,
			BotUserId: wh.BotUserID,
			ServerId:  wh.ServerID,
			ChannelId: wh.ChannelID,
			CreatorId: wh.CreatorID,
			CreatedAt: timestamppb.New(wh.CreatedAt),
		})
	}

	return connect.NewResponse(&v1.ListIncomingWebhooksResponse{
		Webhooks: protoWebhooks,
	}), nil
}

