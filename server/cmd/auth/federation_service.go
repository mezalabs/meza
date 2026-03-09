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

	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/federation"
	"github.com/mezalabs/meza/internal/store"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type federationService struct {
	authStore       store.AuthStorer
	federationStore store.FederationStorer
	chatStore       store.ChatStorer
	inviteStore     store.InviteStorer
	banStore        store.BanStorer
	ed25519Keys     *auth.Ed25519Keys
	instanceURL     string // This instance's public URL
	verifier        *federation.Verifier
	redisClient     *redis.Client // For jti replay protection (nil = no protection)
}

// consumeJTI ensures a federation assertion jti is used only once.
// Returns true if this is the first consumption, false if already used.
func (s *federationService) consumeJTI(ctx context.Context, jti string) (bool, error) {
	if s.redisClient == nil {
		return true, nil // No Redis = no replay protection (dev mode)
	}
	// SET NX with 120s TTL (assertion TTL is 60s + 15s leeway + buffer)
	key := "fed_jti:" + jti
	ok, err := s.redisClient.SetNX(ctx, key, "1", 120*time.Second).Result()
	if err != nil {
		return false, fmt.Errorf("check jti replay: %w", err)
	}
	return ok, nil
}

// sanitizeFederationProfile validates and cleans federation profile claims.
func sanitizeFederationProfile(displayName, avatarURL string) (string, string) {
	// Limit display_name to 64 characters
	if len(displayName) > 64 {
		displayName = displayName[:64]
	}
	// Strip any HTML tags from display_name
	displayName = stripHTMLTags(displayName)

	// Validate avatar_url is an HTTPS URL
	if avatarURL != "" {
		u, err := url.Parse(avatarURL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			avatarURL = "" // Drop invalid URLs
		}
	}
	return displayName, avatarURL
}

// stripHTMLTags removes HTML tags from a string (simple approach).
func stripHTMLTags(s string) string {
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

// federationDeviceID generates a unique device ID for a federation session.
func federationDeviceID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return "federation_" + hex.EncodeToString(b)
}

// CreateFederationAssertion is called on the origin.
// It issues a short-lived, audience-scoped JWT for the authenticated user
// to present to a host instance during federation join/refresh.
func (s *federationService) CreateFederationAssertion(ctx context.Context, req *connect.Request[v1.CreateFederationAssertionRequest]) (*connect.Response[v1.CreateFederationAssertionResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok || userID == "" {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	targetURL := req.Msg.TargetInstanceUrl
	if targetURL == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("target_instance_url is required"))
	}

	// Validate target URL format
	parsed, err := url.Parse(targetURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("target_instance_url must be a valid URL"))
	}

	if s.ed25519Keys == nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("federation not configured on this instance"))
	}

	// Look up user profile for assertion claims
	user, err := s.authStore.GetUserByID(ctx, userID)
	if err != nil {
		slog.Error("get user for assertion", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Federated shadow users cannot create assertions (only real origin users)
	if user.IsFederated {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("federated users cannot create assertions"))
	}

	assertion, err := auth.GenerateFederationAssertion(
		userID, user.DisplayName, user.AvatarURL,
		s.ed25519Keys, s.instanceURL, targetURL,
	)
	if err != nil {
		slog.Error("generating federation assertion", "err", err, "user", userID, "target", targetURL)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.CreateFederationAssertionResponse{
		AssertionToken: assertion,
	}), nil
}

