package ratelimit

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

type visitor struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// IPLimiter tracks per-IP rate limiters.
type IPLimiter struct {
	visitors map[string]*visitor
	mu       sync.Mutex
	r        rate.Limit
	burst    int
}

// New creates an IPLimiter that allows r requests/second with the given burst size.
func New(r rate.Limit, burst int) *IPLimiter {
	l := &IPLimiter{
		visitors: make(map[string]*visitor),
		r:        r,
		burst:    burst,
	}
	go l.cleanup()
	return l
}

const maxVisitors = 100_000

func (l *IPLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	v, exists := l.visitors[ip]
	if !exists {
		if len(l.visitors) >= maxVisitors {
			l.evictOldest()
		}
		v = &visitor{limiter: rate.NewLimiter(l.r, l.burst)}
		l.visitors[ip] = v
	}
	v.lastSeen = time.Now()
	return v.limiter.Allow()
}

// evictOldest removes the least-recently-seen visitor to make room for a new
// entry. Must be called with l.mu held.
func (l *IPLimiter) evictOldest() {
	var oldestIP string
	var oldestTime time.Time
	for ip, v := range l.visitors {
		if oldestIP == "" || v.lastSeen.Before(oldestTime) {
			oldestIP = ip
			oldestTime = v.lastSeen
		}
	}
	if oldestIP != "" {
		delete(l.visitors, oldestIP)
	}
}

func (l *IPLimiter) cleanup() {
	for {
		time.Sleep(time.Minute)
		l.mu.Lock()
		for ip, v := range l.visitors {
			if time.Since(v.lastSeen) > 3*time.Minute {
				delete(l.visitors, ip)
			}
		}
		l.mu.Unlock()
	}
}

// clientIP extracts the real client IP from the request. It checks, in order:
//  1. CF-Connecting-IP — set by Cloudflare, trustworthy because Traefik strips
//     this header from requests not originating from Cloudflare IPs.
//  2. X-Forwarded-For — the first (leftmost) entry, which Traefik sanitises so
//     only headers from trusted proxies (Cloudflare) are preserved.
//  3. r.RemoteAddr — direct TCP peer, used when no proxy headers are present.
func clientIP(r *http.Request) string {
	if cfIP := r.Header.Get("CF-Connecting-IP"); cfIP != "" {
		if parsed := net.ParseIP(strings.TrimSpace(cfIP)); parsed != nil {
			return parsed.String()
		}
	}

	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// Take the first entry (client IP as seen by the first proxy).
		if comma := strings.IndexByte(xff, ','); comma != -1 {
			xff = xff[:comma]
		}
		if parsed := net.ParseIP(strings.TrimSpace(xff)); parsed != nil {
			return parsed.String()
		}
	}

	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if ip == "" {
		ip = r.RemoteAddr
	}
	if parsed := net.ParseIP(ip); parsed != nil {
		return parsed.String()
	}
	return ip
}

// Wrap returns HTTP middleware that rejects requests exceeding the rate limit.
func (l *IPLimiter) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !l.allow(clientIP(r)) {
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}
