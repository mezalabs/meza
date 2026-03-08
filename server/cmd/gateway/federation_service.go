package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/gen/meza/v1/mezav1connect"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/federation"
	"github.com/meza-chat/meza/internal/store"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// federatedRefreshTokenExpiry is the TTL for refresh tokens issued to federated
// shadow users. Shorter than the default 30-day TTL to limit exposure if a
// satellite-issued token is compromised.
const federatedRefreshTokenExpiry = 7 * 24 * time.Hour

// gatewayFederationService handles FederationJoin, FederationRefresh, and
// FederationLeave on the gateway. The remaining RPCs (CreateFederationAssertion,
// ResolveRemoteInvite, ListFederatedMemberships) stay on the auth service.
type gatewayFederationService struct {
	mezav1connect.UnimplementedFederationServiceHandler

	authStore       store.AuthStorer
	federationStore store.FederationStorer
	chatStore       store.ChatStorer
	inviteStore     store.InviteStorer
	ed25519Keys     *auth.Ed25519Keys
	instanceURL     string // This instance's public URL
	verifier        *federation.Verifier
	redisClient     *redis.Client      // For jti replay protection (nil = no protection)
	tokenBlocklist  *auth.TokenBlocklist // For blocking tokens on federation leave
}

// consumeJTI ensures a federation assertion jti is used only once.
// Returns true if this is the first consumption, false if already used.
func (s *gatewayFederationService) consumeJTI(ctx context.Context, jti string) (bool, error) {
	if s.redisClient == nil {
		return true, nil // No Redis = no replay protection (dev mode)
	}
	// SET NX with 90s TTL (assertion TTL is 60s + buffer)
	key := "fed_jti:" + jti
	ok, err := s.redisClient.SetNX(ctx, key, "1", 90*time.Second).Result()
	if err != nil {
		return false, fmt.Errorf("check jti replay: %w", err)
	}
	return ok, nil
}

// sanitizeFederationProfile validates and cleans federation profile claims.
func gwSanitizeFederationProfile(displayName, avatarURL string) (string, string) {
	// Limit display_name to 64 characters
	if len(displayName) > 64 {
		displayName = displayName[:64]
	}
	// Strip any HTML tags from display_name
	displayName = gwStripHTMLTags(displayName)

	// Validate avatar_url is an HTTPS URL
	if avatarURL != "" {
		u, err := url.Parse(avatarURL)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			avatarURL = "" // Drop non-HTTPS URLs
		}
	}
	return displayName, avatarURL
}

// gwStripHTMLTags removes HTML tags from a string (simple approach).
func gwStripHTMLTags(s string) string {
	var result strings.Builder
	inTag := false
	for _, r := range s {
		if r == '<' {
			inTag = true
			continue
		}
		if r == '>' {
			inTag = false
			continue
		}
		if !inTag {
			result.WriteRune(r)
		}
	}
	return result.String()
}

// gwFederationDeviceID generates a unique device ID for a federation session.
func gwFederationDeviceID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return "federation_" + hex.EncodeToString(b)
}

