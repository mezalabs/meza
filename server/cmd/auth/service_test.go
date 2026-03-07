package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/gen/meza/v1/mezav1connect"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/testutil"
)

// mockAuthStore implements store.AuthStorer for testing.
type mockAuthStore struct {
	mu            sync.Mutex
	users         map[string]*models.User
	authData      map[string]*models.AuthData
	salts         map[string][]byte // email -> salt
	refreshTokens map[string]refreshEntry
}

type refreshEntry struct {
	userID    string
	deviceID  string
	expiresAt time.Time
}

func newMockAuthStore() *mockAuthStore {
	return &mockAuthStore{
		users:         make(map[string]*models.User),
		authData:      make(map[string]*models.AuthData),
		salts:         make(map[string][]byte),
		refreshTokens: make(map[string]refreshEntry),
	}
}

func (m *mockAuthStore) CreateUser(_ context.Context, user *models.User, authKeyHash string, salt []byte, encBundle models.EncryptedBundle) (*models.User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, u := range m.users {
		if u.Email == user.Email {
			return nil, fmt.Errorf("duplicate key: email unique constraint")
		}
		if u.Username == user.Username {
			return nil, fmt.Errorf("duplicate key: username unique constraint")
		}
	}

	m.users[user.ID] = user
	m.authData[user.ID] = &models.AuthData{
		UserID:             user.ID,
		AuthKeyHash:        authKeyHash,
		Salt:               salt,
		EncryptedKeyBundle: encBundle.EncryptedKeyBundle,
		KeyBundleIV:        encBundle.KeyBundleIV,
	}
	m.salts[user.Email] = salt
	return user, nil
}

func (m *mockAuthStore) GetUserByEmail(_ context.Context, email string) (*models.User, *models.AuthData, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, u := range m.users {
		if u.Email == email {
			return u, m.authData[u.ID], nil
		}
	}
	return nil, nil, fmt.Errorf("user not found")
}

func (m *mockAuthStore) GetUserByUsername(_ context.Context, username string) (*models.User, *models.AuthData, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, u := range m.users {
		if u.Username == username {
			return u, m.authData[u.ID], nil
		}
	}
	return nil, nil, fmt.Errorf("user not found")
}

func (m *mockAuthStore) GetUserByID(_ context.Context, userID string) (*models.User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	u, ok := m.users[userID]
	if !ok {
		return nil, fmt.Errorf("user not found")
	}
	return u, nil
}

func (m *mockAuthStore) UpdateUser(_ context.Context, userID string, displayName, avatarURL *string, emojiScale *float32, bio, pronouns, bannerURL, themeColorPrimary, themeColorSecondary *string, _ *bool, audioPreferences *models.AudioPreferences, dmPrivacy *string, connections []models.UserConnection) (*models.User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	u, ok := m.users[userID]
	if !ok {
		return nil, fmt.Errorf("user not found")
	}
	if displayName != nil {
		u.DisplayName = *displayName
	}
	if avatarURL != nil {
		u.AvatarURL = *avatarURL
	}
	if emojiScale != nil {
		u.EmojiScale = *emojiScale
	}
	if bio != nil {
		u.Bio = *bio
	}
	if pronouns != nil {
		u.Pronouns = *pronouns
	}
	if bannerURL != nil {
		u.BannerURL = *bannerURL
	}
	if themeColorPrimary != nil {
		u.ThemeColorPrimary = *themeColorPrimary
	}
	if themeColorSecondary != nil {
		u.ThemeColorSecondary = *themeColorSecondary
	}
	if audioPreferences != nil {
		u.AudioPreferences = *audioPreferences
	}
	if dmPrivacy != nil {
		u.DMPrivacy = *dmPrivacy
	}
	if connections != nil {
		u.Connections = connections
	}
	return u, nil
}

func (m *mockAuthStore) GetSalt(_ context.Context, email string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	salt, ok := m.salts[email]
	if !ok {
		return nil, fmt.Errorf("user not found")
	}
	return salt, nil
}

