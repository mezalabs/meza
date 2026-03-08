package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/redis/go-redis/v9"
	"google.golang.org/protobuf/proto"

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/subjects"
)

// VerifyRecoveryEmail handles OTP send and verify for device recovery pre-authentication.
func (s *authService) VerifyRecoveryEmail(ctx context.Context, req *connect.Request[v1.VerifyRecoveryEmailRequest]) (*connect.Response[v1.VerifyRecoveryEmailResponse], error) {
	r := req.Msg
	if r.Email == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("email is required"))
	}
	if s.redisClient == nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("recovery temporarily unavailable"))
	}

	otpKey := fmt.Sprintf("recovery:otp:%s", r.Email)

	if r.Code == "" {
		// === SEND MODE ===
		// Rate limit: max 5 per hour per email
		rateLimitKey := fmt.Sprintf("ratelimit:recovery:otp_send:%s", r.Email)
		count, err := s.redisClient.Incr(ctx, rateLimitKey).Result()
		if err != nil {
			slog.Error("otp rate limit incr", "err", err)
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("recovery temporarily unavailable"))
		}
		s.redisClient.Expire(ctx, rateLimitKey, 1*time.Hour)
		if count > 5 {
			return nil, connect.NewError(connect.CodeResourceExhausted, errors.New("too many attempts, try again later"))
		}

		// Cooldown: 1 per 60s per email
		cooldownKey := fmt.Sprintf("ratelimit:recovery:otp_cooldown:%s", r.Email)
		set, err := s.redisClient.SetNX(ctx, cooldownKey, "1", 60*time.Second).Result()
		if err != nil {
			slog.Error("otp cooldown setnx", "err", err)
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("recovery temporarily unavailable"))
		}
		if !set {
			return nil, connect.NewError(connect.CodeResourceExhausted, errors.New("please wait before requesting another code"))
		}

		// Generate 6-digit OTP
		n, err := rand.Int(rand.Reader, big.NewInt(1000000))
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		code := fmt.Sprintf("%06d", n.Int64())
		codeHash := sha256.Sum256([]byte(code))
		codeHashHex := hex.EncodeToString(codeHash[:])

		// Look up user (but don't reveal existence)
		user, _, lookupErr := s.store.GetUserByEmail(ctx, r.Email)
		userID := ""
		if lookupErr == nil && user != nil {
			userID = user.ID
		}

		// Store OTP hash in Redis (5-min TTL)
		pipe := s.redisClient.Pipeline()
		pipe.HSet(ctx, otpKey,
			"code_hash", codeHashHex,
			"attempts", 0,
			"user_id", userID,
		)
		pipe.Expire(ctx, otpKey, 5*time.Minute)
		if _, err := pipe.Exec(ctx); err != nil {
			slog.Error("store otp", "err", err)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}

		// Send email async (anti-enumeration: goroutine fires for all emails)
		go func() {
			sendCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			// Only actually send if email exists
			if userID != "" {
				if err := s.emailSender.SendOTP(sendCtx, r.Email, code); err != nil {
					slog.Error("send otp email", "err", err, "email", r.Email)
				}
			}
		}()

		return connect.NewResponse(&v1.VerifyRecoveryEmailResponse{
			Status: "otp_sent",
		}), nil
	}

	// === VERIFY MODE ===
	if len(r.Code) != 6 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("code must be 6 digits"))
	}

	// Check attempts
	attempts, err := s.redisClient.HIncrBy(ctx, otpKey, "attempts", 1).Result()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("no pending verification"))
		}
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if attempts > 5 {
		s.redisClient.Del(ctx, otpKey)
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("too many attempts, code invalidated"))
	}

	// Get stored hash
	storedHash, err := s.redisClient.HGet(ctx, otpKey, "code_hash").Result()
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("no pending verification"))
	}

	// Constant-time comparison
	submittedHash := sha256.Sum256([]byte(r.Code))
	submittedHashHex := hex.EncodeToString(submittedHash[:])
	if !hmac.Equal([]byte(storedHash), []byte(submittedHashHex)) {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("invalid code"))
	}

	// Generate session token
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	sessionToken := hex.EncodeToString(tokenBytes)

	// Store reverse index: token hash -> email (for InitiateDeviceRecovery lookup)
	tokenHash := sha256.Sum256([]byte(sessionToken))
	tokenHashHex := hex.EncodeToString(tokenHash[:])
	tokenIndexKey := fmt.Sprintf("recovery:otp:token:%s", tokenHashHex)

	// Store hashed token (not plaintext) and mark as verified; refresh TTL to 5 minutes
	pipe := s.redisClient.Pipeline()
	pipe.HSet(ctx, otpKey, "session_token_hash", tokenHashHex, "verified", "true")
	pipe.Expire(ctx, otpKey, 5*time.Minute)
	pipe.Set(ctx, tokenIndexKey, r.Email, 5*time.Minute)
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.VerifyRecoveryEmailResponse{
		Status:          "verified",
		OtpSessionToken: sessionToken,
	}), nil
}

