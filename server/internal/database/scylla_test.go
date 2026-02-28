package database

import "testing"

func TestNewScyllaSessionEmptyHosts(t *testing.T) {
	_, err := NewScyllaSession("", "")
	if err == nil {
		t.Error("expected error for empty hosts string")
	}
}
