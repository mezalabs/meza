#!/usr/bin/env bash
# start.sh — Start all Meza services with PID tracking.
# Called by: task start (Taskfile.yml)
# Requires: PID_DIR, WORKTREE_ID, COMPOSE_PROJECT environment variables
set -euo pipefail
set -m  # Enable job control for process groups

: "${PID_DIR:?PID_DIR must be set}"
: "${WORKTREE_ID:?WORKTREE_ID must be set}"
: "${COMPOSE_PROJECT:?COMPOSE_PROJECT must be set}"

# Create PID directory securely (check symlink after mkdir to avoid TOCTOU)
mkdir -p "$PID_DIR"
if [[ -L "$PID_DIR" ]]; then
  echo "ERROR: $PID_DIR is a symlink, refusing to proceed" >&2
  exit 1
fi
chmod 700 "$PID_DIR"

# Write metadata
echo "$WORKTREE_ID" > "$PID_DIR/worktree.txt"
echo "$COMPOSE_PROJECT" > "$PID_DIR/compose-project.txt"

# On exit: kill all service process groups, clean PID files
cleanup() {
  echo ""
  echo "Stopping services..."
  for f in "$PID_DIR"/*.pid; do
    [[ -f "$f" ]] || continue
    pid=$(cat "$f")
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    (( pid > 1 )) || continue
    kill -0 "$pid" 2>/dev/null || continue
    kill -- -"$pid" 2>/dev/null || true
  done
  rm -rf "$PID_DIR"/bin "$PID_DIR"/*.pid "$PID_DIR/worktree.txt"
}
trap cleanup EXIT

# Auto-generate Ed25519 dev keys if they don't exist.
# Services need MEZA_JWT_PRIVATE_KEY_FILE (auth, gateway) and
# MEZA_ED25519_PUBLIC_KEY_FILE (all services) for JWT signing/verification.
KEYS_DIR="$(git rev-parse --show-toplevel)/.keys"
if [[ ! -f "$KEYS_DIR/ed25519.pem" ]]; then
  echo "Generating Ed25519 dev keys in .keys/..."
  mkdir -p "$KEYS_DIR"
  openssl genpkey -algorithm Ed25519 -out "$KEYS_DIR/ed25519.pem" 2>/dev/null
  openssl pkey -in "$KEYS_DIR/ed25519.pem" -pubout -out "$KEYS_DIR/ed25519_pub.pem" 2>/dev/null
  echo "  Created .keys/ed25519.pem and .keys/ed25519_pub.pem"
fi
export MEZA_JWT_PRIVATE_KEY_FILE="$KEYS_DIR/ed25519.pem"
export MEZA_ED25519_PUBLIC_KEY_FILE="$KEYS_DIR/ed25519_pub.pem"

# Pre-build all services so startup is instant (avoids 7 concurrent go builds
# competing for CPU and exceeding the port-ready timeout).
echo "Building services..."
BIN_DIR="$PID_DIR/bin"
mkdir -p "$BIN_DIR"
(cd server && go build -o "$BIN_DIR/gateway" ./cmd/gateway && \
  go build -o "$BIN_DIR/auth" ./cmd/auth && \
  go build -o "$BIN_DIR/chat" ./cmd/chat && \
  go build -o "$BIN_DIR/presence" ./cmd/presence && \
  go build -o "$BIN_DIR/media" ./cmd/media && \
  go build -o "$BIN_DIR/voice" ./cmd/voice && \
  go build -o "$BIN_DIR/keys" ./cmd/keys && \
  go build -o "$BIN_DIR/notification" ./cmd/notification) || { echo "Build failed"; exit 1; }

echo "Starting Meza services (worktree: $WORKTREE_ID)..."

MEZA_LISTEN_ADDR=:8080 "$BIN_DIR/gateway" &
echo $! > "$PID_DIR/gateway.pid"

MEZA_LISTEN_ADDR=:8081 "$BIN_DIR/auth" &
echo $! > "$PID_DIR/auth.pid"

MEZA_LISTEN_ADDR=:8082 "$BIN_DIR/chat" &
echo $! > "$PID_DIR/chat.pid"

MEZA_LISTEN_ADDR=:8083 "$BIN_DIR/presence" &
echo $! > "$PID_DIR/presence.pid"

MEZA_LISTEN_ADDR=:8084 "$BIN_DIR/media" &
echo $! > "$PID_DIR/media.pid"

MEZA_LISTEN_ADDR=:8085 "$BIN_DIR/voice" &
echo $! > "$PID_DIR/voice.pid"

MEZA_LISTEN_ADDR=:8088 "$BIN_DIR/keys" &
echo $! > "$PID_DIR/keys.pid"

# FCM push notifications: use Firebase service account if available.
FCM_CREDS="$KEYS_DIR/firebase-service-account.json"
if [[ -f "$FCM_CREDS" ]]; then
  export MEZA_FCM_CREDENTIALS_FILE="$FCM_CREDS"
fi
MEZA_LISTEN_ADDR=:8086 "$BIN_DIR/notification" &
echo $! > "$PID_DIR/notification.pid"

echo ""
echo "  gateway      :8080"
echo "  auth         :8081"
echo "  chat         :8082"
echo "  presence     :8083"
echo "  media        :8084"
echo "  voice        :8085"
echo "  notification :8086"
echo "  keys         :8088"
echo "  web          :4080 (vite)"
echo ""

# Wait for core services to accept connections before starting Vite,
# so the browser doesn't hit proxy errors on first load.
wait_for_port() {
  local port=$1 name=$2
  for _ in $(seq 1 60); do
    if command -v ss >/dev/null 2>&1; then
      ss -tlnH "sport = :$port" 2>/dev/null | grep -q "$port" && return 0
    else
      bash -c "echo >/dev/tcp/127.0.0.1/$port" 2>/dev/null && return 0
    fi
    sleep 0.5
  done
  echo "WARNING: $name (:$port) did not start in time" >&2
  return 1
}

echo "Waiting for services..."
wait_for_port 8081 auth
wait_for_port 8082 chat
echo "Services ready, starting Vite..."

(cd client && pnpm install --frozen-lockfile && pnpm dev --port 4080) &
echo $! > "$PID_DIR/vite.pid"

# Seed dev data in background (waits for Auth service readiness internally)
if [ "${MEZA_SKIP_SEED:-0}" != "1" ]; then
  (cd scripts/seed && pnpm install --frozen-lockfile --silent && npx tsx src/index.ts full 2>&1) &
fi

echo "Press Ctrl+C to stop all services."
wait
