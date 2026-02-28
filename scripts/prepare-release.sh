#!/usr/bin/env bash
#
# prepare-release.sh — Produce a clean export of the Meza repository
# for public open-source release under the meza-chat GitHub org.
#
# Uses `git archive` to export only tracked files, then removes internal
# documentation, production configs, and sanitizes domain references.
#
# Usage: ./scripts/prepare-release.sh [output-directory]
#
set -euo pipefail

# --- Configuration ---
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_DIR="${1:-$SOURCE_DIR/release}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass() { echo -e "${GREEN}PASS${NC}: $1"; }
fail() { echo -e "${RED}FAIL${NC}: $1"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "${YELLOW}==>${NC} $1"; }

FAILURES=0

# --- Step 1: Export tracked files via git archive ---
info "Step 1: Exporting tracked files via git archive"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
cd "$SOURCE_DIR"
git archive HEAD | tar -x -C "$RELEASE_DIR"
echo "  Exported to $RELEASE_DIR"

# --- Step 2: Remove excluded directories and files ---
info "Step 2: Removing internal documentation and tooling"
rm -rf "$RELEASE_DIR/docs/brainstorms"
rm -rf "$RELEASE_DIR/docs/plans"
rm -rf "$RELEASE_DIR/docs/solutions"
rm -rf "$RELEASE_DIR/todos"
rm -f  "$RELEASE_DIR/compound-engineering.local.md"
rm -f  "$RELEASE_DIR/CLAUDE.md"
echo "  Removed: docs/brainstorms, docs/plans, docs/solutions, todos, CLAUDE.md, compound-engineering.local.md"

# --- Step 3: Remove production deploy configs ---
info "Step 3: Removing production deploy configs"
rm -f  "$RELEASE_DIR/deploy/Caddyfile.prod"
rm -f  "$RELEASE_DIR/deploy/docker/docker-compose.prod.yml"
rm -f  "$RELEASE_DIR/deploy/docker/.env.production.example"
rm -f  "$RELEASE_DIR/deploy/docker/livekit-prod.yaml"
rm -f  "$RELEASE_DIR/deploy/docker/Dockerfile"
rm -f  "$RELEASE_DIR/deploy/docker/Dockerfile.media"
rm -f  "$RELEASE_DIR/deploy/docker/Dockerfile.client"
rm -rf "$RELEASE_DIR/deploy/scripts"
rm -rf "$RELEASE_DIR/deploy/monitoring"
rm -f  "$RELEASE_DIR/docs/DEPLOY.md"
rm -f  "$RELEASE_DIR/docs/RESTORE.md"
rm -f  "$RELEASE_DIR/.github/workflows/deploy.yml"
rm -f  "$RELEASE_DIR/.github/workflows/build-images.yml"
rm -f  "$RELEASE_DIR/.github/workflows/desktop-release.yml"
echo "  Removed production Dockerfiles, deploy workflows, monitoring, and deploy docs"

# --- Step 4: Sanitize REDACTED references ---
info "Step 4: Sanitizing REDACTED references"

# Category A: Config files (simple replacement)
if [ -f "$RELEASE_DIR/.env.example" ]; then
  sed -i 's|https://bnfr\.chat|https://example.com|g' "$RELEASE_DIR/.env.example"
  echo "  .env.example: REDACTED → example.com"
fi

# Category C: Test fixtures (use RFC 2606 domains)
for f in \
  "$RELEASE_DIR/server/internal/auth/connect_interceptor_test.go" \
  "$RELEASE_DIR/server/internal/auth/jwt_federation_test.go" \
  "$RELEASE_DIR/server/internal/auth/jwt_test.go"; do
  if [ -f "$f" ]; then
    sed -i 's|bnfr\.chat|home.example.com|g' "$f"
    echo "  $(basename "$f"): REDACTED → home.example.com"
  fi
done

# Source code comments (context-aware replacements)
if [ -f "$RELEASE_DIR/server/internal/models/user.go" ]; then
  sed -i 's|"https://bnfr\.chat"|"https://home.example.com"|g' "$RELEASE_DIR/server/internal/models/user.go"
  echo "  user.go: example domain updated"
fi

if [ -f "$RELEASE_DIR/server/internal/auth/jwt.go" ]; then
  sed -i 's|"https://bnfr\.chat"|"https://home.example.com"|g' "$RELEASE_DIR/server/internal/auth/jwt.go"
  echo "  jwt.go: example domain updated"
