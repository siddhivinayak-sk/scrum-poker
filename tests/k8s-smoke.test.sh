#!/usr/bin/env bash
# =============================================================================
# Kubernetes Manifest Smoke Tests for Scrum Poker
# =============================================================================
# Usage: bash tests/k8s-smoke.test.sh
#
# Prerequisites: kubectl must be installed (cluster connection NOT required —
#                tests use --dry-run=client for offline validation).
#
# These tests verify:
#   1. deployment.yaml is valid Kubernetes YAML
#   2. service.yaml is valid Kubernetes YAML
#   3. Deployment has readiness and liveness probes configured
#   4. Deployment has resource requests and limits
#   5. Service exposes port 80
#   6. Health check endpoint path is /api/health
# =============================================================================

set -euo pipefail

PASS=0
FAIL=0

pass() {
  echo "  ✅ PASS: $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  ❌ FAIL: $1"
  FAIL=$((FAIL + 1))
}

echo "=== Kubernetes Manifest Smoke Tests ==="
echo ""

# ---- Test 1: deployment.yaml passes dry-run validation ----
echo "Test 1: deployment.yaml is valid"
if kubectl apply --dry-run=client -f k8s/deployment.yaml > /dev/null 2>&1; then
  pass "deployment.yaml passes kubectl dry-run validation"
else
  fail "deployment.yaml failed kubectl dry-run validation"
fi

# ---- Test 2: service.yaml passes dry-run validation ----
echo "Test 2: service.yaml is valid"
if kubectl apply --dry-run=client -f k8s/service.yaml > /dev/null 2>&1; then
  pass "service.yaml passes kubectl dry-run validation"
else
  fail "service.yaml failed kubectl dry-run validation"
fi

# ---- Test 3: Deployment has readiness probe ----
echo "Test 3: Deployment has readiness probe"
if grep -q "readinessProbe" k8s/deployment.yaml; then
  pass "Deployment has readinessProbe configured"
else
  fail "Deployment missing readinessProbe"
fi

# ---- Test 4: Deployment has liveness probe ----
echo "Test 4: Deployment has liveness probe"
if grep -q "livenessProbe" k8s/deployment.yaml; then
  pass "Deployment has livenessProbe configured"
else
  fail "Deployment missing livenessProbe"
fi

# ---- Test 5: Probes target /api/health ----
echo "Test 5: Probes target /api/health endpoint"
HEALTH_COUNT=$(grep -c "/api/health" k8s/deployment.yaml || true)
if [ "$HEALTH_COUNT" -ge 2 ]; then
  pass "Both probes target /api/health (found $HEALTH_COUNT references)"
else
  fail "Expected at least 2 /api/health references in probes, found $HEALTH_COUNT"
fi

# ---- Test 6: Deployment has resource requests and limits ----
echo "Test 6: Deployment has resource requests and limits"
if grep -q "requests:" k8s/deployment.yaml && grep -q "limits:" k8s/deployment.yaml; then
  pass "Deployment has resource requests and limits"
else
  fail "Deployment missing resource requests or limits"
fi

# ---- Test 7: Service exposes port 80 ----
echo "Test 7: Service exposes port 80"
if grep -q "port: 80" k8s/service.yaml; then
  pass "Service exposes port 80"
else
  fail "Service does not expose port 80"
fi

# ---- Test 8: Service targets container port 3000 ----
echo "Test 8: Service targets container port 3000"
if grep -q "targetPort: 3000" k8s/service.yaml; then
  pass "Service targets container port 3000"
else
  fail "Service does not target container port 3000"
fi

# ---- Test 9: Deployment specifies container image ----
echo "Test 9: Deployment specifies container image"
if grep -q "image:" k8s/deployment.yaml; then
  pass "Deployment specifies container image"
else
  fail "Deployment missing container image"
fi

# ---- Summary ----
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
