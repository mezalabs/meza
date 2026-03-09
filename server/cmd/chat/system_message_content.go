package main

import (
	"fmt"
	"regexp"
	"strings"
)

// MemberEventContent is used for MESSAGE_TYPE_MEMBER_JOIN and MESSAGE_TYPE_MEMBER_LEAVE.
type MemberEventContent struct {
	UserID  string `json:"user_id"`
	ActorID string `json:"actor_id,omitempty"` // set when another user added/removed them
}

// MemberKickContent is used for MESSAGE_TYPE_MEMBER_KICK (covers kick, ban, timeout).
type MemberKickContent struct {
	UserID          string `json:"user_id"`
	ActorID         string `json:"actor_id"`
	Action          string `json:"action"`                     // "kick", "ban", or "timeout"
	Reason          string `json:"reason,omitempty"`           // max 512 chars
	DurationSeconds int    `json:"duration_seconds,omitempty"` // only for timeout
}

// ChannelUpdateContent is used for MESSAGE_TYPE_CHANNEL_UPDATE (covers name and topic).
type ChannelUpdateContent struct {
	ActorID  string `json:"actor_id"`
	Field    string `json:"field"`     // "name" or "topic"
	OldValue string `json:"old_value"` // max 1024 chars
	NewValue string `json:"new_value"` // max 1024 chars
}

// KeyRotationContent is used for MESSAGE_TYPE_KEY_ROTATION.
type KeyRotationContent struct {
	ActorID       string `json:"actor_id"`
	NewKeyVersion uint32 `json:"new_key_version"`
}

// truncate returns s truncated to maxLen bytes.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}

// Template variable validation and rendering for configurable system messages.

// validTemplateVars maps event action keys to their allowed template variables.
var validTemplateVars = map[string][]string{
	"join":    {"user"},
	"leave":   {"user"},
	"kick":    {"user", "actor", "reason"},
	"ban":     {"user", "actor", "reason"},
	"timeout": {"user", "actor", "reason", "duration"},
}

var templateVarPattern = regexp.MustCompile(`\{(\w+)\}`)

// validateTemplate checks that a template only uses valid variables for the given event type.
func validateTemplate(template, eventType string) error {
	allowed, ok := validTemplateVars[eventType]
	if !ok {
		return fmt.Errorf("unknown event type: %s", eventType)
	}
	allowedSet := make(map[string]bool, len(allowed))
	for _, v := range allowed {
		allowedSet[v] = true
	}
	matches := templateVarPattern.FindAllStringSubmatch(template, -1)
	for _, m := range matches {
		if !allowedSet[m[1]] {
			return fmt.Errorf("invalid variable {%s} for %s events (allowed: %s)", m[1], eventType, strings.Join(allowed, ", "))
		}
	}
	return nil
}

// renderTemplate substitutes {variable} placeholders with values from the vars map.
func renderTemplate(template string, vars map[string]string) string {
	result := template
	for k, v := range vars {
		result = strings.ReplaceAll(result, "{"+k+"}", v)
	}
	return result
}
