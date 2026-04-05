package config

import (
	"strings"

	"github.com/kelseyhightower/envconfig"
)

// Config holds all service configuration. Fields are populated from
// MEZA_* environment variables via envconfig.
type Config struct {
	// Common
	ListenAddr string `envconfig:"LISTEN_ADDR" default:":8080"`
	NatsURL    string `envconfig:"NATS_URL" default:"nats://localhost:4222"`
	LogLevel   string `envconfig:"LOG_LEVEL" default:"info"`

	// Auth — HMAC secret for anti-enumeration (fake salts/recovery bundles).
	// Only needed by the auth service; not required for verification-only services.
	HMACSecret           string `envconfig:"HMAC_SECRET"`
	RegistrationDisabled bool   `envconfig:"REGISTRATION_DISABLED" default:"false"` // Spoke: disable local user registration

	// Auth — Ed25519 (federation)
	JWTPrivateKey     string `envconfig:"JWT_PRIVATE_KEY"`      // PEM-encoded Ed25519 private key
	JWTPrivateKeyFile string `envconfig:"JWT_PRIVATE_KEY_FILE"` // Alternative: path to PEM file
	JWTKeyID          string `envconfig:"JWT_KEY_ID"`           // Key ID for JWKS kid field

	// Auth — Ed25519 public key (downstream services that only verify, not sign)
	Ed25519PublicKey     string `envconfig:"ED25519_PUBLIC_KEY"`      // PEM-encoded Ed25519 public key
	Ed25519PublicKeyFile string `envconfig:"ED25519_PUBLIC_KEY_FILE"` // Alternative: path to PEM file

	// Email (SMTP) — used by auth service for OTP verification
	SMTPHost     string `envconfig:"SMTP_HOST"`
	SMTPPort     int    `envconfig:"SMTP_PORT" default:"587"`
	SMTPFrom     string `envconfig:"SMTP_FROM"`
	SMTPUsername string `envconfig:"SMTP_USERNAME"`
	SMTPPassword string `envconfig:"SMTP_PASSWORD"`

	// Federation
	FederationEnabled bool   `envconfig:"FEDERATION_ENABLED" default:"false"`
	OriginURL         string `envconfig:"ORIGIN_URL" default:"https://meza.chat"` // Single origin (identity provider)
	InstanceURL       string `envconfig:"INSTANCE_URL"`                           // This instance's public URL

	// Database
	PostgresURL string `envconfig:"POSTGRES_URL"`
	ScyllaHosts string `envconfig:"SCYLLA_HOSTS"`
	RedisURL    string `envconfig:"REDIS_URL"`

	// Gateway
	ChatServiceURL       string `envconfig:"CHAT_SERVICE_URL" default:"http://localhost:8082"`
	AllowedOrigins       string `envconfig:"ALLOWED_ORIGINS"`        // Comma-separated WebSocket origin patterns; defaults to "*" (wildcard) if unset
	AllowWildcardOrigins bool   `envconfig:"ALLOW_WILDCARD_ORIGINS" default:"false"` // Must be true to allow wildcard origins; prevents accidental "*" in production

	// Media (S3-compatible)
	S3Endpoint       string `envconfig:"S3_ENDPOINT"`
	S3PublicEndpoint string `envconfig:"S3_PUBLIC_ENDPOINT"` // URL for client-facing presigned URLs; defaults to S3Endpoint
	S3AccessKey      string `envconfig:"S3_ACCESS_KEY"`
	S3SecretKey      string `envconfig:"S3_SECRET_KEY"`
	S3Bucket         string `envconfig:"S3_BUCKET"`
	S3Region         string `envconfig:"S3_REGION" default:"us-east-1"`
	S3UseSSL         bool   `envconfig:"S3_USE_SSL" default:"false"`

	// Voice (LiveKit)
	LiveKitHost      string `envconfig:"LIVEKIT_HOST"`
	LiveKitPublicURL string `envconfig:"LIVEKIT_PUBLIC_URL"` // URL returned to clients; defaults to LiveKitHost
	LiveKitAPIKey    string `envconfig:"LIVEKIT_API_KEY"`
	LiveKitAPISecret string `envconfig:"LIVEKIT_API_SECRET"`

	// Notification (Push)
	VAPIDPublicKey     string `envconfig:"VAPID_PUBLIC_KEY"`
	VAPIDPrivateKey    string `envconfig:"VAPID_PRIVATE_KEY"`
	VAPIDContact       string `envconfig:"VAPID_CONTACT" default:"mailto:admin@meza.chat"`
	FCMCredentialsFile string `envconfig:"FCM_CREDENTIALS_FILE"` // Path to Firebase service account JSON
}

// MustLoad loads configuration from MEZA_* environment variables.
// Panics if required fields are missing.
func MustLoad() *Config {
	var cfg Config
	envconfig.MustProcess("MEZA", &cfg)
	// Normalize URLs to prevent trailing-slash mismatch with JWT iss claims
	cfg.OriginURL = strings.TrimRight(cfg.OriginURL, "/")
	cfg.InstanceURL = strings.TrimRight(cfg.InstanceURL, "/")
	return &cfg
}