// FederationJoin is called on the remote instance.
// It verifies the bnfr.chat assertion, creates a shadow user + member,
// and issues local tokens.
func (s *gatewayFederationService) FederationJoin(ctx context.Context, req *connect.Request[v1.FederationJoinRequest]) (*connect.Response[v1.FederationJoinResponse], error) {
	if req.Msg.AssertionToken == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("assertion_token is required"))
	}
	if req.Msg.InviteCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invite_code is required"))
	}

	if s.verifier == nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("federation not enabled on this instance"))
	}

	// Verify the federation assertion from bnfr.chat
	assertionClaims, err := s.verifier.VerifyAssertion(ctx, req.Msg.AssertionToken)
	if err != nil {
		slog.Warn("federation assertion verification failed", "err", err)
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid federation assertion"))
	}

	// Extract and validate jti claim — mandatory for replay protection
	parser := jwt.NewParser(jwt.WithoutClaimsValidation())
	unverified, _, _ := parser.ParseUnverified(req.Msg.AssertionToken, jwt.MapClaims{})
	var jti string
	if unverified != nil {
		if mc, ok := unverified.Claims.(jwt.MapClaims); ok {
			jti, _ = mc["jti"].(string)
		}
	}
	if jti == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("assertion must contain jti claim"))
	}

	consumed, err := s.consumeJTI(ctx, jti)
	if err != nil {
		slog.Error("jti replay check", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !consumed {
		return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("assertion already consumed"))
	}

	// Sanitize federation profile claims
	displayName, avatarURL := gwSanitizeFederationProfile(assertionClaims.DisplayName, assertionClaims.AvatarURL)

	// Atomically consume invite + create shadow user + add guild membership.
	// All three operations happen in a single transaction so if the join fails,
	// the invite use is not burned.
	shadowUser, invite, err := s.federationStore.FederationJoinTx(
		ctx,
		assertionClaims.Issuer,
		assertionClaims.UserID,
		displayName,
		avatarURL,
		req.Msg.InviteCode,
	)
	if err != nil {
		slog.Error("federation join tx", "err", err, "remote_user", assertionClaims.UserID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if shadowUser == nil || invite == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("invite not found or expired"))
	}

	// Generate local token pair for the shadow user
	deviceID := gwFederationDeviceID()
	accessToken, refreshToken, err := s.generateLocalTokenPair(shadowUser.ID, deviceID)
	if err != nil {
		slog.Error("generating federation tokens", "err", err, "shadow_user", shadowUser.ID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Fetch server details
	server, err := s.chatStore.GetServer(ctx, invite.ServerID)
	if err != nil {
		slog.Error("get server for federation join", "err", err, "server", invite.ServerID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Fetch channels
	channels, err := s.chatStore.ListChannels(ctx, invite.ServerID, shadowUser.ID)
	if err != nil {
		slog.Error("list channels for federation join", "err", err, "server", invite.ServerID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Fetch members
	members, err := s.chatStore.ListMembers(ctx, invite.ServerID, "", 100)
	if err != nil {
		slog.Error("list members for federation join", "err", err, "server", invite.ServerID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Convert to proto
	protoServer := &v1.Server{
		Id:        server.ID,
		Name:      server.Name,
		OwnerId:   server.OwnerID,
		CreatedAt: timestamppb.New(server.CreatedAt),
	}
	if server.IconURL != nil {
		protoServer.IconUrl = *server.IconURL
	}

	protoChannels := make([]*v1.Channel, len(channels))
	for i, c := range channels {
		protoChannels[i] = &v1.Channel{
			Id:        c.ID,
			ServerId:  c.ServerID,
			Name:      c.Name,
			Type:      v1.ChannelType(c.Type),
			Topic:     c.Topic,
			Position:  int32(c.Position),
			IsPrivate: c.IsPrivate,
			CreatedAt: timestamppb.New(c.CreatedAt),
		}
	}

	protoMembers := make([]*v1.Member, len(members))
	for i, m := range members {
		protoMembers[i] = &v1.Member{
			UserId:   m.UserID,
			ServerId: m.ServerID,
			RoleIds:  m.RoleIDs,
			Nickname: m.Nickname,
			JoinedAt: timestamppb.New(m.JoinedAt),
		}
	}

	slog.Info("federation join", "remote_user", assertionClaims.UserID, "shadow_user", shadowUser.ID, "server", invite.ServerID, "issuer", assertionClaims.Issuer)

	return connect.NewResponse(&v1.FederationJoinResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		Server:       protoServer,
		Channels:     protoChannels,
		Members:      protoMembers,
		UserId:       shadowUser.ID,
	}), nil
}

// FederationRefresh is called on the remote instance.
// It validates both the local refresh token and a fresh bnfr.chat assertion
// (to ensure revocation propagation), then issues new local tokens.
func (s *gatewayFederationService) FederationRefresh(ctx context.Context, req *connect.Request[v1.FederationRefreshRequest]) (*connect.Response[v1.FederationRefreshResponse], error) {
	if req.Msg.RefreshToken == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("refresh_token is required"))
	}
	if req.Msg.AssertionToken == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("assertion_token is required"))
	}

	if s.verifier == nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("federation not enabled on this instance"))
	}

	// Validate local refresh token
	claims, err := auth.ValidateTokenEd25519(req.Msg.RefreshToken, s.ed25519Keys.PublicKey)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid refresh token"))
	}
	if !claims.IsRefresh {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("not a refresh token"))
	}

	// Validate fresh assertion from bnfr.chat
	assertionClaims, err := s.verifier.VerifyAssertion(ctx, req.Msg.AssertionToken)
	if err != nil {
		slog.Warn("federation refresh assertion failed", "err", err)
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid federation assertion"))
	}

	// Extract and validate jti claim — mandatory for replay protection
	refreshParser := jwt.NewParser(jwt.WithoutClaimsValidation())
	refreshUnverified, _, _ := refreshParser.ParseUnverified(req.Msg.AssertionToken, jwt.MapClaims{})
	var refreshJTI string
	if refreshUnverified != nil {
		if mc, ok := refreshUnverified.Claims.(jwt.MapClaims); ok {
			refreshJTI, _ = mc["jti"].(string)
		}
	}
	if refreshJTI == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("assertion must contain jti claim"))
	}

	consumed, err := s.consumeJTI(ctx, refreshJTI)
	if err != nil {
		slog.Error("jti replay check", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !consumed {
		return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("assertion already consumed"))
	}

	// Cross-check: assertion identity must match the shadow user bound to the refresh token.
	shadowUser, err := s.authStore.GetUserByID(ctx, claims.UserID)
	if err != nil {
		slog.Error("get shadow user for federation refresh", "err", err, "user", claims.UserID)
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("shadow user not found"))
	}
	if !shadowUser.IsFederated {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("refresh token does not belong to a federated user"))
	}
	if assertionClaims.UserID != shadowUser.RemoteUserID || assertionClaims.Issuer != shadowUser.HomeServer {
		slog.Warn("federation refresh identity mismatch",
			"assertion_sub", assertionClaims.UserID,
			"shadow_remote_user_id", shadowUser.RemoteUserID,
			"assertion_iss", assertionClaims.Issuer,
			"shadow_home_server", shadowUser.HomeServer,
		)
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("assertion identity does not match refresh token identity"))
	}

	// Sanitize federation profile claims
	refreshDisplayName, refreshAvatarURL := gwSanitizeFederationProfile(assertionClaims.DisplayName, assertionClaims.AvatarURL)

	// Update shadow user profile if claims differ
	if err := s.federationStore.UpdateShadowUserProfile(ctx, claims.UserID, refreshDisplayName, refreshAvatarURL); err != nil {
		slog.Warn("update shadow user profile on refresh", "err", err, "user", claims.UserID)
	}

	// Issue new local token pair
	accessToken, refreshToken, err := s.generateLocalTokenPair(claims.UserID, claims.DeviceID)
	if err != nil {
		slog.Error("generating federation refresh tokens", "err", err, "user", claims.UserID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.FederationRefreshResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
	}), nil
}

