package auth

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"testing"

	"connectrpc.com/connect"
)

type fakeRequest struct {
	connect.AnyRequest
	headers http.Header
	isClient bool
}

func (f *fakeRequest) Header() http.Header       { return f.headers }
func (f *fakeRequest) Spec() connect.Spec         { return connect.Spec{IsClient: f.isClient} }
func (f *fakeRequest) Peer() connect.Peer         { return connect.Peer{} }
func (f *fakeRequest) HTTPMethod() string         { return http.MethodPost }

func testEd25519Keys(t *testing.T) *Ed25519Keys {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &Ed25519Keys{PrivateKey: priv, PublicKey: pub, KeyID: "test-key-1"}
}

func TestInterceptorValidToken(t *testing.T) {
	keys := testEd25519Keys(t)
	userID := "user123"
	deviceID := "device456"

	access, _, err := GenerateTokenPairEd25519(userID, deviceID, keys, "", false)
	if err != nil {
		t.Fatal(err)
	}

	interceptor := NewConnectInterceptor(keys.PublicKey)
	called := false
	handler := interceptor(func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		called = true
		gotUser, ok := UserIDFromContext(ctx)
		if !ok || gotUser != userID {
			t.Errorf("UserID = %q, want %q", gotUser, userID)
		}
		gotDevice, ok := DeviceIDFromContext(ctx)
		if !ok || gotDevice != deviceID {
			t.Errorf("DeviceID = %q, want %q", gotDevice, deviceID)
		}
		return nil, nil
	})

	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+access)
	req := &fakeRequest{headers: headers}

	_, err = handler(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Error("next handler was not called")
	}
}

func TestInterceptorMissingToken(t *testing.T) {
	keys := testEd25519Keys(t)
	interceptor := NewConnectInterceptor(keys.PublicKey)
	handler := interceptor(func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		t.Error("next handler should not be called")
		return nil, nil
	})

	req := &fakeRequest{headers: http.Header{}}
	_, err := handler(context.Background(), req)
	if err == nil {
		t.Fatal("expected error")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

func TestInterceptorInvalidToken(t *testing.T) {
	keys := testEd25519Keys(t)
	interceptor := NewConnectInterceptor(keys.PublicKey)
	handler := interceptor(func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		t.Error("next handler should not be called")
		return nil, nil
	})

	headers := http.Header{}
	headers.Set("Authorization", "Bearer bad-token")
	req := &fakeRequest{headers: headers}

	_, err := handler(context.Background(), req)
	if err == nil {
		t.Fatal("expected error")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

func TestInterceptorRejectsRefreshToken(t *testing.T) {
	keys := testEd25519Keys(t)
	userID := "user123"
	deviceID := "device456"

	_, refresh, err := GenerateTokenPairEd25519(userID, deviceID, keys, "", false)
	if err != nil {
		t.Fatal(err)
	}

	interceptor := NewConnectInterceptor(keys.PublicKey)
	handler := interceptor(func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		t.Error("next handler should not be called for refresh token")
		return nil, nil
	})

	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+refresh)
	req := &fakeRequest{headers: headers}

	_, err = handler(context.Background(), req)
	if err == nil {
		t.Fatal("expected error when using refresh token as access token")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

func TestInterceptorAcceptsAccessToken(t *testing.T) {
	keys := testEd25519Keys(t)
	userID := "user789"
	deviceID := "device012"

	access, _, err := GenerateTokenPairEd25519(userID, deviceID, keys, "", false)
	if err != nil {
		t.Fatal(err)
	}

	interceptor := NewConnectInterceptor(keys.PublicKey)
	called := false
	handler := interceptor(func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		called = true
		gotUser, ok := UserIDFromContext(ctx)
		if !ok || gotUser != userID {
			t.Errorf("UserID = %q, want %q", gotUser, userID)
		}
		gotDevice, ok := DeviceIDFromContext(ctx)
		if !ok || gotDevice != deviceID {
			t.Errorf("DeviceID = %q, want %q", gotDevice, deviceID)
		}
		return nil, nil
	})

	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+access)
	req := &fakeRequest{headers: headers}

	_, err = handler(context.Background(), req)
	if err != nil {
		t.Fatalf("access token should be accepted, got error: %v", err)
	}
	if !called {
		t.Error("next handler was not called for access token")
	}
}

func TestInterceptorClientSidePassthrough(t *testing.T) {
	keys := testEd25519Keys(t)
	interceptor := NewConnectInterceptor(keys.PublicKey)
	called := false
	handler := interceptor(func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		called = true
		return nil, nil
	})

	req := &fakeRequest{headers: http.Header{}, isClient: true}
	_, err := handler(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Error("next handler was not called for client-side request")
	}
}

func TestInterceptorRejectsFederationAssertion(t *testing.T) {
	// A federation assertion token (with purpose claim) must be rejected
	// by the connect interceptor, even when signed with a valid Ed25519 key.
	// This prevents a malicious remote instance from replaying the assertion
	// against home.example.com API endpoints.
	keys := testEd25519Keys(t)

	assertion, err := GenerateFederationAssertion(
		"user_01HQEXAMPLE", "Test User", "https://example.com/avatar.png",
		keys, "https://home.example.com", "https://remote.example.com",
	)
	if err != nil {
		t.Fatalf("GenerateFederationAssertion: %v", err)
	}

	interceptor := NewConnectInterceptor(keys.PublicKey)
	handler := interceptor(func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		t.Error("next handler should not be called for federation assertion token")
		return nil, nil
	})

	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+assertion)
	req := &fakeRequest{headers: headers}

	_, err = handler(context.Background(), req)
	if err == nil {
		t.Fatal("expected error when using federation assertion as access token")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}
