package embed

import (
	"testing"
)

func TestExtractURLs(t *testing.T) {
	tests := []struct {
		name    string
		text    string
		maxURLs int
		want    []string
	}{
		{
			name:    "single URL",
			text:    "check out https://example.com",
			maxURLs: 5,
			want:    []string{"https://example.com"},
		},
		{
			name:    "multiple URLs",
			text:    "see https://a.com and https://b.com and https://c.com",
			maxURLs: 5,
			want:    []string{"https://a.com", "https://b.com", "https://c.com"},
		},
		{
			name:    "respects maxURLs",
			text:    "https://a.com https://b.com https://c.com",
			maxURLs: 2,
			want:    []string{"https://a.com", "https://b.com"},
		},
		{
			name:    "strips trailing period",
			text:    "visit https://example.com.",
			maxURLs: 5,
			want:    []string{"https://example.com"},
		},
		{
			name:    "strips trailing comma",
			text:    "see https://example.com, and more",
			maxURLs: 5,
			want:    []string{"https://example.com"},
		},
		{
			name:    "strips trailing parenthesis",
			text:    "(see https://example.com)",
			maxURLs: 5,
			want:    []string{"https://example.com"},
		},
		{
			name:    "skips URLs in inline code",
			text:    "use `https://example.com` for reference",
			maxURLs: 5,
			want:    nil,
		},
		{
			name:    "skips URLs in code blocks",
			text:    "```\nhttps://example.com\n```",
			maxURLs: 5,
			want:    nil,
		},
		{
			name:    "mixed: code and plain URLs",
			text:    "`https://skip.com` but https://keep.com is good",
			maxURLs: 5,
			want:    []string{"https://keep.com"},
		},
		{
			name:    "deduplicates URLs",
			text:    "https://example.com and https://example.com",
			maxURLs: 5,
			want:    []string{"https://example.com"},
		},
		{
			name:    "http URL",
			text:    "http://example.com",
			maxURLs: 5,
			want:    []string{"http://example.com"},
		},
		{
			name:    "no URLs",
			text:    "just some text without links",
			maxURLs: 5,
			want:    nil,
		},
		{
			name:    "URL with path and query",
			text:    "https://example.com/path?q=1&r=2#frag",
			maxURLs: 5,
			want:    []string{"https://example.com/path?q=1&r=2#frag"},
		},
		{
			name:    "rejects non-standard ports",
			text:    "https://example.com:8080/path",
			maxURLs: 5,
			want:    nil,
		},
		{
			name:    "allows port 443",
			text:    "https://example.com:443/path",
			maxURLs: 5,
			want:    []string{"https://example.com:443/path"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExtractURLs(tt.text, tt.maxURLs)
			if len(got) != len(tt.want) {
				t.Fatalf("got %d URLs, want %d: %v", len(got), len(tt.want), got)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("URL[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestDomainFromURL(t *testing.T) {
	tests := []struct {
		url  string
		want string
	}{
		{"https://www.example.com/page", "example.com"},
		{"https://example.com", "example.com"},
		{"https://sub.example.com", "sub.example.com"},
		{"invalid", ""},
	}
	for _, tt := range tests {
		got := DomainFromURL(tt.url)
		if got != tt.want {
			t.Errorf("DomainFromURL(%q) = %q, want %q", tt.url, got, tt.want)
		}
	}
}