// Lua script for atomic OTP validate-and-consume in InitiateDeviceRecovery.
// Checks verified=true and consumed not set, then sets consumed=true.
// ARGV[1] is the SHA-256 hash of the session token (not the raw token).
var otpConsumeScript = redis.NewScript(`
local key = KEYS[1]
local tokenHash = ARGV[1]
local verified = redis.call('HGET', key, 'verified')
if verified ~= 'true' then return 'not_verified' end
local consumed = redis.call('HGET', key, 'consumed')
if consumed == 'true' then return 'already_consumed' end
local stored = redis.call('HGET', key, 'session_token_hash')
if stored ~= tokenHash then return 'invalid_token' end
redis.call('HSET', key, 'consumed', 'true')
local uid = redis.call('HGET', key, 'user_id')
return 'ok:' .. (uid or '')
`)

// Known X25519 low-order points that produce all-zero shared secrets.
var x25519LowOrderPoints = []string{
	"0000000000000000000000000000000000000000000000000000000000000000",
	"0100000000000000000000000000000000000000000000000000000000000000",
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	"e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
	"5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
}

func isLowOrderPoint(pub []byte) bool {
	pubHex := hex.EncodeToString(pub)
	for _, p := range x25519LowOrderPoints {
		if pubHex == p {
			return true
		}
	}
	return false
}

