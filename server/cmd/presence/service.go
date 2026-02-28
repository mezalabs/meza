package main

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/subjects"
	"github.com/nats-io/nats.go"
	"github.com/redis/go-redis/v9"
)

const presenceTTL = 60 * time.Second

// maxOverrideDuration caps status override durations at 30 days.
const maxOverrideDuration int64 = 30 * 24 * 60 * 60

// membershipChecker verifies whether two users share at least one server.
type membershipChecker interface {
	ShareAnyServer(ctx context.Context, userID1, userID2 string) (bool, error)
}

type presenceService struct {
	rdb     *redis.Client
	nc      *nats.Conn
	members membershipChecker
}

func newPresenceService(rdb *redis.Client, nc *nats.Conn, members membershipChecker) *presenceService {
	return &presenceService{rdb: rdb, nc: nc, members: members}
}

func presenceKey(userID string) string {
	return "presence:" + userID
}

// resolveEffectiveStatus determines the status to expose given a Redis hash
// and whether the caller is the target user themselves.
// Returns the effective status to show.
func resolveEffectiveStatus(result map[string]string, isSelf bool) v1.PresenceStatus {
	realStatus := parsePresenceStatus(result["status"])
	overrideRaw := result["override_status"]
	if overrideRaw == "" || overrideRaw == "0" {
		return realStatus
	}

	overrideStatus := parsePresenceStatus(overrideRaw)

	// Check expiry
	if expiresStr := result["override_expires_at"]; expiresStr != "" && expiresStr != "0" {
		expiresAt, err := strconv.ParseInt(expiresStr, 10, 64)
		if err == nil && time.Now().Unix() > expiresAt {
			// Override has expired — treat as no override
			return realStatus
		}
	}

	switch overrideStatus {
	case v1.PresenceStatus_PRESENCE_STATUS_DND:
		return v1.PresenceStatus_PRESENCE_STATUS_DND
	case v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE, v1.PresenceStatus_PRESENCE_STATUS_OFFLINE:
		if isSelf {
			return overrideStatus
		}
		return v1.PresenceStatus_PRESENCE_STATUS_OFFLINE
	default:
		return realStatus
	}
}

// checkOverrideExpiry checks if a user's override has expired and clears it if so.
// Uses a cheap HGet to avoid reading the full hash on every heartbeat.
func (s *presenceService) checkOverrideExpiry(ctx context.Context, userID string) {
	key := presenceKey(userID)

	// Quick check: only read override_status to avoid a full HGetAll on every heartbeat.
	overrideRaw, err := s.rdb.HGet(ctx, key, "override_status").Result()
	if err != nil || overrideRaw == "" || overrideRaw == "0" {
		return
	}

	expiresStr, err := s.rdb.HGet(ctx, key, "override_expires_at").Result()
	if err != nil || expiresStr == "" || expiresStr == "0" {
		return // indefinite, never auto-expires
	}

	expiresAt, err := strconv.ParseInt(expiresStr, 10, 64)
	if err != nil || time.Now().Unix() <= expiresAt {
		return
	}

	// Override expired — clear it and read real status for broadcast
	s.rdb.HDel(ctx, key, "override_status", "override_expires_at")

	result, err := s.rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return
	}
	realStatus := parsePresenceStatus(result["status"])
	s.publishPresenceUpdate(userID, realStatus, result["status_text"])
}

// publishPresenceUpdate publishes a presence update event to NATS.
func (s *presenceService) publishPresenceUpdate(userID string, status v1.PresenceStatus, statusText string) {
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_PRESENCE_UPDATE,
		Timestamp: timestamppb.Now(),
		Payload: &v1.Event_PresenceUpdate{
			PresenceUpdate: &v1.GetPresenceResponse{
				UserId:     userID,
				Status:     status,
				StatusText: statusText,
			},
		},
	}
	if data, err := proto.Marshal(event); err != nil {
		slog.Error("marshal presence update event", "err", err)
	} else {
		s.nc.Publish(subjects.PresenceUpdate(userID), data)
	}
}

