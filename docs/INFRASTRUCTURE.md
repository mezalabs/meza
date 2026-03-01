# Infrastructure and Deployment

## Overview

Meza is designed to run on Kubernetes in production and Docker Compose in
development. All services are containerized and stateless (state lives in
PostgreSQL, ScyllaDB, Redis, and S3).

---

## Development Environment (Docker Compose)

Infrastructure services managed via `deploy/docker/docker-compose.yml`:

| Service | Image | Port |
|---------|-------|------|
| PostgreSQL | `postgres:16-alpine` | 5432 |
| ScyllaDB | `scylladb/scylla:6.2` | 9042 |
| Redis | `redis:7-alpine` | 6379 |
| NATS | `nats:2.10-alpine` | 4222, 8222 |
| MinIO (S3) | `minio/minio` | 9000, 9001 |
| LiveKit | `livekit/livekit-server` | 7880, 7881, 7882/udp |

All services have health checks configured. The `notification` service (port 8086) requires `MEZA_VAPID_PUBLIC_KEY` and `MEZA_VAPID_PRIVATE_KEY` for Web Push.

---

## Dockerfile

Multi-stage Go build at `deploy/docker/Dockerfile`:
- Builder: `golang:1.23-alpine`, builds a single service binary via `SERVICE` build arg
- Runtime: `alpine:3.20`, non-root user (`meza:1000`), `CGO_ENABLED=0`, stripped binary

---

## Reverse Proxy (Caddy)

Development Caddyfile at `deploy/Caddyfile` proxies API traffic to the gateway and static assets to the Vite dev server.

> **[Planned]** Production Caddyfile with per-service routing, TLS termination, security headers, and LiveKit proxying.

---

## Kubernetes Production Deployment

> **[Planned]** Kubernetes deployment manifests, Helm charts, and production scaling configurations are not yet implemented.

Intended approach:
- Namespace: `meza`
- Secrets via sealed-secrets or external-secrets-operator
- Per-service Deployments with readiness/liveness probes on `/health`
- HPA scaling on custom metrics (e.g., `meza_gateway_connections` at 4000/pod)
- Network policies restricting database access to authorized services

---

## NATS Configuration

- **Cluster**: 3-node NATS cluster with JetStream enabled
- **JetStream EVENTS stream**: Persists `meza.deliver.>` subjects for 24h (gateway reconnection replay)
- **Queue groups**: Ensure each message processed by exactly one service instance
- **Gateway subscriptions**: Regular (fan-out) so all gateway instances receive delivery events

---

## Scaling Strategy

### Per-Service Scaling Triggers

| Service | Scale On | Min | Typical Max |
|---------|----------|-----|-------------|
| Gateway | WebSocket connections (4000/pod) | 2 | 50 |
| Auth | CPU (70%) | 2 | 10 |
| Chat | NATS consumer lag + CPU | 2 | 20 |
| Presence | Redis operations/sec + CPU | 2 | 10 |
| Media | Upload throughput + CPU | 2 | 10 |
| Voice | Active voice rooms | 1 | 5 |
| LiveKit | Participant count | 1 | 20 |

### Database Scaling

- **PostgreSQL**: Vertical first → read replicas → PgBouncer → Citus for sharding beyond ~10M users
- **ScyllaDB**: Add nodes (auto-rebalance). 3 nodes for <1M DAU, ~100K writes/sec per node
- **Redis**: Redis Cluster (6+ nodes). Separate clusters for presence vs. rate limiting vs. LiveKit

---

## Observability Stack

> **[Planned]** Full observability (Prometheus, Grafana, OpenTelemetry, Jaeger) is not yet implemented. Only structured JSON logging (slog) is in place.

### Planned Metrics

Key custom metrics: `meza_gateway_connections`, `meza_gateway_messages_total`, `meza_chat_messages_total`, `meza_chat_latency_seconds`, `meza_presence_online_users`, `meza_auth_logins_total`, `meza_media_uploads_total`, `meza_voice_active_rooms`, `meza_voice_participants`.

### Logging

JSON structured logs shipped to Loki via Promtail.

---

## CI/CD Pipeline (GitHub Actions)

Configured at `.github/workflows/ci.yml`:

- **server-test** — `go vet` + `go test -race` (installs libvips-dev)
- **server-build** — `go build ./...`
- **client-test** — `pnpm test`, `pnpm check` (TypeScript), `pnpm lint` (Biome)

Triggers: push to `main` and pull requests to `main`.

> **[Planned]** Integration tests with Docker service containers, proto linting, container image builds, and deployment automation.

---

## Security Hardening

| Layer | Measure |
|-------|---------|
| Network | Services communicate only within K8s cluster network |
| TLS | All external traffic TLS-terminated at Caddy |
| Secrets | Kubernetes Secrets (or Vault/external-secrets-operator) |
| Containers | Non-root user, read-only filesystem, no capabilities |
| Database | Network policies restrict access to DB pods |
| NATS | TLS + auth tokens between nodes |
| Redis | requirepass + TLS in production |
| S3 | Bucket policy: private, pre-signed URLs only |

---

## Development Workflow

The project uses [Task](https://taskfile.dev/) as a task runner. See `Taskfile.yml` at the repo root.

```bash
# Start infrastructure (Postgres, ScyllaDB, Redis, NATS, MinIO, LiveKit)
task up

# Run database migrations (PostgreSQL + ScyllaDB)
task migrate

# Start all services + client dev server (Ctrl+C to stop)
task start

# Stop everything and tear down infrastructure
task teardown
```

Services started by `task start`:
- gateway `:8080`, auth `:8081`, chat `:8082`, presence `:8083`, media `:8084`, voice `:8085`, notification `:8086`, web (Vite) `:4080`
