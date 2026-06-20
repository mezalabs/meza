package main

import (
	"strings"
	"testing"
)

func uint32Ptr(v uint32) *uint32 { return &v }

func TestValidateWebhookPayload(t *testing.T) {
	tests := []struct {
		name    string
		req     webhookExecuteRequest
		wantErr string // empty = expect no error
	}{
		// --- Valid payloads ---
		{
			name: "valid embed with all fields",
			req: webhookExecuteRequest{
				Content: "hello",
				Embeds: []webhookEmbed{{
					Title:       "Test",
					Description: "A description",
					URL:         "https://example.com",
					Color:       uint32Ptr(0xFF0000),
					Author: &webhookEmbedAuthor{
						Name:    "Author",
						IconURL: "https://example.com/icon.png",
						URL:     "https://example.com/author",
					},
					Fields: []webhookEmbedField{
						{Name: "Status", Value: "Open", Inline: true},
					},
				}},
			},
		},
		{
			name: "valid embed title only",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{Title: "Just a title"}},
			},
		},
		{
			name: "valid embed description only",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{Description: "Just a description"}},
			},
		},
		{
			name: "valid embed url only",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{URL: "https://example.com"}},
			},
		},
		{
			name: "valid embed fields only",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Fields: []webhookEmbedField{{Name: "key", Value: "val"}},
				}},
			},
		},
		{
			name: "color 0 (black) is valid",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{Title: "Black border", Color: uint32Ptr(0)}},
			},
		},
		{
			name: "color nil (no color) is valid",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{Title: "No border"}},
			},
		},
		{
			name: "color at max 0xFFFFFF",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{Title: "White", Color: uint32Ptr(0xFFFFFF)}},
			},
		},
		{
			name: "valid author with all fields",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title: "Authored",
					Author: &webhookEmbedAuthor{
						Name:    "Author",
						IconURL: "https://example.com/icon.png",
						URL:     "https://example.com/author",
					},
				}},
			},
		},
		{
			name: "valid author name only",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "Authored",
					Author: &webhookEmbedAuthor{Name: "Author"},
				}},
			},
		},

		// --- Empty embed rejection ---
		{
			name: "empty embed rejected",
			req: webhookExecuteRequest{
				Content: "text",
				Embeds:  []webhookEmbed{{}},
			},
			wantErr: "embed[0] must have at least one of",
		},
		{
			name: "embed with only author is rejected",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Author: &webhookEmbedAuthor{Name: "Author"},
				}},
			},
			wantErr: "embed[0] must have at least one of",
		},

		// --- Null byte checks ---
		{
			name: "null bytes in title",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{Title: "bad\x00title"}},
			},
			wantErr: "embed[0].title contains invalid characters",
		},
		{
			name: "null bytes in description",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{Description: "bad\x00desc"}},
			},
			wantErr: "embed[0].description contains invalid characters",
		},
		{
			name: "null bytes in url",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{Title: "x", URL: "https://example.com/\x00bad"}},
			},
			wantErr: "embed[0].url contains invalid characters",
		},
		{
			name: "null bytes in field name",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "x",
					Fields: []webhookEmbedField{{Name: "bad\x00name", Value: "v"}},
				}},
			},
			wantErr: "embed[0].fields[0].name contains invalid characters",
		},
		{
			name: "null bytes in field value",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "x",
					Fields: []webhookEmbedField{{Name: "k", Value: "bad\x00value"}},
				}},
			},
			wantErr: "embed[0].fields[0].value contains invalid characters",
		},
		{
			name: "null bytes in author name",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "x",
					Author: &webhookEmbedAuthor{Name: "bad\x00name"},
				}},
			},
			wantErr: "embed[0].author.name contains invalid characters",
		},
		{
			name: "null bytes in author icon_url",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "x",
					Author: &webhookEmbedAuthor{Name: "ok", IconURL: "https://example.com/\x00bad"},
				}},
			},
			wantErr: "embed[0].author.icon_url contains invalid characters",
		},
		{
			name: "null bytes in author url",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "x",
					Author: &webhookEmbedAuthor{Name: "ok", URL: "https://example.com/\x00bad"},
				}},
			},
			wantErr: "embed[0].author.url contains invalid characters",
		},

		// --- Field validation ---
		{
			name: "empty field name rejected",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "x",
					Fields: []webhookEmbedField{{Name: "", Value: "v"}},
				}},
			},
			wantErr: "embed[0].fields[0].name is required",
		},
		{
			name: "field name too long",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "x",
					Fields: []webhookEmbedField{{Name: strings.Repeat("a", 257), Value: "v"}},
				}},
			},
			wantErr: "embed[0].fields[0].name exceeds",
		},
		{
			name: "field value too long",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "x",
					Fields: []webhookEmbedField{{Name: "k", Value: strings.Repeat("a", 1025)}},
				}},
			},
			wantErr: "embed[0].fields[0].value exceeds",
		},
		{
			name: "too many fields",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "x",
					Fields: makeFields(26),
				}},
			},
			wantErr: "exceeds maximum 25 fields",
		},

		// --- Embed limits ---
		{
			name: "too many embeds",
			req: webhookExecuteRequest{
				Embeds: makeEmbeds(11),
			},
			wantErr: "maximum 10 embeds allowed",
		},
		{
			name: "title too long",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{Title: strings.Repeat("a", 257)}},
			},
			wantErr: "embed[0].title exceeds",
		},
		{
			name: "description too long",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{Description: strings.Repeat("a", 4097)}},
			},
			wantErr: "embed[0].description exceeds",
		},

		// --- Color validation ---
		{
			name: "color over max",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{Title: "x", Color: uint32Ptr(0xFFFFFF + 1)}},
			},
			wantErr: "embed[0].color must be a 24-bit RGB value",
		},

		// --- URL validation ---
		{
			name: "embed url not HTTPS",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{Title: "x", URL: "http://example.com"}},
			},
			wantErr: "embed[0].url: must use HTTPS",
		},
		{
			name: "embed url empty host",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{Title: "x", URL: "https:///path"}},
			},
			wantErr: "embed[0].url: missing host",
		},
		{
			name: "embed url with userinfo",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{Title: "x", URL: "https://user@example.com/"}},
			},
			wantErr: "embed[0].url: userinfo not allowed",
		},

		// --- Author validation ---
		{
			name: "author without name",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "x",
					Author: &webhookEmbedAuthor{IconURL: "https://example.com/icon.png"},
				}},
			},
			wantErr: "embed[0].author.name is required",
		},
		{
			name: "author name too long",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "x",
					Author: &webhookEmbedAuthor{Name: strings.Repeat("a", 257)},
				}},
			},
			wantErr: "embed[0].author.name exceeds",
		},
		{
			name: "author icon_url not HTTPS",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "x",
					Author: &webhookEmbedAuthor{Name: "ok", IconURL: "http://example.com/icon.png"},
				}},
			},
			wantErr: "embed[0].author.icon_url: must use HTTPS",
		},
		{
			name: "author icon_url empty host",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "x",
					Author: &webhookEmbedAuthor{Name: "ok", IconURL: "https:///icon.png"},
				}},
			},
			wantErr: "embed[0].author.icon_url: missing host",
		},
		{
			name: "author icon_url with userinfo",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "x",
					Author: &webhookEmbedAuthor{Name: "ok", IconURL: "https://user@example.com/icon.png"},
				}},
			},
			wantErr: "embed[0].author.icon_url: userinfo not allowed",
		},
		{
			name: "author url not HTTPS",
			req: webhookExecuteRequest{
				Embeds: []webhookEmbed{{
					Title:  "x",
					Author: &webhookEmbedAuthor{Name: "ok", URL: "http://example.com"},
				}},
			},
			wantErr: "embed[0].author.url: must use HTTPS",
		},

		// --- avatar_url validation ---
		{
			name: "avatar_url not HTTPS",
			req: webhookExecuteRequest{
				Content:   "hi",
				AvatarURL: "http://example.com/avatar.png",
			},
			wantErr: "avatar_url: must use HTTPS",
		},
		{
			name: "avatar_url with userinfo",
			req: webhookExecuteRequest{
				Content:   "hi",
				AvatarURL: "https://user@example.com/avatar.png",
			},
			wantErr: "avatar_url: userinfo not allowed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateWebhookPayload(&tt.req)
			if tt.wantErr == "" {
				if err != nil {
					t.Errorf("expected no error, got: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("expected error containing %q, got: %v", tt.wantErr, err)
			}
		})
	}
}

