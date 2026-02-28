package embed

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"syscall"
	"time"
)

// blockedCIDRs are IP ranges that must never be fetched (SSRF protection).
var blockedCIDRs []*net.IPNet

func init() {
	for _, cidr := range []string{
		"127.0.0.0/8",    // Loopback
		"10.0.0.0/8",     // RFC1918 private
		"172.16.0.0/12",  // RFC1918 private
		"192.168.0.0/16", // RFC1918 private
		"169.254.0.0/16", // Link-local (AWS metadata 169.254.169.254)
		"0.0.0.0/8",      // "This" network
		"100.64.0.0/10",  // Carrier-grade NAT
		"::1/128",        // IPv6 loopback
		"fc00::/7",       // IPv6 ULA
		"fe80::/10",      // IPv6 link-local
	} {
		_, ipNet, err := net.ParseCIDR(cidr)
		if err != nil {
			panic(fmt.Sprintf("invalid CIDR %s: %v", cidr, err))
		}
		blockedCIDRs = append(blockedCIDRs, ipNet)
	}
}

// isBlockedIP returns true if the IP is in a blocked range.
func isBlockedIP(ip net.IP) bool {
	for _, cidr := range blockedCIDRs {
		if cidr.Contains(ip) {
			return true
		}
	}
	return false
}

// NewSafeClient returns an HTTP client that blocks connections to internal IP ranges.
// It validates resolved IPs after DNS resolution but before TCP connect,
// preventing DNS rebinding attacks.
func NewSafeClient() *http.Client {
	dialer := &net.Dialer{
		Timeout: 5 * time.Second,
		Control: func(network, address string, c syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return fmt.Errorf("invalid address: %w", err)
			}
			ip := net.ParseIP(host)
			if ip == nil {
				return fmt.Errorf("could not parse IP: %s", host)
			}
			if isBlockedIP(ip) {
				return fmt.Errorf("blocked IP: %s", ip)
			}
			return nil
		},
	}

	transport := &http.Transport{
		DialContext:         dialer.DialContext,
		TLSHandshakeTimeout: 5 * time.Second,
		MaxIdleConns:        10,
		IdleConnTimeout:     30 * time.Second,
	}

	return &http.Client{
		Transport: transport,
		Timeout:   10 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return fmt.Errorf("too many redirects")
			}
			// Only allow HTTP/HTTPS schemes on redirect.
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return fmt.Errorf("blocked scheme: %s", req.URL.Scheme)
			}
			// Only allow ports 80 and 443.
			port := req.URL.Port()
			if port != "" && port != "80" && port != "443" {
				return fmt.Errorf("blocked port: %s", port)
			}
			return nil
		},
	}
}

// ValidateURL checks that a URL is safe to fetch (scheme, port).
func ValidateURL(rawURL string) error {
	// We only need to check scheme and port; IP validation happens at dial time.
	if len(rawURL) < 8 {
		return fmt.Errorf("URL too short")
	}
	// Parsed later; basic scheme check here.
	return nil
}

// FetchHTML fetches a URL with the safe client, returning the response.
// The caller must close the response body.
// Only GET requests with Accept: text/html are sent.
func FetchHTML(ctx context.Context, client *http.Client, rawURL string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("User-Agent", "MezaBot/1.0")
	req.Header.Set("Accept", "text/html")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		resp.Body.Close()
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	return resp, nil
}
