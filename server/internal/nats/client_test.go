package nats

import "testing"

func TestNewClientEmptyURL(t *testing.T) {
	_, err := NewClient("")
	if err == nil {
		t.Error("expected error for empty URL")
	}
}