// FederationLeave is called on the remote instance.
// Removes guild membership but keeps the shadow user row for message attribution.
func (s *gatewayFederationService) FederationLeave(ctx context.Context, req *connect.Request[v1.FederationLeaveRequest]) (*connect.Response[v1.FederationLeaveResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok || userID == "" {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	if req.Msg.ServerId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id is required"))
	}

	// Verify this is a federated user
	isFederated, err := s.federationStore.IsFederatedUser(ctx, userID)
	if err != nil {
		slog.Error("check federated user", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !isFederated {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("only federated users can use this endpoint"))
	}

	// Verify user is actually a member of this server
	isMember, err := s.chatStore.IsMember(ctx, userID, req.Msg.ServerId)
	if err != nil {
		slog.Error("check membership for federation leave", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("not a member of this server"))
	}

	// Remove membership (shadow user row stays for message attribution)
	if err := s.chatStore.RemoveMember(ctx, userID, req.Msg.ServerId); err != nil {
		slog.Error("federation leave", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Block tokens for this federated user's device so satellite-issued tokens
	// are rejected immediately rather than waiting for natural expiry.
	if s.tokenBlocklist != nil {
		if deviceID, ok := auth.DeviceIDFromContext(ctx); ok && deviceID != "" {
			if err := s.tokenBlocklist.BlockDevice(ctx, deviceID, 1*time.Hour); err != nil {
				slog.Error("blocking federated device on leave", "err", err, "device", deviceID)
				// Non-fatal: membership is already removed, tokens will expire naturally.
			}
		}
	}

	slog.Info("federation leave", "user", userID, "server", req.Msg.ServerId)

	return connect.NewResponse(&v1.FederationLeaveResponse{}), nil
}

// generateLocalTokenPair creates tokens for a shadow user on this instance.
// Uses federatedRefreshTokenExpiry (7 days) instead of the default 30-day TTL.
func (s *gatewayFederationService) generateLocalTokenPair(userID, deviceID string) (string, string, error) {
	return auth.GenerateTokenPairEd25519WithExpiry(userID, deviceID, s.ed25519Keys, s.instanceURL, true, federatedRefreshTokenExpiry)
}
