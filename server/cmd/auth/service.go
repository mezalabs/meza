package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/nats-io/nats.go"
	"github.com/redis/go-redis/v9"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/email"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/store"
	"github.com/mezalabs/meza/internal/subjects"
)

type authService struct {
	store          store.AuthStorer
	deviceStore    store.DeviceStorer
	chatStore      store.ChatStorer
	friendStore    store.FriendStorer
	hmacSecret     string              // HMAC secret for anti-enumeration (fake salts/recovery bundles)
	ed25519Keys    *auth.Ed25519Keys   // Ed25519 keys for JWT signing
	instanceURL    string              // This instance's public URL
	redisClient    *redis.Client       // Optional Redis client for rate limiting
	tokenBlocklist *auth.TokenBlocklist // Optional blocklist for revoked devices
	nc             *nats.Conn          // NATS connection for publishing recovery events
	emailSender    email.Sender        // Email sender for OTP
}

func newAuthService(s store.AuthStorer, ds store.DeviceStorer, hmacSecret string, ed25519Keys *auth.Ed25519Keys) *authService {
	return &authService{store: s, deviceStore: ds, hmacSecret: hmacSecret, ed25519Keys: ed25519Keys}
}

// recoveryRateLimit checks per-email rate limiting for recovery endpoints.
// Returns a connect error if the limit is exceeded, nil otherwise.
const recoveryRateLimitMax = 5
const recoveryRateLimitTTL = 1 * time.Hour

func (s *authService) checkRecoveryRateLimit(ctx context.Context, email, endpoint string) error {
	if s.redisClient == nil {
		return connect.NewError(connect.CodeUnavailable, errors.New("recovery temporarily unavailable"))
	}
	key := fmt.Sprintf("ratelimit:recovery:%s:%s", endpoint, email)
	count, err := s.redisClient.Incr(ctx, key).Result()
	if err != nil {
		slog.Error("recovery rate limit incr", "err", err, "email_hash", hashEmailForLog(email))
		return connect.NewError(connect.CodeUnavailable, errors.New("recovery temporarily unavailable"))
	}
	if count == 1 {
		// Only set TTL on first increment (key creation) to prevent sliding-window TOCTOU
		s.redisClient.Expire(ctx, key, recoveryRateLimitTTL)
	}
	if count > recoveryRateLimitMax {
		return connect.NewError(connect.CodeResourceExhausted, errors.New("too many recovery attempts, try again later"))
	}
	return nil
}

// hashRecoveryVerifier returns the SHA-256 hash of a recovery verifier.
// Returns nil if the verifier is empty (pre-migration client).
func hashRecoveryVerifier(verifier []byte) []byte {
	if len(verifier) == 0 {
		return nil
	}
	h := sha256.Sum256(verifier)
	return h[:]
}

// verifyRecoveryVerifier checks that the submitted verifier matches the stored hash.
// Returns true if the hash is nil (pre-migration account with no verifier set).
func verifyRecoveryVerifier(storedHash, submittedVerifier []byte) bool {
	if storedHash == nil {
		return false // no verifier stored — recovery not available for this account
	}
	if len(submittedVerifier) == 0 {
		return false // verifier required but not provided
	}
	h := sha256.Sum256(submittedVerifier)
	return hmac.Equal(storedHash, h[:])
}

// generateTokenPair creates an Ed25519 signed access + refresh JWT pair.
func (s *authService) generateTokenPair(userID, deviceID string) (string, string, error) {
	return auth.GenerateTokenPairEd25519(userID, deviceID, s.ed25519Keys, s.instanceURL, false)
}

