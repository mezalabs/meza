#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="deploy/docker/docker-compose.yml"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "Starting Meza infrastructure..."
docker compose -f "$COMPOSE_FILE" up -d postgres redis nats scylla minio livekit

echo "Waiting for services to be healthy..."

services=("postgres" "redis" "nats")
for svc in "${services[@]}"; do
  printf "  Waiting for %s..." "$svc"
  until docker compose -f "$COMPOSE_FILE" exec -T "$svc" true 2>/dev/null; do
    sleep 1
    printf "."
  done
  echo " ready"
done

echo ""
echo "Infrastructure is running:"
echo "  PostgreSQL:   localhost:5432"
echo "  ScyllaDB:     localhost:9042"
echo "  Redis:        localhost:6379"
echo "  NATS:         localhost:4222 (monitoring: localhost:8222)"
echo "  MinIO:        localhost:9000 (console: localhost:9001)"
echo "  LiveKit:      localhost:7880"
echo ""
echo "Run Go services:"
echo "  cd server && go run ./cmd/gateway"
echo "  cd server && go run ./cmd/auth"
echo "  cd server && go run ./cmd/chat"
echo "  cd server && go run ./cmd/presence"
echo "  cd server && go run ./cmd/media"
echo "  cd server && go run ./cmd/voice"