func (m *mockAuthStore) GetSaltByUsername(_ context.Context, username string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, u := range m.users {
		if u.Username == username {
			salt, ok := m.salts[u.Email]
			if !ok {
				return nil, fmt.Errorf("user not found")
			}
			return salt, nil
		}
	}
	return nil, fmt.Errorf("user not found")
}

func (m *mockAuthStore) StoreRefreshToken(_ context.Context, tokenHash, userID, deviceID string, expiresAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.refreshTokens[tokenHash] = refreshEntry{userID: userID, deviceID: deviceID, expiresAt: expiresAt}
	return nil
}

func (m *mockAuthStore) DeleteRefreshTokensByUser(_ context.Context, userID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	for hash, entry := range m.refreshTokens {
		if entry.userID == userID {
			delete(m.refreshTokens, hash)
		}
	}
	return nil
}

func (m *mockAuthStore) ConsumeRefreshToken(_ context.Context, tokenHash string) (string, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	entry, ok := m.refreshTokens[tokenHash]
	if !ok {
		return "", "", fmt.Errorf("refresh token not found")
	}
	delete(m.refreshTokens, tokenHash)
	if time.Now().After(entry.expiresAt) {
		return "", "", fmt.Errorf("refresh token expired")
	}
	return entry.userID, entry.deviceID, nil
}

func (m *mockAuthStore) GetKeyBundle(_ context.Context, userID string) (*models.EncryptedBundle, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	ad, ok := m.authData[userID]
	if !ok {
		return nil, fmt.Errorf("user not found")
	}
	return &models.EncryptedBundle{
		EncryptedKeyBundle: ad.EncryptedKeyBundle,
		KeyBundleIV:        ad.KeyBundleIV,
	}, nil
}

func (m *mockAuthStore) ChangePassword(_ context.Context, userID, oldAuthKeyHash, newAuthKeyHash string, newSalt []byte, newBundle models.EncryptedBundle) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	ad, ok := m.authData[userID]
	if !ok {
		return fmt.Errorf("user not found")
	}
	if ad.AuthKeyHash != oldAuthKeyHash {
		return fmt.Errorf("invalid old password")
	}
	ad.AuthKeyHash = newAuthKeyHash
	ad.Salt = newSalt
	ad.EncryptedKeyBundle = newBundle.EncryptedKeyBundle
	ad.KeyBundleIV = newBundle.KeyBundleIV
	return nil
}

func (m *mockAuthStore) GetRecoveryBundle(_ context.Context, email string) ([]byte, []byte, []byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, u := range m.users {
		if u.Email == email {
			ad := m.authData[u.ID]
			return nil, nil, ad.Salt, nil
		}
	}
	return nil, nil, nil, fmt.Errorf("user not found")
}

func (m *mockAuthStore) RecoverAccount(_ context.Context, email, newAuthKeyHash string, newSalt []byte, newBundle models.EncryptedBundle) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, u := range m.users {
		if u.Email == email {
			ad := m.authData[u.ID]
			ad.AuthKeyHash = newAuthKeyHash
			ad.Salt = newSalt
			ad.EncryptedKeyBundle = newBundle.EncryptedKeyBundle
			ad.KeyBundleIV = newBundle.KeyBundleIV
			return u.ID, nil
		}
	}
	return "", fmt.Errorf("user not found")
}

// mockDeviceStore implements store.DeviceStorer for testing.
type mockDeviceStore struct {
	mu      sync.Mutex
	devices map[string]*models.Device // deviceID -> device
}

func newMockDeviceStore() *mockDeviceStore {
	return &mockDeviceStore{devices: make(map[string]*models.Device)}
}

func (m *mockDeviceStore) UpsertDevice(_ context.Context, device *models.Device) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.devices[device.ID] = device
	return nil
}

func (m *mockDeviceStore) GetDevice(_ context.Context, userID, deviceID string) (*models.Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.devices[deviceID]
	if !ok || d.UserID != userID {
		return nil, nil
	}
	return d, nil
}

func (m *mockDeviceStore) GetUserDevices(_ context.Context, userID string) ([]*models.Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var result []*models.Device
	for _, d := range m.devices {
		if d.UserID == userID {
			result = append(result, d)
		}
	}
	return result, nil
}