func (s *authService) Register(ctx context.Context, req *connect.Request[v1.RegisterRequest]) (*connect.Response[v1.RegisterResponse], error) {
	r := req.Msg
	if r.Email == "" || r.Username == "" || len(r.AuthKey) == 0 || len(r.Salt) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("email, username, auth_key, and salt are required"))
	}
	if len(r.AuthKey) > 128 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("auth_key too large"))
	}
	if !validateEmail(r.Email) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid email format"))
	}
	if !validateUsername(r.Username) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("username must be 3-20 characters: letters, numbers, underscores only"))
	}
	if len(r.RecoveryVerifier) != 0 && len(r.RecoveryVerifier) != 32 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid recovery_verifier length"))
	}
	authKeyHash, err := auth.HashPassword(string(r.AuthKey))
	if err != nil {
		slog.Error("hashing auth key", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	now := time.Now()
	userID := models.NewID()
	deviceID := models.NewID()

	user := &models.User{
		ID:          userID,
		Email:       r.Email,
		Username:    strings.ToLower(r.Username),
		DisplayName: r.Username,
		CreatedAt:   now,
	}

	encBundle := models.EncryptedBundle{
		EncryptedKeyBundle:         r.EncryptedKeyBundle,
		KeyBundleIV:                r.KeyBundleIv,
		RecoveryEncryptedKeyBundle: r.RecoveryEncryptedKeyBundle,
		RecoveryKeyBundleIV:        r.RecoveryKeyBundleIv,
		RecoveryVerifierHash:       hashRecoveryVerifier(r.RecoveryVerifier),
	}

	user, err = s.store.CreateUser(ctx, user, authKeyHash, r.Salt, encBundle)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate") || strings.Contains(err.Error(), "unique") {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("email or username already taken"))
		}
		slog.Error("creating user", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Create a device record with a name and platform derived from the User-Agent header.
	ua := req.Header().Get("User-Agent")
	deviceName := auth.DeviceNameFromUA(ua)
	if err := s.deviceStore.UpsertDevice(ctx, &models.Device{
		ID:         deviceID,
		UserID:     userID,
		DeviceName: deviceName,
		Platform:   auth.PlatformFromUA(ua),
	}); err != nil {
		slog.Error("creating device on register", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	accessToken, refreshToken, err := s.generateTokenPair(userID, deviceID)
	if err != nil {
		slog.Error("generating tokens", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	refreshHash := hashToken(refreshToken)
	if err := s.store.StoreRefreshToken(ctx, refreshHash, userID, deviceID, time.Now().Add(30*24*time.Hour)); err != nil {
		slog.Error("storing refresh token", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.RegisterResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		User:         userToProto(user),
	}), nil
}

func (s *authService) Login(ctx context.Context, req *connect.Request[v1.LoginRequest]) (*connect.Response[v1.LoginResponse], error) {
	r := req.Msg
	if r.Identifier == "" || len(r.AuthKey) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("identifier and auth_key are required"))
	}
	if len(r.AuthKey) > 128 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("auth_key too large"))
	}

	var user *models.User
	var authData *models.AuthData
	var err error
	if isEmail(r.Identifier) {
		user, authData, err = s.store.GetUserByEmail(ctx, r.Identifier)
	} else {
		user, authData, err = s.store.GetUserByUsername(ctx, strings.ToLower(r.Identifier))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid credentials"))
	}

	ok, err := auth.VerifyPassword(authData.AuthKeyHash, string(r.AuthKey))
	if err != nil || !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid credentials"))
	}

	deviceID := models.NewID()

	// Create a device record with a name and platform derived from the User-Agent header.
	ua := req.Header().Get("User-Agent")
	deviceName := auth.DeviceNameFromUA(ua)
	if err := s.deviceStore.UpsertDevice(ctx, &models.Device{
		ID:         deviceID,
		UserID:     user.ID,
		DeviceName: deviceName,
		Platform:   auth.PlatformFromUA(ua),
	}); err != nil {
		slog.Error("creating device on login", "err", err, "user", user.ID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	accessToken, refreshToken, err := s.generateTokenPair(user.ID, deviceID)
	if err != nil {
		slog.Error("generating tokens", "err", err, "user", user.ID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	refreshHash := hashToken(refreshToken)
	if err := s.store.StoreRefreshToken(ctx, refreshHash, user.ID, deviceID, time.Now().Add(30*24*time.Hour)); err != nil {
		slog.Error("storing refresh token", "err", err, "user", user.ID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.LoginResponse{
		AccessToken:        accessToken,
		RefreshToken:       refreshToken,
		User:               userToProto(user),
		EncryptedKeyBundle: authData.EncryptedKeyBundle,
		KeyBundleIv:        authData.KeyBundleIV,
		Salt:               authData.Salt,
	}), nil
}

func (s *authService) Logout(ctx context.Context, req *connect.Request[v1.LogoutRequest]) (*connect.Response[v1.LogoutResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}
	deviceID, _ := auth.DeviceIDFromContext(ctx)
	if deviceID == "" {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("no current device"))
	}

	// Delete refresh tokens for the current device so they cannot be reused.
	if err := s.store.DeleteRefreshTokensByDevice(ctx, userID, deviceID); err != nil {
		slog.Error("logout: delete refresh tokens", "err", err, "user", userID, "device", deviceID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Block the device ID in the token blocklist for 1 hour (matching access token TTL)
	// so any outstanding access tokens are immediately rejected.
	if s.tokenBlocklist != nil {
		if err := s.tokenBlocklist.BlockDevice(ctx, deviceID, 1*time.Hour); err != nil {
			slog.Error("logout: block device", "err", err, "device", deviceID)
			// Non-fatal: refresh tokens are already deleted, access tokens will expire naturally.
		}
	}

	slog.Info("user logged out", "user", userID, "device", deviceID)
	return connect.NewResponse(&v1.LogoutResponse{}), nil
}

func (s *authService) GetSalt(ctx context.Context, req *connect.Request[v1.GetSaltRequest]) (*connect.Response[v1.GetSaltResponse], error) {
	if req.Msg.Identifier == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("identifier is required"))
	}

	identifier := req.Msg.Identifier
	if !isEmail(identifier) {
		identifier = strings.ToLower(identifier)
	}

	var salt []byte
	var err error
	if isEmail(identifier) {
		salt, err = s.store.GetSalt(ctx, identifier)
	} else {
		salt, err = s.store.GetSaltByUsername(ctx, identifier)
	}
	if err != nil {
		// Return a deterministic fake salt for unknown identifiers to prevent
		// enumeration. The client will derive the wrong key and login will
		// fail with "invalid credentials" — indistinguishable from a wrong password.
		salt = deriveFakeSalt(s.hmacSecret, identifier)
	}

	return connect.NewResponse(&v1.GetSaltResponse{Salt: salt}), nil
}

// deriveFakeSalt produces a deterministic 16-byte salt from a secret and identifier.
// Repeated calls with the same identifier return the same salt.
func deriveFakeSalt(secret, identifier string) []byte {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(identifier))
	h := mac.Sum(nil)
	return h[:16]
}

// deriveFakeRecoveryBundle produces deterministic fake recovery bundle data
// (ciphertext, IV, salt) for unknown emails to prevent email enumeration.
// Uses HMAC-SHA256 with domain-separated keys so outputs are independent.
func deriveFakeRecoveryBundle(secret, email string) (ciphertext, iv, salt []byte) {
	derive := func(domain string) []byte {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte(domain + ":" + email))
		return mac.Sum(nil)
	}
	ciphertext = derive("recovery-bundle")       // 32 bytes — plausible encrypted bundle
	iv = derive("recovery-iv")[:12]              // 12 bytes — AES-GCM nonce
	salt = derive("recovery-salt")[:16]          // 16 bytes — matches real salt size
	return
}

func (s *authService) RefreshToken(ctx context.Context, req *connect.Request[v1.RefreshTokenRequest]) (*connect.Response[v1.RefreshTokenResponse], error) {
	if req.Msg.RefreshToken == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("refresh_token is required"))
	}

	// Validate the JWT itself first
	claims, err := auth.ValidateTokenEd25519(req.Msg.RefreshToken, s.ed25519Keys.PublicKey)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid refresh token"))
	}
	if !claims.IsRefresh {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("not a refresh token"))
	}

	tokenHash := hashToken(req.Msg.RefreshToken)
	userID, deviceID, err := s.store.ConsumeRefreshToken(ctx, tokenHash)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("refresh token not found or expired"))
	}

	newAccess, newRefresh, err := s.generateTokenPair(userID, deviceID)
	if err != nil {
		slog.Error("generating tokens", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	newRefreshHash := hashToken(newRefresh)
	if err := s.store.StoreRefreshToken(ctx, newRefreshHash, userID, deviceID, time.Now().Add(30*24*time.Hour)); err != nil {
		slog.Error("storing refresh token", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.RefreshTokenResponse{
		AccessToken:  newAccess,
		RefreshToken: newRefresh,
	}), nil
}

func (s *authService) UpdateProfile(ctx context.Context, req *connect.Request[v1.UpdateProfileRequest]) (*connect.Response[v1.UpdateProfileResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	r := req.Msg

	var displayName *string
	if r.DisplayName != nil {
		trimmed := strings.TrimSpace(*r.DisplayName)
		if len(trimmed) == 0 || len(trimmed) > 32 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("display_name must be 1-32 characters"))
		}
		displayName = &trimmed
	}

	var avatarURL *string
	if r.AvatarUrl != nil {
		v := *r.AvatarUrl
		if v != "" && !validateMediaURL(v) {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("avatar_url must be a /media/ URL"))
		}
		avatarURL = &v
	}

	var emojiScale *float32
	if r.EmojiScale != nil {
		v := *r.EmojiScale
		if v < 1.0 || v > 5.0 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("emoji_scale must be between 1.0 and 5.0"))
		}
		emojiScale = &v
	}

	var bio *string
	if r.Bio != nil {
		trimmed := strings.TrimSpace(*r.Bio)
		if len(trimmed) > 1000 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("bio must be at most 1000 characters"))
		}
		bio = &trimmed
	}

	var pronouns *string
	if r.Pronouns != nil {
		trimmed := strings.TrimSpace(*r.Pronouns)
		if len(trimmed) > 50 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("pronouns must be at most 50 characters"))
		}
		pronouns = &trimmed
	}

	var bannerURL *string
	if r.BannerUrl != nil {
		v := *r.BannerUrl
		if v != "" && !validateMediaURL(v) {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("banner_url must be a /media/ URL"))
		}
		bannerURL = &v
	}

	var themeColorPrimary *string
	if r.ThemeColorPrimary != nil {
		v := *r.ThemeColorPrimary
		if v != "" && !validateHexColor(v) {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("theme_color_primary must be a 6-character hex color"))
		}
		themeColorPrimary = &v
	}

	var themeColorSecondary *string
	if r.ThemeColorSecondary != nil {
		v := *r.ThemeColorSecondary
		if v != "" && !validateHexColor(v) {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("theme_color_secondary must be a 6-character hex color"))
		}
		themeColorSecondary = &v
	}

	var simpleMode *bool
	if r.SimpleMode != nil {
		v := *r.SimpleMode
		simpleMode = &v
	}

	var audioPrefs *models.AudioPreferences
	if r.AudioPreferences != nil {
		audioPrefs = &models.AudioPreferences{
			NoiseSuppression:      r.AudioPreferences.NoiseSuppression,
			EchoCancellation:      r.AudioPreferences.EchoCancellation,
			AutoGainControl:       r.AudioPreferences.AutoGainControl,
			NoiseCancellationMode: r.AudioPreferences.NoiseCancellationMode,
		}
	}

	var dmPrivacy *string
	if r.DmPrivacy != nil {
		v := *r.DmPrivacy
		switch v {
		case "anyone", "message_requests", "friends", "mutual_servers", "nobody":
		default:
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("dm_privacy must be one of: anyone, message_requests, friends, mutual_servers, nobody"))
		}
		dmPrivacy = &v
	}

	var friendRequestPrivacy *string
	if r.FriendRequestPrivacy != nil {
		v := *r.FriendRequestPrivacy
		switch v {
		case "everyone", "server_co_members", "nobody":
		default:
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("friend_request_privacy must be one of: everyone, server_co_members, nobody"))
		}
		friendRequestPrivacy = &v
	}

	var profilePrivacy *string
	if r.ProfilePrivacy != nil {
		v := *r.ProfilePrivacy
		switch v {
		case "everyone", "server_co_members", "friends", "nobody":
		default:
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("profile_privacy must be one of: everyone, server_co_members, friends, nobody"))
		}
		profilePrivacy = &v
	}

	var connections []models.UserConnection
	if r.ClearConnections || len(r.Connections) > 0 {
		if len(r.Connections) > 10 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("max 10 connections allowed"))
		}
		validPlatforms := map[string]bool{
			"github": true, "twitter": true, "twitch": true, "youtube": true,
			"linkedin": true, "website": true, "steam": true, "spotify": true,
			"reddit": true, "other": true,
		}
		connections = make([]models.UserConnection, 0, len(r.Connections))
		for _, c := range r.Connections {
			if !validPlatforms[c.Platform] {
				return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid platform: %s", c.Platform))
			}
			if c.Url == "" {
				return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("connection url is required"))
			}
			if len(c.Url) > 2048 {
				return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("connection url must be at most 2048 characters"))
			}
			if !strings.HasPrefix(c.Url, "https://") && !strings.HasPrefix(c.Url, "http://") {
				return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("connection url must start with https:// or http://"))
			}
			if len(c.Label) > 50 {
				return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("connection label must be at most 50 characters"))
			}
			connections = append(connections, models.UserConnection{
				Platform: c.Platform,
				URL:      c.Url,
				Label:    c.Label,
			})
		}
	}

	user, err := s.store.UpdateUser(ctx, store.UpdateUserParams{
		UserID:               userID,
		DisplayName:          displayName,
		AvatarURL:            avatarURL,
		EmojiScale:           emojiScale,
		Bio:                  bio,
		Pronouns:             pronouns,
		BannerURL:            bannerURL,
		ThemeColorPrimary:    themeColorPrimary,
		ThemeColorSecondary:  themeColorSecondary,
		SimpleMode:           simpleMode,
		AudioPreferences:     audioPrefs,
		DMPrivacy:            dmPrivacy,
		Connections:          connections,
		FriendRequestPrivacy: friendRequestPrivacy,
		ProfilePrivacy:       profilePrivacy,
	})
	if err != nil {
		slog.Error("updating profile", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Broadcast profile update to shared-server members via gateway fanout.
	pubUser := userToPublicProto(user)
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_USER_UPDATE,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_UserUpdate{
			UserUpdate: &v1.UserUpdateEvent{
				User: pubUser,
			},
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling user update event", "err", err)
	} else {
		if err := s.nc.Publish(subjects.UserUpdate(userID), eventData); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.UserUpdate(userID), "err", err)
		}
	}

	return connect.NewResponse(&v1.UpdateProfileResponse{
		User: userToProto(user),
	}), nil
}

