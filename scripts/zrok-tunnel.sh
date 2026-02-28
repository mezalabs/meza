#!/usr/bin/env bash
set -euo pipefail

# Expose Meza dev environment via zrok for multi-device testing.
# Starts two tunnels: one for the app (Vite, which proxies all APIs + WS)
# and one for LiveKit (so WebRTC clients can reach the signaling server).
#
# Prerequisites:
#   - zrok installed and enabled (zrok enable <token>)
#   - Meza services running (task start)
#
# Usage:
#   1. Add MEZA_LIVEKIT_PUBLIC_URL to .env (script prints the value)
#   2. Run: task start
#   3. In another terminal: ./scripts/zrok-tunnel.sh

cleanup() {
  echo ""
  echo "Stopping zrok tunnels..."
  kill "${LK_PID:-}" "${APP_PID:-}" 2>/dev/null || true
  wait "${LK_PID:-}" "${APP_PID:-}" 2>/dev/null || true
  rm -f "${LK_LOG:-}" "${APP_LOG:-}"
  echo "Done."
}
trap cleanup EXIT

# Wait for and extract the share URL from zrok headless JSON log output.
extract_zrok_url() {
  local logfile="$1"
  local label="$2"
  for i in $(seq 1 30); do
    if [[ -f "$logfile" ]]; then
      url=$(grep -oP 'https://[a-z0-9]+\.share\.zrok\.io' "$logfile" 2>/dev/null | head -1)
      if [[ -n "$url" ]]; then
        echo "$url"
        return 0
      fi
    fi
    sleep 1
  done
  echo "ERROR: timed out waiting for $label tunnel" >&2
  cat "$logfile" >&2
  return 1
}

LK_PORT="${LIVEKIT_PORT:-7880}"
APP_PORT="${APP_PORT:-4080}"

echo "Starting zrok tunnels..."
echo ""
echo "  [LiveKit] localhost:$LK_PORT -> zrok (WebSocket signaling for WebRTC)"
echo "  [App]     localhost:$APP_PORT -> zrok (Vite dev server, proxies ConnectRPC + gateway WS)"

# LiveKit tunnel
LK_LOG=$(mktemp /tmp/zrok-lk-XXXXXX.log)
zrok share public --headless "localhost:$LK_PORT" >"$LK_LOG" 2>&1 &
LK_PID=$!

# App tunnel
APP_LOG=$(mktemp /tmp/zrok-app-XXXXXX.log)
zrok share public --headless "localhost:$APP_PORT" >"$APP_LOG" 2>&1 &
APP_PID=$!

echo ""
echo "Waiting for tunnels to come up..."

LK_URL=$(extract_zrok_url "$LK_LOG" "LiveKit") || exit 1
APP_URL=$(extract_zrok_url "$APP_LOG" "App") || exit 1

echo ""
echo "============================================"
echo "  Meza zrok tunnels running"
echo "============================================"
echo ""
echo "  Mappings:"
echo "    localhost:$APP_PORT  ->  $APP_URL"
echo "    localhost:$LK_PORT  ->  $LK_URL"
echo ""
echo "  Set in .env (then restart voice service):"
echo ""
echo "    MEZA_LIVEKIT_PUBLIC_URL=$LK_URL"
echo ""
echo "  Other devices open: $APP_URL"
echo ""
echo "  Voice note: WebRTC will attempt UDP first;"
echo "  if unreachable, LiveKit falls back to WS relay."
echo ""
echo "  Press Ctrl+C to stop."
echo "============================================"

wait
