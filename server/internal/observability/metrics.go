package observability

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics holds common Prometheus metrics shared by all services.
type Metrics struct {
	RequestsTotal   *prometheus.CounterVec
	RequestDuration *prometheus.HistogramVec
}

// NewMetrics creates common request metrics for a service.
func NewMetrics(service string) *Metrics {
	m := &Metrics{
		RequestsTotal: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name:        "meza_requests_total",
				Help:        "Total number of requests by service, method, and code.",
				ConstLabels: prometheus.Labels{"service": service},
			},
			[]string{"method", "code"},
		),
		RequestDuration: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:        "meza_request_duration_seconds",
				Help:        "Request duration in seconds by service and method.",
				ConstLabels: prometheus.Labels{"service": service},
				Buckets:     prometheus.DefBuckets,
			},
			[]string{"method"},
		),
	}

	prometheus.MustRegister(m.RequestsTotal, m.RequestDuration)
	return m
}

// MetricsHandler returns an http.Handler that serves Prometheus metrics.
func MetricsHandler() http.Handler {
	return promhttp.Handler()
}
