// Package testutil provides shared test helpers for the Meza server.
package testutil

import (
	"crypto/ed25519"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/mezalabs/meza/internal/auth"
	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// TestHMACSecret is the HMAC key used for anti-enumeration in test suites.
const TestHMACSecret = "test-secret-key-123"

// TestEd25519Keys holds the Ed25519 keypair used for test JWT tokens.
var TestEd25519Keys *auth.Ed25519Keys

func init() {
	// Random test key — different each test run (NOT for production use).
	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		panic("generating test ed25519 key: " + err.Error())
	}
	TestEd25519Keys = &auth.Ed25519Keys{
		PrivateKey: priv,
		PublicKey:  priv.Public().(ed25519.PublicKey),
		KeyID:      "test-key",
	}
}

// StartTestNATS spins up an embedded NATS server, connects a client, and
// registers cleanup for both. The server listens on a random port.
func StartTestNATS(t *testing.T) *nats.Conn {
	t.Helper()
	opts := &natsserver.Options{Port: -1}
	ns, err := natsserver.NewServer(opts)
	if err != nil {
		t.Fatalf("start nats: %v", err)
	}
	ns.Start()
	t.Cleanup(ns.Shutdown)
	if !ns.ReadyForConnections(2 * time.Second) {
		t.Fatal("nats not ready")
	}
	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatalf("connect nats: %v", err)
	}
	t.Cleanup(nc.Close)
	return nc
}

// AuthedRequest creates a connect.Request with a valid Bearer token for the
// given user. It is generic over the request message type.
func AuthedRequest[T any](t *testing.T, userID string, msg *T) *connect.Request[T] {
	t.Helper()
	accessToken, _, err := auth.GenerateTokenPairEd25519(userID, "device-1", TestEd25519Keys, "", false)
	if err != nil {
		t.Fatalf("generate token: %v", err)
	}
	req := connect.NewRequest(msg)
	req.Header().Set("Authorization", "Bearer "+accessToken)
	return req
}
