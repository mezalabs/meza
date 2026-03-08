package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/nats-io/nats.go"
	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/store"
	"github.com/meza-chat/meza/internal/subjects"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	maxEnvelopeSize  = 92   // ephemeral_pub(32) + nonce(12) + wrapped(48)
	maxPublicKeySize = 32   // Ed25519 verify key
	maxEnvelopeBatch = 1000 // max envelopes per RPC call
	maxUserIDsBatch  = 100  // max user IDs per GetPublicKeys call

	// keyRequestCooldown is the minimum interval between key request broadcasts
	// for the same (userID, channelID) pair. Aligned with the client-side 60s re-request.
	keyRequestCooldown = 30 * time.Second
)

// viewChannelChecker checks ViewChannel permission for a user on a channel.
// Implemented by store.ChannelPermissionStore.
type viewChannelChecker interface {
	HasViewChannel(ctx context.Context, userID, channelID string) (bool, error)
	ListMembersWithViewChannel(ctx context.Context, channelID, cursor string, limit int) ([]store.MemberPublicKey, error)
	GetChannelServerID(ctx context.Context, channelID string) (string, error)
}

// envelopeRecipientChecker checks that envelope recipients exist as server
// members. Accepting a narrow interface keeps tests simple.
type envelopeRecipientChecker interface {
	IsChannelMember(ctx context.Context, channelID, userID string) (bool, error)
	AreServerMembersOfChannel(ctx context.Context, channelID string, userIDs []string) (bool, error)
}

type keyService struct {
	store     store.KeyEnvelopeStorer
	permStore viewChannelChecker
	chatStore envelopeRecipientChecker
	nc        *nats.Conn

	// keyRequestThrottle tracks the last key request time per (userID, channelID)
	// to prevent amplification attacks. Key: "userID:channelID", Value: time.Time.
	keyRequestThrottle sync.Map
}

func newKeyService(s store.KeyEnvelopeStorer, ps viewChannelChecker, cs envelopeRecipientChecker, nc *nats.Conn) *keyService {
	return &keyService{store: s, permStore: ps, chatStore: cs, nc: nc}
}

// validateAndConvertEnvelopes validates proto envelopes and converts them to store types.
func validateAndConvertEnvelopes(protoEnvelopes []*v1.KeyEnvelope) ([]store.KeyEnvelope, error) {
	if len(protoEnvelopes) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("envelopes must not be empty"))
	}
	if len(protoEnvelopes) > maxEnvelopeBatch {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("too many envelopes: max %d, got %d", maxEnvelopeBatch, len(protoEnvelopes)))
	}

	envelopes := make([]store.KeyEnvelope, len(protoEnvelopes))
	for i, pe := range protoEnvelopes {
		if pe.GetUserId() == "" {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("envelope[%d]: user_id is required", i))
		}
		if len(pe.GetEnvelope()) != maxEnvelopeSize {
			return nil, connect.NewError(connect.CodeInvalidArgument,
				fmt.Errorf("envelope[%d]: must be exactly %d bytes, got %d", i, maxEnvelopeSize, len(pe.GetEnvelope())))
		}
		envelopes[i] = store.KeyEnvelope{
			UserID:   pe.GetUserId(),
			Envelope: pe.GetEnvelope(),
		}
	}
	return envelopes, nil
}

// validateEnvelopeRecipients ensures every recipient user ID is a member of the
// server that owns the channel. Returns a CodeInvalidArgument error if any
// recipient is not a server member.
func (s *keyService) validateEnvelopeRecipients(ctx context.Context, channelID string, envelopes []store.KeyEnvelope) error {
	userIDs := make([]string, len(envelopes))
	for i, env := range envelopes {
		userIDs[i] = env.UserID
	}

	allMembers, err := s.chatStore.AreServerMembersOfChannel(ctx, channelID, userIDs)
	if err != nil {
		slog.Error("validate envelope recipients", "channel_id", channelID, "err", err)
		return connect.NewError(connect.CodeInternal, fmt.Errorf("failed to validate envelope recipients"))
	}
	if !allMembers {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("envelope targets non-member"))
	}
	return nil
}

func (s *keyService) RegisterPublicKey(
	ctx context.Context,
	req *connect.Request[v1.RegisterPublicKeyRequest],
) (*connect.Response[v1.RegisterPublicKeyResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	key := req.Msg.GetSigningPublicKey()
	if len(key) != maxPublicKeySize {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("signing_public_key must be exactly %d bytes, got %d", maxPublicKeySize, len(key)))
	}

	if err := s.store.RegisterPublicKey(ctx, userID, key); err != nil {
		if errors.Is(err, store.ErrPublicKeyAlreadyRegistered) {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("signing key already registered"))
		}
		slog.Error("register public key", "user_id", userID, "err", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to register public key"))
	}

	return connect.NewResponse(&v1.RegisterPublicKeyResponse{}), nil
}