fi

# Proto files — semantic rewriting
if [ -f "$RELEASE_DIR/proto/meza/v1/federation.proto" ]; then
  sed -i 's|bnfr\.chat only:|Home server only:|g' "$RELEASE_DIR/proto/meza/v1/federation.proto"
  sed -i 's|bnfr\.chat issues|the home server issues|g' "$RELEASE_DIR/proto/meza/v1/federation.proto"
  sed -i 's|bnfr\.chat API|home server API|g' "$RELEASE_DIR/proto/meza/v1/federation.proto"
  sed -i 's|from bnfr\.chat|from the home server|g' "$RELEASE_DIR/proto/meza/v1/federation.proto"
  echo "  federation.proto: semantic rewrite complete"
fi

# Federation service comments
if [ -f "$RELEASE_DIR/server/cmd/auth/federation_service.go" ]; then
  sed -i 's|home server (bnfr\.chat)|home server|g' "$RELEASE_DIR/server/cmd/auth/federation_service.go"
  sed -i 's|bnfr\.chat assertion|home server assertion|g' "$RELEASE_DIR/server/cmd/auth/federation_service.go"
  sed -i 's|bnfr\.chat API|home server API|g' "$RELEASE_DIR/server/cmd/auth/federation_service.go"
  sed -i 's|from bnfr\.chat|from the home server|g' "$RELEASE_DIR/server/cmd/auth/federation_service.go"
  sed -i 's|against bnfr\.chat|against the home server|g' "$RELEASE_DIR/server/cmd/auth/federation_service.go"
  echo "  federation_service.go: semantic rewrite complete"
fi

# Docs
if [ -f "$RELEASE_DIR/docs/ARCHITECTURE.md" ]; then
  sed -i 's|https://bnfr\.chat|https://home.example.com|g' "$RELEASE_DIR/docs/ARCHITECTURE.md"
  echo "  ARCHITECTURE.md: REDACTED → home.example.com"
fi

# --- Step 5: Sanitize REDACTED references ---
info "Step 5: Sanitizing REDACTED references"
if [ -f "$RELEASE_DIR/Taskfile.yml" ]; then
  sed -i 's|ghcr\.io/REDACTED/meza|ghcr.io/meza-chat/meza|g' "$RELEASE_DIR/Taskfile.yml"
  echo "  Taskfile.yml: REDACTED → meza-chat"
fi

# Scan all remaining files for REDACTED
remaining_REDACTED=$(grep -rn "REDACTED" "$RELEASE_DIR" --include="*.md" --include="*.yml" --include="*.yaml" --include="*.go" --include="*.ts" --include="*.toml" 2>/dev/null || true)
if [ -n "$remaining_REDACTED" ]; then
  echo "  Warning: remaining REDACTED references found:"
  echo "$remaining_REDACTED" | head -20
fi

# --- Step 6: Sanitize remaining doc references ---
info "Step 6: Sanitizing remaining doc references"