func (s *authService) GetProfile(ctx context.Context, req *connect.Request[v1.GetProfileRequest]) (*connect.Response[v1.GetProfileResponse], error) {
	callerID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	if req.Msg.UserId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}

	user, err := s.store.GetUserByID(ctx, req.Msg.UserId)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("user not found"))
		}
		slog.Error("getting profile", "err", err, "target_user", req.Msg.UserId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Apply profile privacy redaction.
	user, err = s.redactProfile(ctx, callerID, user)
	if err != nil {
		return nil, err
	}

	proto := userToProto(user)
	// Strip privacy settings from other users' profiles to prevent information leakage.
	if callerID != req.Msg.UserId {
		proto.DmPrivacy = ""
		proto.FriendRequestPrivacy = ""
		proto.ProfilePrivacy = ""
	}

	return connect.NewResponse(&v1.GetProfileResponse{
		User: proto,
	}), nil
}

// Non-MVP RPCs return Unimplemented.

func (s *authService) RegisterDevice(ctx context.Context, req *connect.Request[v1.RegisterDeviceRequest]) (*connect.Response[v1.RegisterDeviceResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}
	deviceID, _ := auth.DeviceIDFromContext(ctx)
	if deviceID == "" {
		deviceID = models.NewID()
	}

	r := req.Msg
	platform := r.Platform
	if platform == "" {
		platform = "web"
	}
	if platform != "web" && platform != "android" && platform != "ios" && platform != "electron" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("platform must be web, android, ios, or electron"))
	}
	if len(r.DeviceName) > 100 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("device_name must be at most 100 characters"))
	}

	// If the client didn't send a device name, derive one from the User-Agent
	// header so all device-creation paths use the same server-side parser.
	deviceName := r.DeviceName
	if deviceName == "" {
		deviceName = auth.DeviceNameFromUA(req.Header().Get("User-Agent"))
	}

	pushEnabled := false
	if platform == "web" && r.PushEndpoint != nil && *r.PushEndpoint != "" {
		pushEnabled = true
	} else if (platform == "android" || platform == "ios") && r.PushToken != nil && *r.PushToken != "" {
		pushEnabled = true
	}

	device := &models.Device{
		ID:         deviceID,
		UserID:     userID,
		DeviceName: deviceName,
		Platform:   platform,
		PushEnabled: pushEnabled,
	}
	if r.PushEndpoint != nil {
		device.PushEndpoint = *r.PushEndpoint
	}
	if r.PushP256Dh != nil {
		device.PushP256dh = *r.PushP256Dh
	}
	if r.PushAuth != nil {
		device.PushAuth = *r.PushAuth
	}
	if r.PushToken != nil {
		device.PushToken = *r.PushToken
	}

	if err := s.deviceStore.UpsertDevice(ctx, device); err != nil {
		slog.Error("register device", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.RegisterDeviceResponse{
		DeviceId: deviceID,
	}), nil
}

