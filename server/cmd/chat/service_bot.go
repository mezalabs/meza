package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
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
	}
}

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
