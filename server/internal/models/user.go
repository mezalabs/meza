package models

import "time"

// AudioPreferences represents a user's audio processing preferences.
type AudioPreferences struct {
	NoiseSuppression      bool   `json:"noise_suppression"`
	EchoCancellation      bool   `json:"echo_cancellation"`
	AutoGainControl       bool   `json:"auto_gain_control"`
	NoiseCancellationMode string `json:"noise_cancellation_mode,omitempty"`
}

// DefaultAudioPreferences returns audio preferences with all processing enabled.
func DefaultAudioPreferences() AudioPreferences {
	return AudioPreferences{
		NoiseSuppression: true,
		EchoCancellation: true,
		AutoGainControl:  true,
	}
}

// UserConnection represents a social link on a user's profile.
type UserConnection struct {
	Platform string `json:"platform"` // "github", "twitter", "linkedin", "website", "other"
	URL      string `json:"url"`
	Label    string `json:"label"`
}

// User represents a user record.
type User struct {
	ID                  string
	Email               string
	Username            string
	DisplayName         string
	AvatarURL           string
	EmojiScale          float32
	CreatedAt           time.Time
	Bio                 string
	Pronouns            string
	BannerURL           string
	ThemeColorPrimary   string
	ThemeColorSecondary string
	SimpleMode          bool
	AudioPreferences    AudioPreferences
	DMPrivacy        string // "anyone", "message_requests", "mutual_servers", "nobody"
	SigningPublicKey []byte             // 32-byte Ed25519 verify key for E2EE signature verification
	Connections     []UserConnection   // Profile social links
	// Federation fields (populated for shadow users on remote instances)
	IsFederated  bool
	HomeServer   string // e.g. "https://home.example.com"
	RemoteUserID string // ULID on the home server
}

// AuthData represents user authentication data.
type AuthData struct {
	UserID             string
	AuthKeyHash        string
	Salt               []byte
	EncryptedKeyBundle []byte
	KeyBundleIV        []byte
}

// EncryptedBundle holds the encrypted identity key bundle for a user.
type EncryptedBundle struct {
	EncryptedKeyBundle         []byte
	KeyBundleIV                []byte
	RecoveryEncryptedKeyBundle []byte // Key bundle encrypted with recovery key (BIP39-derived)
	RecoveryKeyBundleIV        []byte
}
