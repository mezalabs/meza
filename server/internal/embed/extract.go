package embed

import (
	"net/url"
	"regexp"
	"strings"
)

const MaxURLsPerMessage = 5

// urlPattern matches http:// and https:// URLs in plaintext.
var urlPattern = regexp.MustCompile(`https?://[^\s<>\[\]` + "`" + `"]+`)

// codeBlockPattern matches triple-backtick code blocks.
var codeBlockPattern = regexp.MustCompile("(?s)```.*?```")

// codeSpanPattern matches inline code spans (single backtick).
var codeSpanPattern = regexp.MustCompile("`[^`]+`")

// ExtractURLs extracts up to maxURLs HTTP/HTTPS URLs from plaintext message content.
// URLs inside backtick code spans or code blocks are skipped.
// Trailing punctuation (., ,, ), ]) that is likely sentence-ending is stripped.
func ExtractURLs(text string, maxURLs int) []string {
	if maxURLs <= 0 {
		maxURLs = MaxURLsPerMessage
	}

	// Mask code blocks and code spans so URLs inside them aren't matched.
	masked := codeBlockPattern.ReplaceAllStringFunc(text, func(s string) string {
		return strings.Repeat(" ", len(s))
	})
	masked = codeSpanPattern.ReplaceAllStringFunc(masked, func(s string) string {
		return strings.Repeat(" ", len(s))
	})

	matches := urlPattern.FindAllString(masked, -1)

	seen := make(map[string]struct{})
	var urls []string
	for _, raw := range matches {
		cleaned := cleanTrailingPunctuation(raw)
		// Validate it's a proper URL.
		parsed, err := url.Parse(cleaned)
		if err != nil {
			continue
		}
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			continue
		}
		if parsed.Host == "" {
			continue
		}
		// Only allow ports 80 and 443.
		port := parsed.Port()
		if port != "" && port != "80" && port != "443" {
			continue
		}
		if _, ok := seen[cleaned]; ok {
			continue
		}
		seen[cleaned] = struct{}{}
		urls = append(urls, cleaned)
		if len(urls) >= maxURLs {
			break
		}
	}
	return urls
}

// cleanTrailingPunctuation strips trailing punctuation that's likely sentence-ending.
func cleanTrailingPunctuation(s string) string {
	for len(s) > 0 {
		last := s[len(s)-1]
		if last == '.' || last == ',' || last == ')' || last == ']' || last == ';' || last == ':' {
			s = s[:len(s)-1]
		} else {
			break
		}
	}
	return s
}

// DomainFromURL extracts the domain from a URL for display purposes.
func DomainFromURL(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	host := parsed.Hostname()
	// Strip "www." prefix for cleaner display.
	host = strings.TrimPrefix(host, "www.")
	return host
}
