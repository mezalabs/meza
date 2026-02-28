package nats

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
)

// NewClient connects to a NATS server at the given URL with reconnect
// configuration and disconnect/reconnect logging handlers. Retries with
// exponential backoff for up to 2 minutes to handle cases where NATS is
// still starting after a server reboot.
func NewClient(url string) (*nats.Conn, error) {
	if url == "" {
		return nil, fmt.Errorf("nats URL is empty")
	}

	opts := []nats.Option{
		nats.MaxReconnects(-1),
		nats.ReconnectWait(time.Second),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			slog.Warn("NATS disconnected", "err", err)
		}),
		nats.ReconnectHandler(func(_ *nats.Conn) {
			slog.Info("NATS reconnected")
		}),
	}

	backoff := time.Second
	deadline := time.Now().Add(2 * time.Minute)

	for {
		nc, err := nats.Connect(url, opts...)
		if err == nil {
			return nc, nil
		}

		if time.Now().After(deadline) {
			return nil, fmt.Errorf("nats connection failed after 2m: %w", err)
		}

		slog.Warn("nats not ready, retrying", "err", err, "backoff", backoff)
		time.Sleep(backoff)
		backoff = min(backoff*2, 30*time.Second)
	}
}
