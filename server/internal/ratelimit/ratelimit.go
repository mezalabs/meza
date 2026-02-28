package ratelimit

import (
	"net"
	"net/http"
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

func (l *IPLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	v, exists := l.visitors[ip]
	if !exists {
		v = &visitor{limiter: rate.NewLimiter(l.r, l.burst)}
		l.visitors[ip] = v
	}
	v.lastSeen = time.Now()
	return v.limiter.Allow()
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

// Wrap returns HTTP middleware that rejects requests exceeding the rate limit.
func (l *IPLimiter) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		if ip == "" {
			ip = r.RemoteAddr
		}
		if !l.allow(ip) {
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// WrapFunc is a convenience wrapper for http.HandlerFunc endpoints.
func (l *IPLimiter) WrapFunc(next http.HandlerFunc) http.Handler {
	return l.Wrap(next)
}
