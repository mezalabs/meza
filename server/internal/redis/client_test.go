package redis

import (
	"context"
	"testing"
)

func TestNewClientEmptyURL(t *testing.T) {
	_, err := NewClient(context.Background(), "")
	if err == nil {
		t.Error("expected error for empty URL")
	}
}

func TestNewClientInvalidURL(t *testing.T) {
	_, err := NewClient(context.Background(), "not-a-valid-url")
	if err == nil {
		t.Error("expected error for invalid URL")
	}
}