func (s *presenceService) UpdatePresence(ctx context.Context, req *connect.Request[v1.UpdatePresenceRequest]) (*connect.Response[v1.UpdatePresenceResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	key := presenceKey(userID)
	fields := map[string]any{
		"status":    int32(req.Msg.Status),
		"last_seen": time.Now().Unix(),
	}
	if req.Msg.StatusText != nil {
		fields["status_text"] = *req.Msg.StatusText
	}

	// Pipeline: write fields + renew TTL + read back full hash in one round-trip.
	pipe := s.rdb.Pipeline()
	pipe.HSet(ctx, key, fields)
	pipe.Expire(ctx, key, presenceTTL)
	getCmd := pipe.HGetAll(ctx, key)
	if _, err := pipe.Exec(ctx); err != nil {
		slog.Error("update presence", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	result, err := getCmd.Result()
	if err != nil {
		slog.Error("read presence after update", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Broadcast the effective status (respecting any active override).
	effectiveStatus := resolveEffectiveStatus(result, false)
	statusText := ""
	if req.Msg.StatusText != nil {
		statusText = *req.Msg.StatusText
	}
	s.publishPresenceUpdate(userID, effectiveStatus, statusText)

	return connect.NewResponse(&v1.UpdatePresenceResponse{}), nil
}

func (s *presenceService) GetPresence(ctx context.Context, req *connect.Request[v1.GetPresenceRequest]) (*connect.Response[v1.GetPresenceResponse], error) {
	if req.Msg.UserId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}

	callerID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	// Allow querying own presence; otherwise require a shared server.
	if callerID != req.Msg.UserId {
		shared, err := s.members.ShareAnyServer(ctx, callerID, req.Msg.UserId)
		if err != nil {
			slog.Error("check shared server for presence", "err", err, "caller", callerID, "target", req.Msg.UserId)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if !shared {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("no shared server with target user"))
		}
	}

	result, err := s.rdb.HGetAll(ctx, presenceKey(req.Msg.UserId)).Result()
	if err != nil {
		slog.Error("get presence", "err", err, "target_user", req.Msg.UserId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	if len(result) == 0 {
		return connect.NewResponse(&v1.GetPresenceResponse{
			UserId: req.Msg.UserId,
			Status: v1.PresenceStatus_PRESENCE_STATUS_OFFLINE,
		}), nil
	}

	isSelf := callerID == req.Msg.UserId
	status := resolveEffectiveStatus(result, isSelf)
	return connect.NewResponse(&v1.GetPresenceResponse{
		UserId:     req.Msg.UserId,
		Status:     status,
		StatusText: result["status_text"],
	}), nil
}

func (s *presenceService) GetBulkPresence(ctx context.Context, req *connect.Request[v1.GetBulkPresenceRequest]) (*connect.Response[v1.GetBulkPresenceResponse], error) {
	if len(req.Msg.UserIds) == 0 {
		return connect.NewResponse(&v1.GetBulkPresenceResponse{}), nil
	}
	if len(req.Msg.UserIds) > 200 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("too many user IDs (max 200)"))
	}

	callerID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	// Filter to only users who share a server with the caller.
	allowed := make([]string, 0, len(req.Msg.UserIds))
	for _, uid := range req.Msg.UserIds {
		if uid == callerID {
			allowed = append(allowed, uid)
			continue
		}
		shared, err := s.members.ShareAnyServer(ctx, callerID, uid)
		if err != nil {
			slog.Error("check shared server for bulk presence", "err", err, "caller", callerID, "target", uid)
			continue
		}
		if shared {
			allowed = append(allowed, uid)
		}
	}

	if len(allowed) == 0 {
		return connect.NewResponse(&v1.GetBulkPresenceResponse{}), nil
	}

	pipe := s.rdb.Pipeline()
	cmds := make([]*redis.MapStringStringCmd, len(allowed))
	for i, uid := range allowed {
		cmds[i] = pipe.HGetAll(ctx, presenceKey(uid))
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		slog.Error("bulk get presence", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	presences := make([]*v1.GetPresenceResponse, len(allowed))
	for i, uid := range allowed {
		result, _ := cmds[i].Result()
		if len(result) == 0 {
			presences[i] = &v1.GetPresenceResponse{
				UserId: uid,
				Status: v1.PresenceStatus_PRESENCE_STATUS_OFFLINE,
			}
		} else {
			isSelf := uid == callerID
			presences[i] = &v1.GetPresenceResponse{
				UserId:     uid,
				Status:     resolveEffectiveStatus(result, isSelf),
				StatusText: result["status_text"],
			}
		}
	}

	return connect.NewResponse(&v1.GetBulkPresenceResponse{
		Presences: presences,
	}), nil
}

func (s *presenceService) SetStatusOverride(ctx context.Context, req *connect.Request[v1.SetStatusOverrideRequest]) (*connect.Response[v1.SetStatusOverrideResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	// Validate status: only DND, OFFLINE, or INVISIBLE are valid overrides.
	switch req.Msg.Status {
	case v1.PresenceStatus_PRESENCE_STATUS_DND,
		v1.PresenceStatus_PRESENCE_STATUS_OFFLINE,
		v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE:
		// OK
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("status must be DND, OFFLINE, or INVISIBLE"))
	}

	if req.Msg.DurationSeconds < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("duration must be non-negative"))
	}
	if req.Msg.DurationSeconds > maxOverrideDuration {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("duration must not exceed 30 days"))
	}

	key := presenceKey(userID)
	fields := map[string]any{
		"override_status": int32(req.Msg.Status),
	}

	var expiresAt int64
	if req.Msg.DurationSeconds > 0 {
		expiresAt = time.Now().Unix() + req.Msg.DurationSeconds
		fields["override_expires_at"] = expiresAt
	} else {
		fields["override_expires_at"] = 0
	}

	// Pipeline: write override + read back full hash in one round-trip.
	pipe := s.rdb.Pipeline()
	pipe.HSet(ctx, key, fields)
	getCmd := pipe.HGetAll(ctx, key)
	if _, err := pipe.Exec(ctx); err != nil {
		slog.Error("set status override", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Publish NATS event with effective status (INVISIBLE→OFFLINE to others, DND→DND)
	result, _ := getCmd.Result()
	effectiveStatus := resolveEffectiveStatus(result, false)
	s.publishPresenceUpdate(userID, effectiveStatus, result["status_text"])

	return connect.NewResponse(&v1.SetStatusOverrideResponse{
		Status:    req.Msg.Status,
		ExpiresAt: expiresAt,
	}), nil
}

func (s *presenceService) ClearStatusOverride(ctx context.Context, _ *connect.Request[v1.ClearStatusOverrideRequest]) (*connect.Response[v1.ClearStatusOverrideResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	key := presenceKey(userID)
	if err := s.rdb.HDel(ctx, key, "override_status", "override_expires_at").Err(); err != nil {
		slog.Warn("clear status override from redis", "err", err, "user", userID)
	}

	// Read real status and broadcast it.
	result, err := s.rdb.HGetAll(ctx, key).Result()
	if err != nil {
		slog.Warn("read presence after clear override", "err", err, "user", userID)
	}
	realStatus := parsePresenceStatus(result["status"])
	s.publishPresenceUpdate(userID, realStatus, result["status_text"])

	return connect.NewResponse(&v1.ClearStatusOverrideResponse{}), nil
}

func (s *presenceService) GetMyPresence(ctx context.Context, _ *connect.Request[v1.GetMyPresenceRequest]) (*connect.Response[v1.GetMyPresenceResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	key := presenceKey(userID)
	result, err := s.rdb.HGetAll(ctx, key).Result()
	if err != nil {
		slog.Error("get my presence", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	resp := &v1.GetMyPresenceResponse{
		Status:     parsePresenceStatus(result["status"]),
		StatusText: result["status_text"],
	}

	if overrideRaw := result["override_status"]; overrideRaw != "" && overrideRaw != "0" {
		overrideStatus := parsePresenceStatus(overrideRaw)
		var overrideExpiresAt int64
		if expiresStr := result["override_expires_at"]; expiresStr != "" && expiresStr != "0" {
			overrideExpiresAt, _ = strconv.ParseInt(expiresStr, 10, 64)
		}

		// If override expired, clear it inline
		if overrideExpiresAt > 0 && time.Now().Unix() > overrideExpiresAt {
			s.rdb.HDel(ctx, key, "override_status", "override_expires_at")
			// No override to report
		} else {
			resp.OverrideStatus = overrideStatus
			resp.OverrideExpiresAt = overrideExpiresAt
		}
	}

	return connect.NewResponse(resp), nil
}

// StartHeartbeatConsumer subscribes to heartbeat events from the gateway
// and renews presence TTLs in Redis.
func (s *presenceService) StartHeartbeatConsumer() (*nats.Subscription, error) {
	return s.nc.Subscribe(subjects.PresenceHeartbeatWildcard(), func(msg *nats.Msg) {
		// Subject: meza.presence.heartbeat.<userID>
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			return
		}
		userID := parts[3]
		ctx := context.Background()
		s.rdb.Expire(ctx, presenceKey(userID), presenceTTL)
		s.checkOverrideExpiry(ctx, userID)
	})
}

func parsePresenceStatus(s string) v1.PresenceStatus {
	val, err := strconv.Atoi(s)
	if err != nil || val < 0 || val > int(v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE) {
		return v1.PresenceStatus_PRESENCE_STATUS_OFFLINE
	}
	return v1.PresenceStatus(val)
}
