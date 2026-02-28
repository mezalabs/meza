package models

import "testing"

func TestNewIDFormat(t *testing.T) {
	id := NewID()
	if len(id) != 26 {
		t.Errorf("ULID should be 26 chars, got %d: %s", len(id), id)
	}
}

func TestNewIDUniqueness(t *testing.T) {
	ids := make(map[string]bool)
	for i := 0; i < 1000; i++ {
		id := NewID()
		if ids[id] {
			t.Fatalf("duplicate ID generated: %s", id)
		}
		ids[id] = true
	}
}
