package models

import (
	"crypto/rand"
	"time"

	"github.com/oklog/ulid/v2"
)

// SystemUserID is the well-known ID of the seeded system user (26 zeroes).
const SystemUserID = "00000000000000000000000000"

// NewID generates a new ULID string.
func NewID() string {
	return ulid.MustNew(ulid.Timestamp(time.Now()), rand.Reader).String()
}