func TestValidateExternalURL(t *testing.T) {
	tests := []struct {
		name    string
		url     string
		wantErr string
	}{
		{"valid https", "https://example.com/path", ""},
		{"http rejected", "http://example.com", "must use HTTPS"},
		{"empty host", "https:///path", "missing host"},
		{"userinfo", "https://user@example.com/", "userinfo not allowed"},
		{"userinfo with pass", "https://user:pass@example.com/", "userinfo not allowed"},
		{"ftp scheme", "ftp://example.com", "must use HTTPS"},
		{"no scheme", "example.com", "must use HTTPS"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateExternalURL(tt.url)
			if tt.wantErr == "" {
				if err != nil {
					t.Errorf("expected no error, got: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("expected error containing %q, got: %v", tt.wantErr, err)
			}
		})
	}
}

// makeFields creates n embed fields for testing.
func makeFields(n int) []webhookEmbedField {
	fields := make([]webhookEmbedField, n)
	for i := range fields {
		fields[i] = webhookEmbedField{Name: "name", Value: "value"}
	}
	return fields
}

// makeEmbeds creates n embeds for testing.
func makeEmbeds(n int) []webhookEmbed {
	embeds := make([]webhookEmbed, n)
	for i := range embeds {
		embeds[i] = webhookEmbed{Title: "title"}
	}
	return embeds
}
