package models

import "time"

// LinkPreview represents cached OpenGraph metadata for a URL.
type LinkPreview struct {
	URLHash     string
	URL         string
	Title       string
	Description string
	SiteName    string
	ImageKey    string
	ImageWidth  int
	ImageHeight int
	FaviconKey  string
	OGType      string
	FetchedAt   time.Time
	ExpiresAt   time.Time
}

// MessageLinkPreview associates a message with a link preview.
type MessageLinkPreview struct {
	ChannelID string
	MessageID string
	URLHash   string
	Position  int
}
