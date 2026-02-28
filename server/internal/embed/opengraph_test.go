package embed

import (
	"strings"
	"testing"
)

func TestParseOG(t *testing.T) {
	tests := []struct {
		name     string
		html     string
		wantTitle string
		wantDesc  string
		wantImage string
		wantSite  string
	}{
		{
			name: "standard OG tags",
			html: `<html><head>
				<meta property="og:title" content="Test Page" />
				<meta property="og:description" content="A test description" />
				<meta property="og:image" content="https://example.com/img.png" />
				<meta property="og:site_name" content="Example" />
			</head><body></body></html>`,
			wantTitle: "Test Page",
			wantDesc:  "A test description",
			wantImage: "https://example.com/img.png",
			wantSite:  "Example",
		},
		{
			name: "HTML entities in title",
			html: `<html><head>
				<meta property="og:title" content="Tom &amp; Jerry&#39;s Page" />
			</head><body></body></html>`,
			wantTitle: "Tom & Jerry's Page",
		},
		{
			name: "strips HTML tags from description",
			html: `<html><head>
				<meta property="og:description" content="Hello <b>world</b>" />
			</head><body></body></html>`,
			wantDesc: "Hello world",
		},
		{
			name:      "no OG tags returns empty",
			html:      `<html><head><title>Fallback Title</title></head><body></body></html>`,
			wantTitle: "", // go-opengraph does not fall back to <title>
		},
		{
			name: "prefers HTTPS image",
			html: `<html><head>
				<meta property="og:image" content="http://example.com/a.png" />
				<meta property="og:image" content="https://example.com/b.png" />
			</head><body></body></html>`,
			wantImage: "https://example.com/b.png",
		},
		{
			name: "http image as fallback",
			html: `<html><head>
				<meta property="og:image" content="http://example.com/a.png" />
			</head><body></body></html>`,
			wantImage: "http://example.com/a.png",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ParseOG(strings.NewReader(tt.html))
			if err != nil {
				t.Fatalf("ParseOG failed: %v", err)
			}
			if tt.wantTitle != "" && result.Title != tt.wantTitle {
				t.Errorf("Title = %q, want %q", result.Title, tt.wantTitle)
			}
			if tt.wantDesc != "" && result.Description != tt.wantDesc {
				t.Errorf("Description = %q, want %q", result.Description, tt.wantDesc)
			}
			if tt.wantImage != "" && result.ImageURL != tt.wantImage {
				t.Errorf("ImageURL = %q, want %q", result.ImageURL, tt.wantImage)
			}
			if tt.wantSite != "" && result.SiteName != tt.wantSite {
				t.Errorf("SiteName = %q, want %q", result.SiteName, tt.wantSite)
			}
		})
	}
}

func TestSanitizeText(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		maxLen int
		want   string
	}{
		{"normal text", "hello world", 256, "hello world"},
		{"truncates long text", "abcdef", 3, "abc"},
		{"strips control chars", "hello\x00world", 256, "helloworld"},
		{"collapses whitespace", "hello   \t  world", 256, "hello world"},
		{"preserves newlines collapsed", "hello\nworld", 256, "hello world"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeText(tt.input, tt.maxLen)
			if got != tt.want {
				t.Errorf("sanitizeText(%q, %d) = %q, want %q", tt.input, tt.maxLen, got, tt.want)
			}
		})
	}
}
