#!/usr/bin/env bash
#
# Build all production Docker images in parallel.
# Called by: task build:prod
# Env vars:  BUILD_REGISTRY, BUILD_TAG (set by Taskfile)
#
set -euo pipefail

REGISTRY="${BUILD_REGISTRY:?missing BUILD_REGISTRY}"
TAG="${BUILD_TAG:?missing BUILD_TAG}"
SERVICES=(gateway auth chat presence voice notification keys migrate admin)
LOGDIR=$(mktemp -d)
trap 'rm -rf "$LOGDIR"' EXIT

echo "==> Registry: $REGISTRY"
echo "==> Tag:      $TAG"
echo "==> Building all 11 images in parallel..."
echo ""

build_one() {
  local name="$1" dockerfile="$2" context="$3"
  shift 3
  docker build -f "$dockerfile" "$@" \
    -t "$REGISTRY/$name:$TAG" \
    -t "$REGISTRY/$name:latest" \
    "$context" > "$LOGDIR/$name.log" 2>&1
}

PIDS=()
NAMES=()

# Standard Go services (shared Dockerfile)
for svc in "${SERVICES[@]}"; do
  build_one "$svc" deploy/docker/Dockerfile server --build-arg "SERVICE=$svc" &
  PIDS+=($!); NAMES+=("$svc")
done

# Media (separate Dockerfile with libvips)
build_one media deploy/docker/Dockerfile.media server &
PIDS+=($!); NAMES+=(media)

# Client SPA
build_one client deploy/docker/Dockerfile.client . &
PIDS+=($!); NAMES+=(client)

# Wait for all builds and collect results
FAILED=0
for i in "${!PIDS[@]}"; do
  if wait "${PIDS[$i]}"; then
    echo "  ✓ ${NAMES[$i]}"
  else
    echo "  ✗ ${NAMES[$i]} failed — last 20 lines:"
    tail -20 "$LOGDIR/${NAMES[$i]}.log" | sed 's/^/    /'
    FAILED=1
  fi
done

echo ""
if [ "$FAILED" -ne 0 ]; then
  echo "✗ Some images failed to build"
  exit 1
fi

echo "✓ All 11 images built:"
for name in "${SERVICES[@]}" media client; do
  echo "  $REGISTRY/$name:$TAG"
done
