package auth

import "context"

type contextKey string

const (
	userIDKey   contextKey = "userID"
	deviceIDKey contextKey = "deviceID"
)

// UserIDFromContext extracts the user ID from the request context.
func UserIDFromContext(ctx context.Context) (string, bool) {
	id, ok := ctx.Value(userIDKey).(string)
	return id, ok
}

// DeviceIDFromContext extracts the device ID from the request context.
func DeviceIDFromContext(ctx context.Context) (string, bool) {
	id, ok := ctx.Value(deviceIDKey).(string)
	return id, ok
}
