#!/usr/bin/env bash
# =============================================================================
# Docker Smoke Tests for Scrum Poker
# =============================================================================
# Usage: bash tests/docker-smoke.test.sh
#
# Prerequisites: Docker must be installed and running.
#
# These tests verify:
#   1. The Docker image builds successfully with multi-stage build
#   2. The final image does NOT contain dev dependencies
#   3. The final image does NOT contain source maps
#   4. The final image does NOT contain test files
#   5. The container starts and the health endpoint responds
# =============================================================================

set -euo pipefail

IMAGE_NAME="scrum-poker-smoke-test"
CONTAINER_NAME="scrum-poker-smoke-container"
PASS=0
FAIL=0

cleanup() {
  echo ""
  echo "Cleaning up..."
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  docker rmi "$IMAGE_NAME" 2>/dev/null || true
}

trap cleanup EXIT

pass() {
  echo "  ✅ PASS: $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  ❌ FAIL: $1"
  FAIL=$((FAIL + 1))
}

echo "=== Docker Smoke Tests ==="
echo ""

# ---- Test 1: Docker image builds successfully ----
echo "Test 1: Docker image builds successfully"
if docker build -t "$IMAGE_NAME" . > /dev/null 2>&1; then
  pass "Docker image built successfully"
else
  fail "Docker image build failed"
  echo "Build failed — cannot continue remaining tests."
  echo ""
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

# ---- Test 2: No dev dependencies in final image ----
echo "Test 2: Final image does not contain dev dependencies"
# Check that typescript (a devDependency) is not installed
if docker run --rm "$IMAGE_NAME" sh -c "test -d /app/server/node_modules/typescript" 2>/dev/null; then
  fail "Dev dependency 'typescript' found in final image"
else
  pass "No dev dependency 'typescript' in final image"
fi

# Check that jest (a devDependency) is not installed
if docker run --rm "$IMAGE_NAME" sh -c "test -d /app/server/node_modules/jest" 2>/dev/null; then
  fail "Dev dependency 'jest' found in final image"
else
  pass "No dev dependency 'jest' in final image"
fi

# Check that ts-jest is not installed
if docker run --rm "$IMAGE_NAME" sh -c "test -d /app/server/node_modules/ts-jest" 2>/dev/null; then
  fail "Dev dependency 'ts-jest' found in final image"
else
  pass "No dev dependency 'ts-jest' in final image"
fi

# ---- Test 3: No source maps in final image ----
echo "Test 3: Final image does not contain source maps"
SERVER_MAPS=$(docker run --rm "$IMAGE_NAME" sh -c "find /app/server -name '*.map' 2>/dev/null | head -5" || true)
if [ -z "$SERVER_MAPS" ]; then
  pass "No source maps found in server directory"
else
  fail "Source maps found in server directory: $SERVER_MAPS"
fi

# ---- Test 4: No test files in final image ----
echo "Test 4: Final image does not contain test files"
TEST_FILES=$(docker run --rm "$IMAGE_NAME" sh -c "find /app/server -name '*.test.ts' -o -name '*.spec.ts' -o -name '*.test.js' -o -name '*.spec.js' 2>/dev/null | head -5" || true)
if [ -z "$TEST_FILES" ]; then
  pass "No test files found in server directory"
else
  fail "Test files found in server directory: $TEST_FILES"
fi

# ---- Test 5: Container starts and health endpoint responds ----
echo "Test 5: Container starts and health endpoint responds"
docker run -d --name "$CONTAINER_NAME" -p 13579:3000 "$IMAGE_NAME" > /dev/null 2>&1

# Wait for the container to start
sleep 3

HEALTH_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:13579/api/health 2>/dev/null || echo "000")
if [ "$HEALTH_RESPONSE" = "200" ]; then
  pass "Health endpoint returned HTTP 200"
else
  fail "Health endpoint returned HTTP $HEALTH_RESPONSE (expected 200)"
fi

# ---- Test 6: Angular static files are served ----
echo "Test 6: Angular static files are served"
INDEX_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:13579/ 2>/dev/null || echo "000")
if [ "$INDEX_RESPONSE" = "200" ]; then
  pass "Angular index.html served successfully"
else
  fail "Angular index.html returned HTTP $INDEX_RESPONSE (expected 200)"
fi

# ---- Summary ----
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
