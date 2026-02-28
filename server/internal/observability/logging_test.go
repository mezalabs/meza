package observability

import "testing"

func TestNewLogger(t *testing.T) {
	logger := NewLogger("info")
	if logger == nil {
		t.Fatal("expected non-nil logger")
	}
}

func TestNewLoggerDebug(t *testing.T) {
	logger := NewLogger("debug")
	if logger == nil {
		t.Fatal("expected non-nil logger")
	}
}