func (s *keyService) GetPublicKeys(
	ctx context.Context,
	req *connect.Request[v1.GetPublicKeysRequest],
) (*connect.Response[v1.GetPublicKeysResponse], error) {
	if _, ok := auth.UserIDFromContext(ctx); !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	userIDs := req.Msg.GetUserIds()
	if len(userIDs) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("user_ids must not be empty"))
	}
	if len(userIDs) > maxUserIDsBatch {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("too many user_ids: max %d, got %d", maxUserIDsBatch, len(userIDs)))
	}

	keys, err := s.store.GetPublicKeys(ctx, userIDs)
	if err != nil {
		slog.Error("get public keys", "err", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get public keys"))
	}

	return connect.NewResponse(&v1.GetPublicKeysResponse{PublicKeys: keys}), nil
}

func (s *keyService) StoreKeyEnvelopes(
	ctx context.Context,
	req *connect.Request[v1.StoreKeyEnvelopesRequest],
) (*connect.Response[v1.StoreKeyEnvelopesResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	channelID := req.Msg.GetChannelId()
	if channelID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("channel_id is required"))
	}

	version := req.Msg.GetKeyVersion()
	if version == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("key_version must be > 0"))
	}

	// Caller must have ViewChannel on the channel.
	hasView, err := s.permStore.HasViewChannel(ctx, userID, channelID)
	if err != nil {
		slog.Error("check ViewChannel for StoreKeyEnvelopes", "channel_id", channelID, "user_id", userID, "err", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to check channel permission"))
	}
	if !hasView {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("no ViewChannel permission on this channel"))
	}

	envelopes, err := validateAndConvertEnvelopes(req.Msg.GetEnvelopes())
	if err != nil {
		return nil, err
	}

	// Validate that all envelope recipients are members of the channel's server.
	if err := s.validateEnvelopeRecipients(ctx, channelID, envelopes); err != nil {
		return nil, err
	}

	if err := s.store.StoreKeyEnvelopes(ctx, channelID, version, envelopes); err != nil {
		slog.Error("store key envelopes", "channel_id", channelID, "err", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to store key envelopes"))
	}

	return connect.NewResponse(&v1.StoreKeyEnvelopesResponse{}), nil
}

func (s *keyService) GetKeyEnvelopes(
	ctx context.Context,
	req *connect.Request[v1.GetKeyEnvelopesRequest],
) (*connect.Response[v1.GetKeyEnvelopesResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	channelID := req.Msg.GetChannelId()
	if channelID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("channel_id is required"))
	}

	// Allow access if user has ViewChannel OR has an existing envelope
	// (for decrypting cached messages after ViewChannel revocation).
	hasView, err := s.permStore.HasViewChannel(ctx, userID, channelID)
	if err != nil {
		slog.Error("check ViewChannel for GetKeyEnvelopes", "channel_id", channelID, "user_id", userID, "err", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to check channel permission"))
	}
	if !hasView {
		// Fallback: check if user has existing envelopes (ViewChannel was revoked
		// but they still need to decrypt cached messages with keys they already had).
		isMember, mErr := s.chatStore.IsChannelMember(ctx, channelID, userID)
		if mErr != nil {
			slog.Error("check channel membership fallback", "channel_id", channelID, "user_id", userID, "err", mErr)
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to check channel membership"))
		}
		if !isMember {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("no access to this channel's keys"))
		}
	}

	envelopes, err := s.store.GetKeyEnvelopes(ctx, channelID, userID)
	if err != nil {
		slog.Error("get key envelopes", "channel_id", channelID, "user_id", userID, "err", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get key envelopes"))
	}

	protoEnvelopes := make([]*v1.VersionedKeyEnvelope, len(envelopes))
	for i, env := range envelopes {
		protoEnvelopes[i] = &v1.VersionedKeyEnvelope{
			KeyVersion: env.KeyVersion,
			Envelope:   env.Envelope,
		}
	}

	return connect.NewResponse(&v1.GetKeyEnvelopesResponse{Envelopes: protoEnvelopes}), nil
}

func (s *keyService) RotateChannelKey(
	ctx context.Context,
	req *connect.Request[v1.RotateChannelKeyRequest],
) (*connect.Response[v1.RotateChannelKeyResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	channelID := req.Msg.GetChannelId()
	if channelID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("channel_id is required"))
	}

	// Caller must have ViewChannel on the channel.
	hasView, err := s.permStore.HasViewChannel(ctx, userID, channelID)
	if err != nil {
		slog.Error("check ViewChannel for RotateChannelKey", "channel_id", channelID, "user_id", userID, "err", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to check channel permission"))
	}
	if !hasView {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("no ViewChannel permission on this channel"))
	}

	expectedVersion := req.Msg.GetExpectedVersion()
	// expectedVersion=0 is allowed for atomic initial key creation (lazy init
	// of existing public channels that have no channel_key_versions entry yet).

	envelopes, err := validateAndConvertEnvelopes(req.Msg.GetEnvelopes())
	if err != nil {
		return nil, err
	}

	// Validate that all envelope recipients are members of the channel's server.
	if err := s.validateEnvelopeRecipients(ctx, channelID, envelopes); err != nil {
		return nil, err
	}

	newVersion, err := s.store.RotateChannelKey(ctx, channelID, expectedVersion, envelopes)
	if err != nil {
		if errors.Is(err, store.ErrVersionMismatch) {
			return nil, connect.NewError(connect.CodeAborted,
				fmt.Errorf("key version mismatch for channel %s: expected %d", channelID, expectedVersion))
		}
		slog.Error("rotate channel key", "channel_id", channelID, "expected", expectedVersion, "err", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to rotate channel key"))
	}

	// Publish internal key rotation event for the chat service to create a system message.
	rotationEvent := &v1.KeyRotationInternalEvent{
		ChannelId:     channelID,
		ActorId:       userID,
		NewKeyVersion: newVersion,
	}
	if rotData, err := proto.Marshal(rotationEvent); err != nil {
		slog.Error("marshal key rotation event", "channel_id", channelID, "err", err)
	} else if err := s.nc.Publish(subjects.InternalKeyRotation(), rotData); err != nil {
		slog.Warn("publish key rotation event failed", "channel_id", channelID, "err", err)
	}

	return connect.NewResponse(&v1.RotateChannelKeyResponse{NewVersion: newVersion}), nil
}

