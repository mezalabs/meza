package auth

import "context"

type contextKey string

const (
	userIDKey   contextKey = "userID"
	deviceIDKey contextKey = "deviceID"
	isBotKey    contextKey = "isBot"
)

// UserIDFromContext extracts the user ID from the request context.
func UserIDFromContext(ctx context.Context) (string, bool) {
	id, ok := ctx.Value(userIDKey).(string)
	return id, ok
}

// ContextWithUserID returns a context with the given user ID set.
// This is primarily useful for tests and internal service-to-service calls.
func ContextWithUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, userIDKey, userID)
}

// DeviceIDFromContext extracts the device ID from the request context.
func DeviceIDFromContext(ctx context.Context) (string, bool) {
	id, ok := ctx.Value(deviceIDKey).(string)
	return id, ok
}

// IsBotFromContext returns true if the authenticated caller is a bot.
func IsBotFromContext(ctx context.Context) bool {
	v, _ := ctx.Value(isBotKey).(bool)
	return v
}
