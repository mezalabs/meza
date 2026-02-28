package embed

import (
	"html"
	"io"
	"regexp"
	"strings"
	"unicode"

	"github.com/dyatlov/go-opengraph/opengraph"
)

const (
	maxHTMLBytes         = 1024 * 1024 // 1MB — YouTube etc. put OG tags after ~600KB of inline JS
	maxTitleLength       = 256
	maxDescriptionLength = 1024
)

// OGResult holds parsed and sanitized OpenGraph metadata.
type OGResult struct {
	Title       string
	Description string
	SiteName    string
	ImageURL    string
	OGType      string
}

// ParseOG reads up to 64KB of HTML from r and extracts OpenGraph metadata.
// Falls back to Twitter Card tags and HTML <title>/<meta description>.
func ParseOG(r io.Reader) (*OGResult, error) {
	limited := io.LimitReader(r, maxHTMLBytes)
	og := opengraph.NewOpenGraph()
	if err := og.ProcessHTML(limited); err != nil {
		return nil, err
	}

	result := &OGResult{
		Title:    sanitizeText(og.Title, maxTitleLength),
		Description: sanitizeText(og.Description, maxDescriptionLength),
		SiteName: sanitizeText(og.SiteName, maxTitleLength),
		OGType:   sanitizeText(og.Type, 64),
	}

	// Pick the first image URL that is HTTPS.
	for _, img := range og.Images {
		if img.URL != "" && strings.HasPrefix(img.URL, "https://") {
			result.ImageURL = img.URL
			break
		}
		// Allow http:// as a fallback for OG images (we proxy them anyway).
		if img.URL != "" && strings.HasPrefix(img.URL, "http://") && result.ImageURL == "" {
			result.ImageURL = img.URL
		}
	}

	return result, nil
}

// sanitizeText strips HTML tags, control characters, and truncates to maxLen.
func sanitizeText(s string, maxLen int) string {
	// Unescape HTML entities first.
	s = html.UnescapeString(s)
	// Strip any remaining HTML tags.
	s = stripHTMLTags(s)
	// Remove Unicode control characters.
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, s)
	// Collapse whitespace.
	s = strings.Join(strings.Fields(s), " ")
	// Truncate.
	if len(s) > maxLen {
		s = s[:maxLen]
	}
	return s
}

var htmlTagPattern = regexp.MustCompile(`<[^>]*>`)

func stripHTMLTags(s string) string {
	return htmlTagPattern.ReplaceAllString(s, "")
}