const maxMembersPerPage = 1000

func (s *keyService) ListMembersWithViewChannel(
	ctx context.Context,
	req *connect.Request[v1.ListMembersWithViewChannelRequest],
) (*connect.Response[v1.ListMembersWithViewChannelResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	channelID := req.Msg.GetChannelId()
	if channelID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("channel_id is required"))
	}

	// Caller must have ViewChannel on the channel.
	hasView, err := s.permStore.HasViewChannel(ctx, userID, channelID)
	if err != nil {
		slog.Error("check ViewChannel for ListMembersWithViewChannel", "channel_id", channelID, "user_id", userID, "err", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to check channel permission"))
	}
	if !hasView {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("no ViewChannel permission on this channel"))
	}

	limit := int(req.Msg.GetLimit())
	if limit <= 0 || limit > maxMembersPerPage {
		limit = maxMembersPerPage
	}

	// Fetch limit+1 to detect if there's a next page.
	members, err := s.permStore.ListMembersWithViewChannel(ctx, channelID, req.Msg.GetCursor(), limit+1)
	if err != nil {
		slog.Error("list members with ViewChannel", "channel_id", channelID, "err", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list members"))
	}

	var nextCursor string
	if len(members) > limit {
		nextCursor = members[limit-1].UserID
		members = members[:limit]
	}

	protoMembers := make([]*v1.UserPublicKey, len(members))
	for i, m := range members {
		protoMembers[i] = &v1.UserPublicKey{
			UserId:           m.UserID,
			SigningPublicKey: m.SigningPublicKey,
		}
	}

	return connect.NewResponse(&v1.ListMembersWithViewChannelResponse{
		Members:    protoMembers,
		NextCursor: nextCursor,
	}), nil
}

func (s *keyService) RequestChannelKeys(
	ctx context.Context,
	req *connect.Request[v1.RequestChannelKeysRequest],
) (*connect.Response[v1.RequestChannelKeysResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	channelID := req.Msg.GetChannelId()
	if channelID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("channel_id is required"))
	}

	// Per-user, per-channel throttle to prevent amplification attacks.
	// Returns success silently if the same request was made recently.
	throttleKey := userID + ":" + channelID
	if lastReq, ok := s.keyRequestThrottle.Load(throttleKey); ok {
		if time.Since(lastReq.(time.Time)) < keyRequestCooldown {
			return connect.NewResponse(&v1.RequestChannelKeysResponse{}), nil
		}
	}

	// Caller must have ViewChannel on the channel.
	hasView, err := s.permStore.HasViewChannel(ctx, userID, channelID)
	if err != nil {
		slog.Error("check ViewChannel for RequestChannelKeys", "channel_id", channelID, "user_id", userID, "err", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to check channel permission"))
	}
	if !hasView {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("no ViewChannel permission on this channel"))
	}

	// Look up which server owns this channel.
	// DM channels have no server — key requests are only meaningful for server channels.
	serverID, err := s.permStore.GetChannelServerID(ctx, channelID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("key requests are not supported for DM channels"))
		}
		slog.Error("get channel server ID for RequestChannelKeys", "channel_id", channelID, "err", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get channel server"))
	}

	// Build and publish the key request event via NATS.
	event := &v1.Event{
		Type:      v1.EventType_EVENT_TYPE_KEY_REQUEST,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_KeyRequest{
			KeyRequest: &v1.KeyRequestEvent{
				ChannelId: channelID,
				UserId:    userID,
			},
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshal key request event", "err", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to marshal event"))
	}

	if s.nc != nil {
		if err := s.nc.Publish(subjects.ServerMember(serverID), eventData); err != nil {
			slog.Warn("nats publish key request failed", "subject", subjects.ServerMember(serverID), "err", err)
		}
	}

	// Record the request time for throttling.
	s.keyRequestThrottle.Store(throttleKey, time.Now())

	return connect.NewResponse(&v1.RequestChannelKeysResponse{}), nil
}
