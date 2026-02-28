package middleware

import "net/http"

// SecurityHeaders wraps an http.Handler to set common security response headers.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")

		// Always set HSTS — browsers ignore it over plain HTTP, and it
		// ensures the header is present when accessed via HTTPS (including
		// behind TLS-terminating load balancers that strip X-Forwarded-Proto).
		w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")

		next.ServeHTTP(w, r)
	})
}
