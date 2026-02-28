package models

import "time"

// Device represents a registered device for push notifications and/or E2EE.
type Device struct {
	ID              string
	UserID          string
	DeviceName      string
	Platform        string // "web", "android", "ios", "electron"
	PushEndpoint    string // Web Push subscription endpoint URL
	PushP256dh      string // Web Push ECDH public key
	PushAuth        string // Web Push auth secret
	PushToken       string // FCM/APNs device token
	PushEnabled     bool
	DevicePublicKey string // E2EE (future)
	DeviceSignature string // E2EE (future)
	CreatedAt       time.Time
	UpdatedAt       time.Time
	LastSeenAt      time.Time
}