func (s *authService) RevokeDevice(ctx context.Context, req *connect.Request[v1.RevokeDeviceRequest]) (*connect.Response[v1.RevokeDeviceResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}
	if req.Msg.DeviceId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("device_id is required"))
	}

	if err := s.deviceStore.DeleteDevice(ctx, userID, req.Msg.DeviceId); err != nil {
		if strings.Contains(err.Error(), "not found") {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("device not found"))
		}
		slog.Error("revoke device", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Block tokens for the revoked device until they naturally expire (1 hour).
	if s.tokenBlocklist != nil {
		if err := s.tokenBlocklist.BlockDevice(ctx, req.Msg.DeviceId, 1*time.Hour); err != nil {
			slog.Error("blocking revoked device", "err", err, "device", req.Msg.DeviceId)
			// Non-fatal: device is already deleted, tokens will expire naturally.
		}
	}

	return connect.NewResponse(&v1.RevokeDeviceResponse{}), nil
}

func (s *authService) RevokeAllOtherDevices(ctx context.Context, req *connect.Request[v1.RevokeAllOtherDevicesRequest]) (*connect.Response[v1.RevokeAllOtherDevicesResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}
	currentDeviceID, _ := auth.DeviceIDFromContext(ctx)
	if currentDeviceID == "" {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("no current device"))
	}

	deletedIDs, err := s.deviceStore.DeleteAllOtherDevices(ctx, userID, currentDeviceID)
	if err != nil {
		slog.Error("revoke all other devices", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Block tokens for all deleted devices.
	if s.tokenBlocklist != nil && len(deletedIDs) > 0 {
		for _, deviceID := range deletedIDs {
			if err := s.tokenBlocklist.BlockDevice(ctx, deviceID, 1*time.Hour); err != nil {
				slog.Error("blocking revoked device", "err", err, "device", deviceID)
			}
		}
	}

	return connect.NewResponse(&v1.RevokeAllOtherDevicesResponse{
		RevokedCount: int32(len(deletedIDs)),
	}), nil
}

func (s *authService) ListDevices(ctx context.Context, req *connect.Request[v1.ListDevicesRequest]) (*connect.Response[v1.ListDevicesResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	currentDeviceID, _ := auth.DeviceIDFromContext(ctx)

	devices, err := s.deviceStore.GetUserDevices(ctx, userID)
	if err != nil {
		slog.Error("list devices", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoDevices := make([]*v1.Device, len(devices))
	for i, d := range devices {
		protoDevices[i] = &v1.Device{
			Id:          d.ID,
			Name:        d.DeviceName,
			Platform:    d.Platform,
			PushEnabled: d.PushEnabled,
			CreatedAt:   timestamppb.New(d.CreatedAt),
			LastSeenAt:  timestamppb.New(d.LastSeenAt),
			IsCurrent:   d.ID == currentDeviceID,
		}
	}

	return connect.NewResponse(&v1.ListDevicesResponse{
		Devices: protoDevices,
	}), nil
}

func (s *authService) ChangePassword(ctx context.Context, req *connect.Request[v1.ChangePasswordRequest]) (*connect.Response[v1.ChangePasswordResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}
	r := req.Msg
	if len(r.OldAuthKey) == 0 || len(r.NewAuthKey) == 0 || len(r.NewSalt) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("old_auth_key, new_auth_key, and new_salt are required"))
	}
	if len(r.OldAuthKey) > 128 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("auth_key too large"))
	}
	if len(r.NewAuthKey) > 128 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("auth_key too large"))
	}
	if len(r.NewRecoveryVerifier) != 0 && len(r.NewRecoveryVerifier) != 32 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid new_recovery_verifier length"))
	}

	// Verify old password by fetching current auth data.
	ad, err := s.store.GetAuthDataByUserID(ctx, userID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	if ok, err := auth.VerifyPassword(ad.AuthKeyHash, string(r.OldAuthKey)); err != nil || !ok {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("invalid old password"))
	}

	newAuthKeyHash, err := auth.HashPassword(string(r.NewAuthKey))
	if err != nil {
		slog.Error("hashing new auth key", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	newBundle := models.EncryptedBundle{
		EncryptedKeyBundle:         r.NewEncryptedKeyBundle,
		KeyBundleIV:                r.NewKeyBundleIv,
		RecoveryEncryptedKeyBundle: r.NewRecoveryEncryptedKeyBundle,
		RecoveryKeyBundleIV:        r.NewRecoveryKeyBundleIv,
		RecoveryVerifierHash:       hashRecoveryVerifier(r.NewRecoveryVerifier),
	}

	if err := s.store.ChangePassword(ctx, userID, ad.AuthKeyHash, newAuthKeyHash, r.NewSalt, newBundle); err != nil {
		slog.Error("changing password", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.ChangePasswordResponse{}), nil
}

func (s *authService) GetKeyBundle(ctx context.Context, req *connect.Request[v1.GetKeyBundleRequest]) (*connect.Response[v1.GetKeyBundleResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	bundle, err := s.store.GetKeyBundle(ctx, userID)
	if err != nil {
		slog.Error("getting key bundle", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.GetKeyBundleResponse{
		EncryptedKeyBundle: bundle.EncryptedKeyBundle,
		KeyBundleIv:        bundle.KeyBundleIV,
	}), nil
}

func (s *authService) GetRecoveryBundle(ctx context.Context, req *connect.Request[v1.GetRecoveryBundleRequest]) (*connect.Response[v1.GetRecoveryBundleResponse], error) {
	if req.Msg.Email == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("email is required"))
	}

	if err := s.checkRecoveryRateLimit(ctx, req.Msg.Email, "bundle"); err != nil {
		return nil, err
	}

	recoveryBundle, recoveryIV, salt, err := s.store.GetRecoveryBundle(ctx, req.Msg.Email)
	if err != nil {
		if strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "no recovery") {
			// Return a deterministic fake recovery bundle for unknown emails
			// to prevent email enumeration. The client will fail to decrypt
			// with their recovery key — indistinguishable from a wrong phrase.
			fakeCiphertext, fakeIV, fakeSalt := deriveFakeRecoveryBundle(s.hmacSecret, req.Msg.Email)
			return connect.NewResponse(&v1.GetRecoveryBundleResponse{
				RecoveryEncryptedKeyBundle: fakeCiphertext,
				RecoveryKeyBundleIv:        fakeIV,
				Salt:                        fakeSalt,
			}), nil
		}
		slog.Error("getting recovery bundle", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.GetRecoveryBundleResponse{
		RecoveryEncryptedKeyBundle: recoveryBundle,
		RecoveryKeyBundleIv:        recoveryIV,
		Salt:                        salt,
	}), nil
}

func (s *authService) RecoverAccount(ctx context.Context, req *connect.Request[v1.RecoverAccountRequest]) (*connect.Response[v1.RecoverAccountResponse], error) {
	r := req.Msg
	if r.Email == "" || len(r.NewAuthKey) == 0 || len(r.NewSalt) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("email, new_auth_key, and new_salt are required"))
	}
	if len(r.NewEncryptedKeyBundle) == 0 || len(r.NewKeyBundleIv) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("new encrypted key bundle is required"))
	}
	if len(r.RecoveryVerifier) != 0 && len(r.RecoveryVerifier) != 32 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid recovery_verifier length"))
	}
	if len(r.NewRecoveryVerifier) != 0 && len(r.NewRecoveryVerifier) != 32 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid new_recovery_verifier length"))
	}

	if err := s.checkRecoveryRateLimit(ctx, r.Email, "account"); err != nil {
		return nil, err
	}

	newAuthKeyHash, err := auth.HashPassword(string(r.NewAuthKey))
	if err != nil {
		slog.Error("hashing new auth key for recovery", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	newBundle := models.EncryptedBundle{
		EncryptedKeyBundle:         r.NewEncryptedKeyBundle,
		KeyBundleIV:                r.NewKeyBundleIv,
		RecoveryEncryptedKeyBundle: r.NewRecoveryEncryptedKeyBundle,
		RecoveryKeyBundleIV:        r.NewRecoveryKeyBundleIv,
		RecoveryVerifierHash:       hashRecoveryVerifier(r.NewRecoveryVerifier),
	}

	// Verifier check happens inside the transaction (FOR UPDATE) to prevent TOCTOU races.
	userID, err := s.store.RecoverAccount(ctx, r.Email, newAuthKeyHash, r.NewSalt, newBundle, func(storedHash []byte) bool {
		return verifyRecoveryVerifier(storedHash, r.RecoveryVerifier)
	})
	if err != nil {
		if errors.Is(err, store.ErrInvalidRecoveryProof) || strings.Contains(err.Error(), "not found") {
			// Same error for not-found and invalid proof — prevent email enumeration
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("recovery failed"))
		}
		slog.Error("recovering account", "err", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Refresh tokens already deleted inside RecoverAccount transaction.
	deviceID := models.NewID()
	ua := req.Header().Get("User-Agent")
	deviceName := auth.DeviceNameFromUA(ua)
	if err := s.deviceStore.UpsertDevice(ctx, &models.Device{
		ID:         deviceID,
		UserID:     userID,
		DeviceName: deviceName,
		Platform:   auth.PlatformFromUA(ua),
	}); err != nil {
		slog.Error("creating device on recovery", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	accessToken, refreshToken, err := s.generateTokenPair(userID, deviceID)
	if err != nil {
		slog.Error("generating tokens for recovery", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	refreshHash := hashToken(refreshToken)
	if err := s.store.StoreRefreshToken(ctx, refreshHash, userID, deviceID, time.Now().Add(30*24*time.Hour)); err != nil {
		slog.Error("storing refresh token on recovery", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	user, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		slog.Error("getting user after recovery", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.RecoverAccountResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		User:         userToProto(user),
	}), nil
}

// redactProfile returns a minimal profile if the caller is not allowed to see
// the target's full profile based on profile_privacy settings.
func (s *authService) redactProfile(ctx context.Context, callerID string, target *models.User) (*models.User, error) {
	if callerID == target.ID {
		return target, nil
	}
	switch target.ProfilePrivacy {
	case "nobody":
		return minimalProfile(target), nil
	case "friends":
		areFriends, err := s.friendStore.AreFriends(ctx, callerID, target.ID)
		if err != nil {
			slog.Error("checking friendship for profile privacy", "err", err)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if !areFriends {
			return minimalProfile(target), nil
		}
	case "server_co_members":
		areFriends, err := s.friendStore.AreFriends(ctx, callerID, target.ID)
		if err != nil {
			slog.Error("checking friendship for profile privacy", "err", err)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if !areFriends {
			mutual, err := s.chatStore.ShareAnyServer(ctx, callerID, target.ID)
			if err != nil {
				slog.Error("checking mutual servers for profile privacy", "err", err)
				return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
			}
			if !mutual {
				return minimalProfile(target), nil
			}
		}
	}
	return target, nil
}

func minimalProfile(u *models.User) *models.User {
	return &models.User{
		ID:          u.ID,
		Username:    u.Username,
		DisplayName: u.DisplayName,
		AvatarURL:   u.AvatarURL,
	}
}

func userToProto(u *models.User) *v1.User {
	proto := &v1.User{
		Id:                   u.ID,
		Username:             u.Username,
		DisplayName:          u.DisplayName,
		AvatarUrl:            u.AvatarURL,
		EmojiScale:           u.EmojiScale,
		CreatedAt:            timestamppb.New(u.CreatedAt),
		Bio:                  u.Bio,
		Pronouns:             u.Pronouns,
		BannerUrl:            u.BannerURL,
		ThemeColorPrimary:    u.ThemeColorPrimary,
		ThemeColorSecondary:  u.ThemeColorSecondary,
		SimpleMode:           u.SimpleMode,
		AudioPreferences: &v1.AudioPreferences{
			NoiseSuppression:      u.AudioPreferences.NoiseSuppression,
			EchoCancellation:      u.AudioPreferences.EchoCancellation,
			AutoGainControl:       u.AudioPreferences.AutoGainControl,
			NoiseCancellationMode: u.AudioPreferences.NoiseCancellationMode,
		},
		DmPrivacy:            u.DMPrivacy,
		FriendRequestPrivacy: u.FriendRequestPrivacy,
		ProfilePrivacy:       u.ProfilePrivacy,
	}
	for _, c := range u.Connections {
		proto.Connections = append(proto.Connections, &v1.UserConnection{
			Platform: c.Platform,
			Url:      c.URL,
			Label:    c.Label,
		})
	}
	return proto
}

func userToPublicProto(u *models.User) *v1.PublicUser {
	return &v1.PublicUser{
		Id:                  u.ID,
		Username:            u.Username,
		DisplayName:         u.DisplayName,
		AvatarUrl:           u.AvatarURL,
		Bio:                 u.Bio,
		Pronouns:            u.Pronouns,
		BannerUrl:           u.BannerURL,
		ThemeColorPrimary:   u.ThemeColorPrimary,
		ThemeColorSecondary: u.ThemeColorSecondary,
	}
}

func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// hashEmailForLog returns a truncated SHA-256 hash of the email for logging
// without exposing PII. First 4 bytes = 8 hex characters.
func hashEmailForLog(email string) string {
	h := sha256.Sum256([]byte(email))
	return hex.EncodeToString(h[:4])
}
