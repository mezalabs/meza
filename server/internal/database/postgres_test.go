package database

import (
	"context"
	"testing"
)

func TestNewPostgresPoolEmptyURL(t *testing.T) {
	_, err := NewPostgresPool(context.Background(), "")
	if err == nil {
		t.Error("expected error for empty connection string")
	}
}

func TestNewPostgresPoolInvalidURL(t *testing.T) {
	_, err := NewPostgresPool(context.Background(), "not-a-valid-url")
	if err == nil {
		t.Error("expected error for invalid connection string")
	}
}