func (s *authService) InitiateDeviceRecovery(ctx context.Context, req *connect.Request[v1.InitiateDeviceRecoveryRequest]) (*connect.Response[v1.InitiateDeviceRecoveryResponse], error) {
	r := req.Msg
	if r.OtpSessionToken == "" || len(r.EphemeralPublicKey) != 32 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("otp_session_token and 32-byte ephemeral_public_key are required"))
	}
	if s.redisClient == nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("recovery temporarily unavailable"))
	}

	// Validate ephemeral pub key is not a low-order point
	if isLowOrderPoint(r.EphemeralPublicKey) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid ephemeral public key"))
	}

	// Look up email from token reverse index
	tokenHash := sha256.Sum256([]byte(r.OtpSessionToken))
	tokenHashHex := hex.EncodeToString(tokenHash[:])
	tokenIndexKey := fmt.Sprintf("recovery:otp:token:%s", tokenHashHex)

	emailAddr, err := s.redisClient.Get(ctx, tokenIndexKey).Result()
	if err != nil {
		// Anti-enumeration: return success even if token is invalid
		return connect.NewResponse(&v1.InitiateDeviceRecoveryResponse{
			SessionId: generateFakeSessionID(s.hmacSecret, r.OtpSessionToken),
		}), nil
	}

	otpKey := fmt.Sprintf("recovery:otp:%s", emailAddr)

	// Atomic validate-and-consume (pass token hash, not raw token)
	result, err := otpConsumeScript.Run(ctx, s.redisClient, []string{otpKey}, tokenHashHex).Text()
	if err != nil {
		slog.Error("otp consume script", "err", err)
		return connect.NewResponse(&v1.InitiateDeviceRecoveryResponse{
			SessionId: generateFakeSessionID(s.hmacSecret, r.OtpSessionToken),
		}), nil
	}

	if result == "not_verified" || result == "already_consumed" || result == "invalid_token" {
		return connect.NewResponse(&v1.InitiateDeviceRecoveryResponse{
			SessionId: generateFakeSessionID(s.hmacSecret, r.OtpSessionToken),
		}), nil
	}

	// result is "ok:<user_id>"
	_, userID, _ := strings.Cut(result, ":")
	if userID == "" {
		// Email doesn't exist — anti-enumeration: return fake session
		return connect.NewResponse(&v1.InitiateDeviceRecoveryResponse{
			SessionId: generateFakeSessionID(s.hmacSecret, r.OtpSessionToken),
		}), nil
	}

	// Rate limit: 3 recovery sessions per account per hour
	rateLimitKey := fmt.Sprintf("ratelimit:recovery:device:%s", emailAddr)
	count, err := s.redisClient.Incr(ctx, rateLimitKey).Result()
	if err != nil {
		slog.Error("device recovery rate limit", "err", err)
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("recovery temporarily unavailable"))
	}
	s.redisClient.Expire(ctx, rateLimitKey, 1*time.Hour)
	if count > 3 {
		return nil, connect.NewError(connect.CodeResourceExhausted, errors.New("too many recovery attempts, try again later"))
	}

	// Generate session ID (32 bytes, hex-encoded)
	sessionIDBytes := make([]byte, 32)
	if _, err := rand.Read(sessionIDBytes); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	sessionID := hex.EncodeToString(sessionIDBytes)

	// Ensure one-session-per-user
	userIndexKey := fmt.Sprintf("device:recovery:user:%s", userID)
	set, err := s.redisClient.SetNX(ctx, userIndexKey, sessionID, 5*time.Minute).Result()
	if err != nil {
		slog.Error("set user recovery index", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !set {
		return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("a recovery session is already active"))
	}

	// Create recovery session via pipeline
	sessionKey := fmt.Sprintf("device:recovery:%s", sessionID)
	pipe := s.redisClient.Pipeline()
	pipe.HSet(ctx, sessionKey,
		"user_id", userID,
		"ephemeral_pub", hex.EncodeToString(r.EphemeralPublicKey),
		"state", "pending",
	)
	pipe.Expire(ctx, sessionKey, 5*time.Minute)
	if _, err := pipe.Exec(ctx); err != nil {
		// Clean up user index
		s.redisClient.Del(ctx, userIndexKey)
		slog.Error("create recovery session", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Publish recovery event via NATS (dual publish)
	if s.nc != nil {
		event := &v1.Event{
			Type: v1.EventType_EVENT_TYPE_DEVICE_RECOVERY_REQUEST,
			Payload: &v1.Event_DeviceRecoveryRequest{
				DeviceRecoveryRequest: &v1.DeviceRecoveryRequestEvent{
					SessionId:          sessionID,
					EphemeralPublicKey: r.EphemeralPublicKey,
				},
			},
		}
		eventData, err := proto.Marshal(event)
		if err != nil {
			slog.Error("marshal recovery event", "err", err)
		} else {
			// Publish to UserSubscription for WebSocket delivery
			if err := s.nc.Publish(subjects.UserSubscription(userID), eventData); err != nil {
				slog.Error("publish recovery event to user subscription", "err", err)
			}
			// Publish to UserRecovery for push notification delivery
			if err := s.nc.Publish(subjects.UserRecovery(userID), eventData); err != nil {
				slog.Error("publish recovery event to user recovery", "err", err)
			}
		}
	}

	return connect.NewResponse(&v1.InitiateDeviceRecoveryResponse{
		SessionId: sessionID,
	}), nil
}

// generateFakeSessionID produces a deterministic fake session ID for anti-enumeration.
func generateFakeSessionID(secret, input string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("device-recovery-fake-session:" + input))
	return hex.EncodeToString(mac.Sum(nil))
}

// Lua script for atomic PollDeviceRecovery state transition.
// If state=approved, atomically transitions to completed, extends TTL, and returns the bundle.
var pollTransitionScript = redis.NewScript(`
local key = KEYS[1]
local state = redis.call('HGET', key, 'state')
if state == nil or state == false then return 'expired' end
if state == 'pending' then return 'pending' end
if state == 'completed' or state == 'done' then return 'completed' end
if state == 'approved' then
    redis.call('HSET', key, 'state', 'completed')
    redis.call('EXPIRE', key, 600)
    local bundle = redis.call('HGET', key, 'wrapped_bundle')
    return 'approved:' .. (bundle or '')
end
return state
`)

func (s *authService) PollDeviceRecovery(ctx context.Context, req *connect.Request[v1.PollDeviceRecoveryRequest]) (*connect.Response[v1.PollDeviceRecoveryResponse], error) {
	if req.Msg.SessionId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("session_id is required"))
	}
	if s.redisClient == nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("recovery temporarily unavailable"))
	}

	sessionKey := fmt.Sprintf("device:recovery:%s", req.Msg.SessionId)

	result, err := pollTransitionScript.Run(ctx, s.redisClient, []string{sessionKey}).Text()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return connect.NewResponse(&v1.PollDeviceRecoveryResponse{Status: "expired"}), nil
		}
		slog.Error("poll recovery", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	switch {
	case result == "expired":
		return connect.NewResponse(&v1.PollDeviceRecoveryResponse{Status: "expired"}), nil
	case result == "pending":
		return connect.NewResponse(&v1.PollDeviceRecoveryResponse{Status: "pending"}), nil
	case result == "completed":
		return connect.NewResponse(&v1.PollDeviceRecoveryResponse{Status: "completed"}), nil
	case len(result) > 9 && result[:9] == "approved:":
		bundleHex := result[9:]
		bundle, err := hex.DecodeString(bundleHex)
		if err != nil {
			slog.Error("decode wrapped bundle", "err", err)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		return connect.NewResponse(&v1.PollDeviceRecoveryResponse{
			Status:        "approved",
			WrappedBundle: bundle,
		}), nil
	default:
		return connect.NewResponse(&v1.PollDeviceRecoveryResponse{Status: "expired"}), nil
	}
}

// Lua script for atomic ApproveDeviceRecovery state transition.
// Checks state=pending, stores wrapped_bundle and approver_device_id, sets state=approved.
var approveTransitionScript = redis.NewScript(`
local key = KEYS[1]
local bundle = ARGV[1]
local deviceID = ARGV[2]
local callerUserID = ARGV[3]
local state = redis.call('HGET', key, 'state')
if state == nil or state == false then return 'expired' end
if state ~= 'pending' then return 'already_approved' end
local sessionUserID = redis.call('HGET', key, 'user_id')
if sessionUserID ~= callerUserID then return 'wrong_user' end
redis.call('HSET', key, 'wrapped_bundle', bundle, 'approver_device_id', deviceID, 'state', 'approved')
return 'ok'
`)

func (s *authService) ApproveDeviceRecovery(ctx context.Context, req *connect.Request[v1.ApproveDeviceRecoveryRequest]) (*connect.Response[v1.ApproveDeviceRecoveryResponse], error) {
	r := req.Msg
	if r.SessionId == "" || len(r.WrappedBundle) != 124 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("session_id and 124-byte wrapped_bundle are required"))
	}

	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}
	deviceID, _ := auth.DeviceIDFromContext(ctx)

	if s.redisClient == nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("recovery temporarily unavailable"))
	}

	sessionKey := fmt.Sprintf("device:recovery:%s", r.SessionId)
	bundleHex := hex.EncodeToString(r.WrappedBundle)

	result, err := approveTransitionScript.Run(ctx, s.redisClient, []string{sessionKey}, bundleHex, deviceID, userID).Text()
	if err != nil {
		slog.Error("approve recovery", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	switch result {
	case "ok":
		return connect.NewResponse(&v1.ApproveDeviceRecoveryResponse{}), nil
	case "expired":
		return nil, connect.NewError(connect.CodeNotFound, errors.New("recovery session expired"))
	case "already_approved":
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("recovery already approved"))
	case "wrong_user":
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not authorized"))
	default:
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
}

// Lua script for CompleteDeviceRecovery: check state is completed, transition to done.
var completeTransitionScript = redis.NewScript(`
local key = KEYS[1]
local state = redis.call('HGET', key, 'state')
if state == nil or state == false then return 'expired' end
if state == 'done' then return 'already_done' end
if state ~= 'completed' then return 'not_ready:' .. state end
redis.call('HSET', key, 'state', 'done')
local approver = redis.call('HGET', key, 'approver_device_id')
local uid = redis.call('HGET', key, 'user_id')
return 'ok:' .. (uid or '') .. ':' .. (approver or '')
`)

func (s *authService) CompleteDeviceRecovery(ctx context.Context, req *connect.Request[v1.CompleteDeviceRecoveryRequest]) (*connect.Response[v1.CompleteDeviceRecoveryResponse], error) {
	r := req.Msg
	if r.SessionId == "" || len(r.NewAuthKey) == 0 || len(r.NewSalt) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("session_id, new_auth_key, and new_salt are required"))
	}
	if len(r.NewEncryptedKeyBundle) == 0 || len(r.NewKeyBundleIv) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("new encrypted key bundle is required"))
	}
	if len(r.NewRecoveryVerifier) != 0 && len(r.NewRecoveryVerifier) != 32 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid new_recovery_verifier length"))
	}
	if s.redisClient == nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("recovery temporarily unavailable"))
	}

	sessionKey := fmt.Sprintf("device:recovery:%s", r.SessionId)

	// Atomic state check: completed -> done
	result, err := completeTransitionScript.Run(ctx, s.redisClient, []string{sessionKey}).Text()
	if err != nil {
		slog.Error("complete recovery transition", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	switch {
	case result == "expired":
		return nil, connect.NewError(connect.CodeNotFound, errors.New("recovery session expired"))
	case result == "already_done":
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("recovery already completed"))
	case len(result) > 4 && result[:3] == "ok:":
		// Parse "ok:<userID>:<approverDeviceID>"
		rest, _ := strings.CutPrefix(result, "ok:")
		userID, approverDeviceID, _ := strings.Cut(rest, ":")

		// Hash new auth key
		newAuthKeyHash, err := auth.HashPassword(string(r.NewAuthKey))
		if err != nil {
			slog.Error("hash new auth key for device recovery", "err", err)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}

		newBundle := models.EncryptedBundle{
			EncryptedKeyBundle:         r.NewEncryptedKeyBundle,
			KeyBundleIV:                r.NewKeyBundleIv,
			RecoveryEncryptedKeyBundle: r.NewRecoveryEncryptedKeyBundle,
			RecoveryKeyBundleIV:        r.NewRecoveryKeyBundleIv,
			RecoveryVerifierHash:       hashRecoveryVerifier(r.NewRecoveryVerifier),
		}

		// Get user email for RecoverAccount
		user, err := s.store.GetUserByID(ctx, userID)
		if err != nil {
			slog.Error("get user for device recovery", "err", err)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}

		// RecoverAccount with verifyVerifier that always returns true
		// (device recovery authorization is the ECIES bundle itself)
		excludeDevices := []string{}
		if approverDeviceID != "" {
			excludeDevices = append(excludeDevices, approverDeviceID)
		}
		_, err = s.store.RecoverAccount(ctx, user.Email, newAuthKeyHash, r.NewSalt, newBundle,
			func(storedHash []byte) bool { return true },
			excludeDevices...,
		)
		if err != nil {
			slog.Error("device recovery account update", "err", err)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}

		// Create new device + JWT for requesting device
		platform := r.Platform
		if platform == "" {
			platform = "web"
		}
		deviceID := models.NewID()
		if err := s.deviceStore.UpsertDevice(ctx, &models.Device{
			ID:       deviceID,
			UserID:   userID,
			Platform: platform,
		}); err != nil {
			slog.Error("create device on device recovery", "err", err, "user", userID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}

		accessToken, refreshToken, err := s.generateTokenPair(userID, deviceID)
		if err != nil {
			slog.Error("generating tokens for device recovery", "err", err, "user", userID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}

		refreshHash := hashToken(refreshToken)
		if err := s.store.StoreRefreshToken(ctx, refreshHash, userID, deviceID, time.Now().Add(30*24*time.Hour)); err != nil {
			slog.Error("storing refresh token on device recovery", "err", err, "user", userID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}

		// Clean up Redis keys (non-fatal)
		go func() {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			pipe := s.redisClient.Pipeline()
			pipe.Del(cleanupCtx, sessionKey)
			pipe.Del(cleanupCtx, fmt.Sprintf("device:recovery:user:%s", userID))
			if _, err := pipe.Exec(cleanupCtx); err != nil {
				slog.Warn("cleanup recovery redis keys", "err", err, "session", r.SessionId)
			}
		}()

		slog.Info("account recovered via device",
			"user_id", userID,
			"action", "device_recovery",
			"approver_device", approverDeviceID,
		)

		return connect.NewResponse(&v1.CompleteDeviceRecoveryResponse{
			AccessToken:  accessToken,
			RefreshToken: refreshToken,
			User:         userToProto(user),
		}), nil

	default:
		if len(result) > 10 && result[:10] == "not_ready:" {
			return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("session not ready: %s", result[10:]))
		}
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
}

func (s *authService) GetPendingRecoveryRequest(ctx context.Context, req *connect.Request[v1.GetPendingRecoveryRequestRequest]) (*connect.Response[v1.GetPendingRecoveryRequestResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}
	if s.redisClient == nil {
		return connect.NewResponse(&v1.GetPendingRecoveryRequestResponse{}), nil
	}

	// O(1) lookup via user index
	userIndexKey := fmt.Sprintf("device:recovery:user:%s", userID)
	sessionID, err := s.redisClient.Get(ctx, userIndexKey).Result()
	if err != nil {
		return connect.NewResponse(&v1.GetPendingRecoveryRequestResponse{}), nil
	}

	// Read session
	sessionKey := fmt.Sprintf("device:recovery:%s", sessionID)
	vals, err := s.redisClient.HGetAll(ctx, sessionKey).Result()
	if err != nil || len(vals) == 0 {
		return connect.NewResponse(&v1.GetPendingRecoveryRequestResponse{}), nil
	}

	// Only return if state is "pending" (not yet approved)
	if vals["state"] != "pending" {
		return connect.NewResponse(&v1.GetPendingRecoveryRequestResponse{}), nil
	}

	ephemeralPub, err := hex.DecodeString(vals["ephemeral_pub"])
	if err != nil {
		slog.Error("decode ephemeral pub", "err", err)
		return connect.NewResponse(&v1.GetPendingRecoveryRequestResponse{}), nil
	}

	return connect.NewResponse(&v1.GetPendingRecoveryRequestResponse{
		SessionId:          sessionID,
		EphemeralPublicKey: ephemeralPub,
	}), nil
}