func (m *mockDeviceStore) GetPushEnabledDevices(_ context.Context, userID string) ([]*models.Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var result []*models.Device
	for _, d := range m.devices {
		if d.UserID == userID && d.PushEnabled {
			result = append(result, d)
		}
	}
	return result, nil
}

func (m *mockDeviceStore) GetPushEnabledDevicesForUsers(_ context.Context, userIDs []string) (map[string][]*models.Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	idSet := make(map[string]bool, len(userIDs))
	for _, id := range userIDs {
		idSet[id] = true
	}
	result := make(map[string][]*models.Device)
	for _, d := range m.devices {
		if idSet[d.UserID] && d.PushEnabled {
			result[d.UserID] = append(result[d.UserID], d)
		}
	}
	return result, nil
}

func (m *mockDeviceStore) DeleteDevice(_ context.Context, userID, deviceID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.devices[deviceID]
	if !ok || d.UserID != userID {
		return fmt.Errorf("device not found")
	}
	delete(m.devices, deviceID)
	return nil
}

func (m *mockDeviceStore) TouchLastSeen(_ context.Context, _, _ string) error { return nil }

func (m *mockDeviceStore) PruneStaleDevices(_ context.Context, _ time.Duration) (int64, error) {
	return 0, nil
}

func setupTestServer(t *testing.T) (mezav1connect.AuthServiceClient, *mockAuthStore) {
	t.Helper()
	mockStore := newMockAuthStore()
	mockDevices := newMockDeviceStore()
	svc := newAuthService(mockStore, mockDevices, testutil.TestHMACSecret, testutil.TestEd25519Keys)

	mux := http.NewServeMux()
	path, handler := mezav1connect.NewAuthServiceHandler(svc,
		connect.WithInterceptors(auth.NewOptionalConnectInterceptor(testutil.TestEd25519Keys.PublicKey)),
	)
	mux.Handle(path, handler)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	client := mezav1connect.NewAuthServiceClient(http.DefaultClient, server.URL)
	return client, mockStore
}

func makeRegisterRequest() *v1.RegisterRequest {
	return &v1.RegisterRequest{
		Email:              "test@example.com",
		Username:           "testuser",
		AuthKey:            []byte("my-auth-key"),
		Salt:               []byte("random-salt-bytes"),
		EncryptedKeyBundle: []byte("encrypted-bundle"),
		KeyBundleIv:        []byte("iv-bytes"),
	}
}

func TestRegisterLoginRoundTrip(t *testing.T) {
	client, _ := setupTestServer(t)

	// Register
	regResp, err := client.Register(context.Background(), connect.NewRequest(makeRegisterRequest()))
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if regResp.Msg.AccessToken == "" {
		t.Error("expected access token")
	}
	if regResp.Msg.RefreshToken == "" {
		t.Error("expected refresh token")
	}
	if regResp.Msg.User == nil || regResp.Msg.User.Username != "testuser" {
		t.Error("expected user with username 'testuser'")
	}

	// Validate access token works
	claims, err := auth.ValidateTokenEd25519(regResp.Msg.AccessToken, testutil.TestEd25519Keys.PublicKey)
	if err != nil {
		t.Fatalf("ValidateTokenEd25519: %v", err)
	}
	if claims.UserID == "" {
		t.Error("expected userID in claims")
	}

	// Login with same credentials
	loginResp, err := client.Login(context.Background(), connect.NewRequest(&v1.LoginRequest{
		Identifier: "test@example.com",
		AuthKey:    []byte("my-auth-key"),
	}))
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if loginResp.Msg.AccessToken == "" {
		t.Error("expected access token from login")
	}
	if len(loginResp.Msg.EncryptedKeyBundle) == 0 {
		t.Error("expected encrypted key bundle")
	}
	if len(loginResp.Msg.Salt) == 0 {
		t.Error("expected salt")
	}
}

