package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/redis/go-redis/v9"

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/store"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type federationService struct {
	authStore                store.AuthStorer
	federationStore          store.FederationStorer
	federatedMembershipStore store.FederatedMembershipStorer
	ed25519Keys              *auth.Ed25519Keys
	instanceURL              string // This instance's public URL
	devMode                  bool   // When true, allows http:// URLs in federation
	redisClient              *redis.Client // For per-user rate limiting
}

// assertionRateLimitMax is the maximum number of federation assertion requests
// per user per minute.
const assertionRateLimitMax = 10
const assertionRateLimitTTL = 1 * time.Minute

// checkAssertionRateLimit enforces per-user rate limiting for CreateFederationAssertion.
func (s *federationService) checkAssertionRateLimit(ctx context.Context, userID string) error {
	if s.redisClient == nil {
		return nil // No Redis = no rate limiting (dev mode)
	}
	key := fmt.Sprintf("ratelimit:federation_assertion:%s", userID)
	count, err := s.redisClient.Incr(ctx, key).Result()
	if err != nil {
		slog.Error("federation assertion rate limit incr", "err", err, "user", userID)
		return nil // Fail open on Redis errors
	}
	if count == 1 {
		s.redisClient.Expire(ctx, key, assertionRateLimitTTL)
	}
	if count > assertionRateLimitMax {
		return connect.NewError(connect.CodeResourceExhausted, errors.New("too many federation assertion requests, try again later"))
	}
	return nil
}

// CreateFederationAssertion is called on the home server.
// It issues a short-lived, audience-scoped JWT for the authenticated user
// to present to a remote instance during federation join/refresh.
func (s *federationService) CreateFederationAssertion(ctx context.Context, req *connect.Request[v1.CreateFederationAssertionRequest]) (*connect.Response[v1.CreateFederationAssertionResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok || userID == "" {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	// Per-user rate limit: 10 requests/minute
	if err := s.checkAssertionRateLimit(ctx, userID); err != nil {
		return nil, err
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

	// Reject http:// in production — federation assertions must use HTTPS
	if parsed.Scheme == "http" && !s.devMode {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("target_instance_url must use https:// scheme"))
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

	// Federated shadow users cannot create assertions (only real home users)
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

// FederationJoin has been moved to the gateway service.
func (s *federationService) FederationJoin(_ context.Context, _ *connect.Request[v1.FederationJoinRequest]) (*connect.Response[v1.FederationJoinResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("FederationJoin has moved to the gateway service"))
}

// FederationRefresh has been moved to the gateway service.
func (s *federationService) FederationRefresh(_ context.Context, _ *connect.Request[v1.FederationRefreshRequest]) (*connect.Response[v1.FederationRefreshResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("FederationRefresh has moved to the gateway service"))
}

// FederationLeave has been moved to the gateway service.
func (s *federationService) FederationLeave(_ context.Context, _ *connect.Request[v1.FederationLeaveRequest]) (*connect.Response[v1.FederationLeaveResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("FederationLeave has moved to the gateway service"))
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

	// Reject http:// in production — federation URLs must use HTTPS
	if parsed.Scheme == "http" && !s.devMode {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invite_url must use https:// scheme"))
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
func (s *federationService) ListFederatedMemberships(ctx context.Context, req *connect.Request[v1.ListFederatedMembershipsRequest]) (*connect.Response[v1.ListFederatedMembershipsResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	memberships, err := s.federatedMembershipStore.ListFederatedMemberships(ctx, userID)
	if err != nil {
		slog.Error("list federated memberships", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoMemberships := make([]*v1.FederatedMembership, len(memberships))
	for i, m := range memberships {
		protoMemberships[i] = &v1.FederatedMembership{
			InstanceUrl: m.SatelliteURL,
			ServerId:    m.ServerID,
			JoinedAt:    timestamppb.New(m.JoinedAt),
		}
	}

	return connect.NewResponse(&v1.ListFederatedMembershipsResponse{
		Memberships: protoMemberships,
	}), nil
}

// StoreFederatedMembership records a remote instance membership on the home server.
// Called by the client after a successful FederationJoin on a satellite.
func (s *federationService) StoreFederatedMembership(ctx context.Context, req *connect.Request[v1.StoreFederatedMembershipRequest]) (*connect.Response[v1.StoreFederatedMembershipResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok || userID == "" {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	if req.Msg.SatelliteUrl == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("satellite_url is required"))
	}
	if req.Msg.ServerId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id is required"))
	}

	// Validate satellite URL format
	parsed, err := url.Parse(req.Msg.SatelliteUrl)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("satellite_url must be a valid HTTPS URL"))
	}

	if err := s.federatedMembershipStore.AddFederatedMembership(ctx, userID, req.Msg.SatelliteUrl, req.Msg.ServerId); err != nil {
		slog.Error("store federated membership", "err", err, "user", userID, "satellite", req.Msg.SatelliteUrl, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	slog.Info("stored federated membership", "user", userID, "satellite", req.Msg.SatelliteUrl, "server", req.Msg.ServerId)

	return connect.NewResponse(&v1.StoreFederatedMembershipResponse{}), nil
}

// RemoveFederatedMembership removes a remote instance membership from the home server.
// Called by the client after a successful FederationLeave on a satellite.
func (s *federationService) RemoveFederatedMembership(ctx context.Context, req *connect.Request[v1.RemoveFederatedMembershipRequest]) (*connect.Response[v1.RemoveFederatedMembershipResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok || userID == "" {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	if req.Msg.SatelliteUrl == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("satellite_url is required"))
	}
	if req.Msg.ServerId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id is required"))
	}

	if err := s.federatedMembershipStore.RemoveFederatedMembership(ctx, userID, req.Msg.SatelliteUrl, req.Msg.ServerId); err != nil {
		slog.Error("remove federated membership", "err", err, "user", userID, "satellite", req.Msg.SatelliteUrl, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	slog.Info("removed federated membership", "user", userID, "satellite", req.Msg.SatelliteUrl, "server", req.Msg.ServerId)

	return connect.NewResponse(&v1.RemoveFederatedMembershipResponse{}), nil
}