# Remove REDACTED-specific references from any remaining docs
for f in "$RELEASE_DIR"/docs/*.md; do
  if [ -f "$f" ]; then
    sed -i 's|REDACTED [A-Z][A-Z0-9]*[^|]*||g' "$f" 2>/dev/null || true
  fi
done

# Remove absolute local paths
grep -rn "REDACTED\|REDACTED\|REDACTED" "$RELEASE_DIR" 2>/dev/null | head -10 && \
  echo "  Warning: local paths found — review manually" || \
  echo "  No local paths found"

# --- Step 7: Regenerate proto code ---
info "Step 7: Proto regeneration reminder"
echo "  MANUAL STEP: Run 'cd $RELEASE_DIR/proto && buf generate' to regenerate"
echo "  Then verify: git diff --exit-code $RELEASE_DIR/server/gen/ $RELEASE_DIR/client/gen/"

# --- Step 8: Verification checks ---
info "Step 8: Running verification checks"

# No production domain references
if grep -rqn "bnfr\.chat" "$RELEASE_DIR" 2>/dev/null; then
  fail "REDACTED references found:"
  grep -rn "bnfr\.chat" "$RELEASE_DIR" | head -10
else
  pass "No REDACTED references"
fi

# No private org references
if grep -rqn "REDACTED" "$RELEASE_DIR" 2>/dev/null; then
  fail "REDACTED references found:"
  grep -rn "REDACTED" "$RELEASE_DIR" | head -10
else
  pass "No REDACTED references"
fi

# No absolute local paths
if grep -rqn "REDACTED\|REDACTED\|REDACTED" "$RELEASE_DIR" 2>/dev/null; then
  fail "Local paths found:"
  grep -rn "REDACTED\|REDACTED\|REDACTED" "$RELEASE_DIR" | head -10
else
  pass "No local paths"
fi

# No internal tooling
[ ! -f "$RELEASE_DIR/compound-engineering.local.md" ] && pass "No compound-engineering.local.md" || fail "compound-engineering.local.md exists"
[ ! -f "$RELEASE_DIR/CLAUDE.md" ] && pass "No CLAUDE.md" || fail "CLAUDE.md exists"
[ ! -d "$RELEASE_DIR/todos" ] && pass "No todos/" || fail "todos/ exists"
[ ! -d "$RELEASE_DIR/docs/brainstorms" ] && pass "No docs/brainstorms/" || fail "docs/brainstorms/ exists"
[ ! -d "$RELEASE_DIR/docs/plans" ] && pass "No docs/plans/" || fail "docs/plans/ exists"
[ ! -d "$RELEASE_DIR/docs/solutions" ] && pass "No docs/solutions/" || fail "docs/solutions/ exists"

# OSS files present
[ -f "$RELEASE_DIR/LICENSE" ] && pass "LICENSE present" || fail "LICENSE missing"
[ -f "$RELEASE_DIR/CONTRIBUTING.md" ] && pass "CONTRIBUTING.md present" || fail "CONTRIBUTING.md missing"
[ -f "$RELEASE_DIR/SECURITY.md" ] && pass "SECURITY.md present" || fail "SECURITY.md missing"
[ -f "$RELEASE_DIR/CODE_OF_CONDUCT.md" ] && pass "CODE_OF_CONDUCT.md present" || fail "CODE_OF_CONDUCT.md missing"
[ -f "$RELEASE_DIR/.github/ISSUE_TEMPLATE/bug_report.md" ] && pass "Bug report template present" || fail "Bug report template missing"
[ -f "$RELEASE_DIR/.github/ISSUE_TEMPLATE/feature_request.md" ] && pass "Feature request template present" || fail "Feature request template missing"
[ -f "$RELEASE_DIR/.github/PULL_REQUEST_TEMPLATE.md" ] && pass "PR template present" || fail "PR template missing"

# No production deploy configs
[ ! -f "$RELEASE_DIR/deploy/Caddyfile.prod" ] && pass "No Caddyfile.prod" || fail "Caddyfile.prod exists"
[ ! -f "$RELEASE_DIR/deploy/docker/docker-compose.prod.yml" ] && pass "No prod compose" || fail "Prod compose exists"
[ ! -d "$RELEASE_DIR/deploy/monitoring" ] && pass "No monitoring/" || fail "monitoring/ exists"
[ ! -f "$RELEASE_DIR/.github/workflows/deploy.yml" ] && pass "No deploy workflow" || fail "deploy.yml exists"

# Dev compose kept
[ -f "$RELEASE_DIR/deploy/docker/docker-compose.yml" ] && pass "Dev compose present" || fail "Dev compose missing"

# --- Step 9: Report ---
echo ""
info "Release preparation complete"
echo "  Output directory: $RELEASE_DIR"
echo "  Failures: $FAILURES"
echo ""

if [ $FAILURES -gt 0 ]; then
  echo -e "${RED}Some checks failed. Review the output above.${NC}"
  exit 1
else
  echo -e "${GREEN}All checks passed.${NC}"
fi

echo ""
echo "Manual steps remaining:"
echo "  1. Review federation proto comments for semantic correctness"
echo "  2. cd $RELEASE_DIR/proto && buf generate"
echo "  3. cd $RELEASE_DIR/server && go build ./..."
echo "  4. cd $RELEASE_DIR/client && pnpm install && pnpm build"
echo "  5. cd $RELEASE_DIR/server && go test ./..."
echo "  6. Run trufflehog: trufflehog filesystem --directory $RELEASE_DIR --no-verification"
echo "  7. Final review of README.md and CONTRIBUTING.md"
echo "  8. git init && git add -A && git commit -m 'Initial open-source release'"
echo "  9. git remote add origin git@github.com:meza-chat/meza.git && git push -u origin main"