func TestRegisterDuplicateEmail(t *testing.T) {
	client, _ := setupTestServer(t)

	_, err := client.Register(context.Background(), connect.NewRequest(makeRegisterRequest()))
	if err != nil {
		t.Fatalf("first Register: %v", err)
	}

	_, err = client.Register(context.Background(), connect.NewRequest(makeRegisterRequest()))
	if err == nil {
		t.Fatal("expected error for duplicate email")
	}
	if connect.CodeOf(err) != connect.CodeAlreadyExists {
		t.Errorf("code = %v, want AlreadyExists", connect.CodeOf(err))
	}
}

func TestRegisterDuplicateUsername(t *testing.T) {
	client, _ := setupTestServer(t)

	_, err := client.Register(context.Background(), connect.NewRequest(makeRegisterRequest()))
	if err != nil {
		t.Fatalf("first Register: %v", err)
	}

	req := makeRegisterRequest()
	req.Email = "other@example.com"
	_, err = client.Register(context.Background(), connect.NewRequest(req))
	if err == nil {
		t.Fatal("expected error for duplicate username")
	}
	if connect.CodeOf(err) != connect.CodeAlreadyExists {
		t.Errorf("code = %v, want AlreadyExists", connect.CodeOf(err))
	}
}

func TestLoginWrongPassword(t *testing.T) {
	client, _ := setupTestServer(t)

	_, err := client.Register(context.Background(), connect.NewRequest(makeRegisterRequest()))
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	_, err = client.Login(context.Background(), connect.NewRequest(&v1.LoginRequest{
		Identifier: "test@example.com",
		AuthKey:    []byte("wrong-key"),
	}))
	if err == nil {
		t.Fatal("expected error for wrong password")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

func TestGetSaltKnownEmail(t *testing.T) {
	client, _ := setupTestServer(t)

	_, err := client.Register(context.Background(), connect.NewRequest(makeRegisterRequest()))
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	resp, err := client.GetSalt(context.Background(), connect.NewRequest(&v1.GetSaltRequest{
		Identifier: "test@example.com",
	}))
	if err != nil {
		t.Fatalf("GetSalt: %v", err)
	}
	if len(resp.Msg.Salt) == 0 {
		t.Error("expected non-empty salt")
	}
}

func TestGetSaltUnknownEmail(t *testing.T) {
	client, _ := setupTestServer(t)

	// Unknown emails should return a fake salt (not an error) to prevent
	// email enumeration. The salt is deterministic per email.
	resp, err := client.GetSalt(context.Background(), connect.NewRequest(&v1.GetSaltRequest{
		Identifier: "unknown@example.com",
	}))
	if err != nil {
		t.Fatalf("GetSalt should succeed for unknown emails: %v", err)
	}
	if len(resp.Msg.Salt) == 0 {
		t.Error("expected non-empty fake salt")
	}

	// Same email should produce the same fake salt (deterministic).
	resp2, err := client.GetSalt(context.Background(), connect.NewRequest(&v1.GetSaltRequest{
		Identifier: "unknown@example.com",
	}))
	if err != nil {
		t.Fatalf("GetSalt: %v", err)
	}
	if string(resp.Msg.Salt) != string(resp2.Msg.Salt) {
		t.Error("expected deterministic salt for same email")
	}
}

func TestRefreshTokenRotation(t *testing.T) {
	client, _ := setupTestServer(t)

	regResp, err := client.Register(context.Background(), connect.NewRequest(makeRegisterRequest()))
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	// Use refresh token
	refreshResp, err := client.RefreshToken(context.Background(), connect.NewRequest(&v1.RefreshTokenRequest{
		RefreshToken: regResp.Msg.RefreshToken,
	}))
	if err != nil {
		t.Fatalf("RefreshToken: %v", err)
	}
	if refreshResp.Msg.AccessToken == "" {
		t.Error("expected new access token")
	}
	if refreshResp.Msg.RefreshToken == "" {
		t.Error("expected new refresh token")
	}

	// Old refresh token should be consumed
	_, err = client.RefreshToken(context.Background(), connect.NewRequest(&v1.RefreshTokenRequest{
		RefreshToken: regResp.Msg.RefreshToken,
	}))
	if err == nil {
		t.Fatal("expected error for consumed refresh token")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

func TestRegisterInvalidUsername(t *testing.T) {
	client, _ := setupTestServer(t)

	req := makeRegisterRequest()
	req.Username = "ab" // too short
	_, err := client.Register(context.Background(), connect.NewRequest(req))
	if err == nil {
		t.Fatal("expected error for short username")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestLoginByUsername(t *testing.T) {
	client, _ := setupTestServer(t)

	_, err := client.Register(context.Background(), connect.NewRequest(makeRegisterRequest()))
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	// Login with username instead of email
	loginResp, err := client.Login(context.Background(), connect.NewRequest(&v1.LoginRequest{
		Identifier: "testuser",
		AuthKey:    []byte("my-auth-key"),
	}))
	if err != nil {
		t.Fatalf("Login by username: %v", err)
	}
	if loginResp.Msg.AccessToken == "" {
		t.Error("expected access token from login by username")
	}
	if loginResp.Msg.User == nil || loginResp.Msg.User.Username != "testuser" {
		t.Error("expected user with username 'testuser'")
	}
}

func TestGetSaltByUsername(t *testing.T) {
	client, _ := setupTestServer(t)

	_, err := client.Register(context.Background(), connect.NewRequest(makeRegisterRequest()))
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	// Get salt by username
	resp, err := client.GetSalt(context.Background(), connect.NewRequest(&v1.GetSaltRequest{
		Identifier: "testuser",
	}))
	if err != nil {
		t.Fatalf("GetSalt by username: %v", err)
	}
	if len(resp.Msg.Salt) == 0 {
		t.Error("expected non-empty salt")
	}

	// Should match salt retrieved by email
	respByEmail, err := client.GetSalt(context.Background(), connect.NewRequest(&v1.GetSaltRequest{
		Identifier: "test@example.com",
	}))
	if err != nil {
		t.Fatalf("GetSalt by email: %v", err)
	}
	if string(resp.Msg.Salt) != string(respByEmail.Msg.Salt) {
		t.Error("expected same salt for username and email lookups")
	}
}

func TestLoginByEmailStillWorks(t *testing.T) {
	client, _ := setupTestServer(t)

	_, err := client.Register(context.Background(), connect.NewRequest(makeRegisterRequest()))
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	// Login with email (regression test)
	loginResp, err := client.Login(context.Background(), connect.NewRequest(&v1.LoginRequest{
		Identifier: "test@example.com",
		AuthKey:    []byte("my-auth-key"),
	}))
	if err != nil {
		t.Fatalf("Login by email: %v", err)
	}
	if loginResp.Msg.AccessToken == "" {
		t.Error("expected access token from login by email")
	}
}

func TestLoginNonexistentUsername(t *testing.T) {
	client, _ := setupTestServer(t)

	// Login with a username that doesn't exist should return "invalid credentials",
	// not leak whether the account exists.
	_, err := client.Login(context.Background(), connect.NewRequest(&v1.LoginRequest{
		Identifier: "noone",
		AuthKey:    []byte("some-key"),
	}))
	if err == nil {
		t.Fatal("expected error for nonexistent username")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

func TestGetSaltNonexistentUsername(t *testing.T) {
	client, _ := setupTestServer(t)

	// Nonexistent usernames should return a fake salt (not an error)
	// to prevent username enumeration.
	resp, err := client.GetSalt(context.Background(), connect.NewRequest(&v1.GetSaltRequest{
		Identifier: "noone",
	}))
	if err != nil {
		t.Fatalf("GetSalt should succeed for unknown usernames: %v", err)
	}
	if len(resp.Msg.Salt) == 0 {
		t.Error("expected non-empty fake salt")
	}

	// Same username should produce the same fake salt (deterministic).
	resp2, err := client.GetSalt(context.Background(), connect.NewRequest(&v1.GetSaltRequest{
		Identifier: "noone",
	}))
	if err != nil {
		t.Fatalf("GetSalt: %v", err)
	}
	if string(resp.Msg.Salt) != string(resp2.Msg.Salt) {
		t.Error("expected deterministic salt for same username")
	}
}
