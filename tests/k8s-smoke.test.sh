#!/usr/bin/env bash
# =============================================================================
# Kubernetes Manifest Smoke Tests for Scrum Poker
# =============================================================================
# Usage: bash tests/k8s-smoke.test.sh
#
# Prerequisites: kubectl is optional. The dry-run checks validate manifests
#                offline (--dry-run=client, no cluster connection required)
#                and are recorded as skipped when kubectl is absent.
#
# The repository ships two manifests: k8s/k8s.yaml holds the Deployment and the
# Service as one multi-document file, and k8s/ingress.yaml holds the Ingress.
#
# These tests verify:
#   1. k8s.yaml is valid Kubernetes YAML
#   2. ingress.yaml is valid Kubernetes YAML
#   3. Deployment has readiness and liveness probes configured
#   4. Deployment has resource requests and limits
#   5. Service exposes port 80 and targets container port 3000
#   6. Health check endpoint path is /api/health
# =============================================================================

set -euo pipefail

DEPLOYMENT_MANIFEST="k8s/k8s.yaml"
SERVICE_MANIFEST="k8s/k8s.yaml"
INGRESS_MANIFEST="k8s/ingress.yaml"

PASS=0
FAIL=0
SKIP=0

# Set to 0 by preflight when kubectl is absent; every dry-run check then
# records as skipped instead of failed.
KUBECTL_AVAILABLE=1

pass() {
  echo "  ✅ PASS: $1"
  PASS=$((PASS + 1))
  return 0
}

fail() {
  echo "  ❌ FAIL: $1"
  FAIL=$((FAIL + 1))
  return 0
}

skip() {
  echo "  ⏭️  SKIPPED: $1"
  SKIP=$((SKIP + 1))
  return 0
}

echo "=== Kubernetes Manifest Smoke Tests ==="
echo ""

# ---- Preflight: kubectl is optional ----
if ! command -v kubectl > /dev/null 2>&1; then
  echo "Missing optional executable: kubectl"
  echo "Manifest dry-run checks will be recorded as skipped; all other checks still run."
  echo ""
  KUBECTL_AVAILABLE=0
fi

# ---- Test 1: k8s.yaml passes dry-run validation ----
echo "Test 1: $DEPLOYMENT_MANIFEST is valid"
if [ "$KUBECTL_AVAILABLE" -eq 0 ]; then
  skip "kubectl is absent, so the dry-run validation of $DEPLOYMENT_MANIFEST did not run"
elif kubectl apply --dry-run=client -f "$DEPLOYMENT_MANIFEST" > /dev/null 2>&1; then
  pass "$DEPLOYMENT_MANIFEST passes kubectl dry-run validation"
else
  fail "$DEPLOYMENT_MANIFEST failed kubectl dry-run validation"
fi

# ---- Test 2: ingress.yaml passes dry-run validation ----
echo "Test 2: $INGRESS_MANIFEST is valid"
if [ "$KUBECTL_AVAILABLE" -eq 0 ]; then
  skip "kubectl is absent, so the dry-run validation of $INGRESS_MANIFEST did not run"
elif kubectl apply --dry-run=client -f "$INGRESS_MANIFEST" > /dev/null 2>&1; then
  pass "$INGRESS_MANIFEST passes kubectl dry-run validation"
else
  fail "$INGRESS_MANIFEST failed kubectl dry-run validation"
fi

# ---- Test 3: Deployment has readiness probe ----
echo "Test 3: Deployment has readiness probe"
if grep -q "readinessProbe" "$DEPLOYMENT_MANIFEST"; then
  pass "Deployment has readinessProbe configured"
else
  fail "Deployment missing readinessProbe"
fi

# ---- Test 4: Deployment has liveness probe ----
echo "Test 4: Deployment has liveness probe"
if grep -q "livenessProbe" "$DEPLOYMENT_MANIFEST"; then
  pass "Deployment has livenessProbe configured"
else
  fail "Deployment missing livenessProbe"
fi

# ---- Test 5: Probes target /api/health ----
echo "Test 5: Probes target /api/health endpoint"
HEALTH_COUNT=$(grep -c "/api/health" "$DEPLOYMENT_MANIFEST" || true)
if [ "${HEALTH_COUNT:-0}" -ge 2 ]; then
  pass "Both probes target /api/health (found $HEALTH_COUNT references)"
else
  fail "Expected at least 2 /api/health references in probes, found ${HEALTH_COUNT:-0}"
fi

# ---- Test 6: Deployment has resource requests and limits ----
echo "Test 6: Deployment has resource requests and limits"
if grep -q "requests:" "$DEPLOYMENT_MANIFEST" && grep -q "limits:" "$DEPLOYMENT_MANIFEST"; then
  pass "Deployment has resource requests and limits"
else
  fail "Deployment missing resource requests or limits"
fi

# ---- Test 7: Service exposes port 80 ----
echo "Test 7: Service exposes port 80"
if grep -q "port: 80" "$SERVICE_MANIFEST"; then
  pass "Service exposes port 80"
else
  fail "Service does not expose port 80"
fi

# ---- Test 8: Service targets container port 3000 ----
echo "Test 8: Service targets container port 3000"
if grep -q "targetPort: 3000" "$SERVICE_MANIFEST"; then
  pass "Service targets container port 3000"
else
  fail "Service does not target container port 3000"
fi

# ---- Test 9: Deployment specifies container image ----
echo "Test 9: Deployment specifies container image"
if grep -q "image:" "$DEPLOYMENT_MANIFEST"; then
  pass "Deployment specifies container image"
else
  fail "Deployment missing container image"
fi

# ---- Summary ----
echo ""
echo "=== Results: $PASS passed, $FAIL failed, $SKIP skipped ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

exit 0