// FederationJoin is called on a host instance.
// It verifies the origin assertion, creates a shadow user + member,
// and issues local tokens.
func (s *federationService) FederationJoin(ctx context.Context, req *connect.Request[v1.FederationJoinRequest]) (*connect.Response[v1.FederationJoinResponse], error) {
	if req.Msg.AssertionToken == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("assertion_token is required"))
	}
	if req.Msg.InviteCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invite_code is required"))
	}

	if s.verifier == nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("federation not enabled on this instance"))
	}

	// Verify the federation assertion from the home server
	assertionClaims, err := s.verifier.VerifyAssertion(ctx, req.Msg.AssertionToken)
	if err != nil {
		slog.Warn("federation assertion verification failed", "err", err)
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid federation assertion"))
	}

	// Check for assertion replay
	parser := jwt.NewParser(jwt.WithoutClaimsValidation())
	unverified, _, _ := parser.ParseUnverified(req.Msg.AssertionToken, jwt.MapClaims{})
	if unverified != nil {
		if mc, ok := unverified.Claims.(jwt.MapClaims); ok {
			if jti, ok := mc["jti"].(string); ok && jti != "" {
				consumed, err := s.consumeJTI(ctx, jti)
				if err != nil {
					slog.Error("jti replay check", "err", err)
					return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
				}
				if !consumed {
					return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("assertion already consumed"))
				}
			}
		}
	}

	// Sanitize federation profile claims
	displayName, avatarURL := sanitizeFederationProfile(assertionClaims.DisplayName, assertionClaims.AvatarURL)

	// Pre-check: if this user already has a shadow user, check bans before
	// consuming the invite (avoid burning single-use invites for banned users).
	if shadowUserID, err := s.federationStore.LookupShadowUserID(ctx, assertionClaims.Issuer, assertionClaims.UserID); err != nil {
		slog.Error("lookup shadow user for ban check", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	} else if shadowUserID != "" {
		// Peek at the invite to get the server ID without consuming it
		invite, err := s.inviteStore.GetInvite(ctx, req.Msg.InviteCode)
		if err != nil || invite == nil {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("invite not found or expired"))
		}
		banned, err := s.banStore.IsBanned(ctx, invite.ServerID, shadowUserID)
		if err != nil {
			slog.Error("pre-check ban for federation join", "err", err)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if banned {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("you are banned from this server"))
		}
	}

	// Resolve invite code to a server
	invite, err := s.inviteStore.ConsumeInvite(ctx, req.Msg.InviteCode)
	if err != nil || invite == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("invite not found or expired"))
	}

	// Atomically create shadow user + add guild membership (includes in-tx ban check)
	shadowUser, err := s.federationStore.FederationJoinTx(
		ctx,
		assertionClaims.Issuer,
		assertionClaims.UserID,
		displayName,
		avatarURL,
		invite.ServerID,
	)
	if err != nil {
		if errors.Is(err, store.ErrBannedFromServer) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("you are banned from this server"))
		}
		slog.Error("federation join tx", "err", err, "remote_user", assertionClaims.UserID, "server", invite.ServerID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Generate local token pair for the shadow user
	deviceID := federationDeviceID()
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

// FederationRefresh is called on a host instance.
// It validates both the local refresh token and a fresh origin assertion
// (to ensure revocation propagation), then issues new local tokens.
func (s *federationService) FederationRefresh(ctx context.Context, req *connect.Request[v1.FederationRefreshRequest]) (*connect.Response[v1.FederationRefreshResponse], error) {
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

	// Validate fresh assertion from the origin
	assertionClaims, err := s.verifier.VerifyAssertion(ctx, req.Msg.AssertionToken)
	if err != nil {
		slog.Warn("federation refresh assertion failed", "err", err)
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid federation assertion"))
	}

	// Check for assertion replay
	parser := jwt.NewParser(jwt.WithoutClaimsValidation())
	unverified, _, _ := parser.ParseUnverified(req.Msg.AssertionToken, jwt.MapClaims{})
	if unverified != nil {
		if mc, ok := unverified.Claims.(jwt.MapClaims); ok {
			if jti, ok := mc["jti"].(string); ok && jti != "" {
				consumed, err := s.consumeJTI(ctx, jti)
				if err != nil {
					slog.Error("jti replay check", "err", err)
					return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
				}
				if !consumed {
					return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("assertion already consumed"))
				}
			}
		}
	}

	// Cross-check: assertion identity must match the shadow user bound to the refresh token.
	// Without this check, an attacker with a valid assertion for user A and a stolen
	// refresh token for shadow user B could refresh B's tokens.
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
	refreshDisplayName, refreshAvatarURL := sanitizeFederationProfile(assertionClaims.DisplayName, assertionClaims.AvatarURL)

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

// FederationLeave is called on a host instance.
// Removes guild membership but keeps the shadow user row for message attribution.
func (s *federationService) FederationLeave(ctx context.Context, req *connect.Request[v1.FederationLeaveRequest]) (*connect.Response[v1.FederationLeaveResponse], error) {
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

	slog.Info("federation leave", "user", userID, "server", req.Msg.ServerId)

	return connect.NewResponse(&v1.FederationLeaveResponse{}), nil
}

// ResolveRemoteInvite parses an invite URL server-side for agent parity.
func (s *federationService) ResolveRemoteInvite(ctx context.Context, req *connect.Request[v1.ResolveRemoteInviteRequest]) (*connect.Response[v1.ResolveRemoteInviteResponse], error) {
	_, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	inviteURL := req.Msg.InviteUrl
	if inviteURL == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invite_url is required"))
	}

	parsed, err := url.Parse(inviteURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invite_url must be a valid URL"))
	}

	// Extract invite code from path: /invite/{code}
	parts := strings.Split(strings.TrimPrefix(parsed.Path, "/"), "/")
	if len(parts) != 2 || parts[0] != "invite" || parts[1] == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invite_url must be in format https://instance/invite/CODE"))
	}

	instanceURL := parsed.Scheme + "://" + parsed.Host

	return connect.NewResponse(&v1.ResolveRemoteInviteResponse{
		InstanceUrl: instanceURL,
		InviteCode:  parts[1],
	}), nil
}

// ListFederatedMemberships returns all remote instance memberships for the authenticated user.
// This is a stub for Phase 1 — the client tracks memberships in localStorage.
func (s *federationService) ListFederatedMemberships(ctx context.Context, req *connect.Request[v1.ListFederatedMembershipsRequest]) (*connect.Response[v1.ListFederatedMembershipsResponse], error) {
	_, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	// Phase 1: return empty list. Client tracks memberships in localStorage.
	// Phase 2 will add server-side storage of federation memberships.
	return connect.NewResponse(&v1.ListFederatedMembershipsResponse{
		Memberships: []*v1.FederatedMembership{},
	}), nil
}

// generateLocalTokenPair creates tokens for a shadow user on this instance.
func (s *federationService) generateLocalTokenPair(userID, deviceID string) (string, string, error) {
	return auth.GenerateTokenPairEd25519(userID, deviceID, s.ed25519Keys, s.instanceURL, true)
}
