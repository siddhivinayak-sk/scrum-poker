#!/usr/bin/env bash
# =============================================================================
# Helm Chart Smoke Tests for Scrum Poker
# =============================================================================
# Usage: bash tests/helm-smoke.test.sh
#
# Prerequisites:
#   - helm must be installed (required; the script exits 1 without it)
#   - kubectl must be installed for the manifest dry-run checks (optional;
#     those checks are recorded as skipped when kubectl is absent)
#
# Every check reads only the local chart sources under helm/scrum-poker/.
# No check opens a connection to a Kubernetes API server: both `helm template`
# and `kubectl apply --dry-run=client` operate entirely offline.
#
# Outcomes: each completed check prints exactly one line naming the check and
# stating pass, fail, or skipped. A failing check increments a counter and the
# run continues, so one broken check never aborts the remaining ones.
# The script exits 0 only when the failed count is 0, otherwise 1.
# =============================================================================

set -euo pipefail

# Run from the repository root so every path below stays repo-relative.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CHART_DIR="helm/scrum-poker"
VALUES_FILE="$CHART_DIR/values.yaml"
CHART_README="$CHART_DIR/README.md"
RELEASE_NAME="rel"
# A 44-character lowercase alphanumeric-and-hyphen release name, used by
# check 10 to exercise the `trunc 63 | trimSuffix "-"` naming rule. It stays
# under helm's own 53-character release-name ceiling.
LONG_RELEASE_NAME="scrum-poker-long-release-name-for-truncation"

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

echo "=== Helm Chart Smoke Tests ==="
echo ""

# ---- Preflight: helm is mandatory ----
if ! command -v helm > /dev/null 2>&1; then
  echo "Missing required executable: helm"
  echo "Install helm (3.8 or newer) and re-run tests/helm-smoke.test.sh."
  exit 1
fi

# ---- Preflight: kubectl is optional ----
if ! command -v kubectl > /dev/null 2>&1; then
  echo "Missing optional executable: kubectl"
  echo "Manifest dry-run checks will be recorded as skipped; all other checks still run."
  echo ""
  KUBECTL_AVAILABLE=0
fi

# =============================================================================
# Checks
# =============================================================================

# ---- Check 1: the chart lints cleanly with default values ----
echo "Check 1: helm lint accepts the chart with default values"
if helm lint "$CHART_DIR" > /dev/null 2>&1; then
  pass "helm lint $CHART_DIR exited 0"
else
  fail "helm lint $CHART_DIR exited non-zero"
fi
echo ""

# ---- Check 2: the default render is a valid set of manifests ----
# `kubectl apply --dry-run=client` validates locally; it is recorded as skipped
# rather than failed when kubectl is absent (preflight set KUBECTL_AVAILABLE=0).
echo "Check 2: the default render passes kubectl apply --dry-run=client"
if [ "$KUBECTL_AVAILABLE" -eq 0 ]; then
  skip "kubectl is absent, so the manifest dry-run of the default render did not run"
elif helm template "$RELEASE_NAME" "$CHART_DIR" 2> /dev/null \
  | kubectl apply --dry-run=client -f - > /dev/null 2>&1; then
  pass "helm template and kubectl apply --dry-run=client both exited 0"
else
  fail "helm template or kubectl apply --dry-run=client exited non-zero"
fi
echo ""

# ---- Default render, shared by checks 3, 4, and 5 ----
# Rendered once so the three content checks read identical bytes. A render
# failure is recorded per check rather than aborting the run.
DEFAULT_RENDER=""
DEFAULT_RENDER_OK=1
if ! DEFAULT_RENDER="$(helm template "$RELEASE_NAME" "$CHART_DIR" 2>&1)"; then
  DEFAULT_RENDER_OK=0
fi

# ---- Check 3: exactly one Deployment and exactly one Service ----
# The `$` anchor keeps `kind: ServiceAccount` out of the Service count.
echo "Check 3: the default render holds exactly one Deployment and one Service"
if [ "$DEFAULT_RENDER_OK" -eq 0 ]; then
  fail "the default render exited non-zero, so resource kinds could not be counted"
else
  DEPLOYMENT_COUNT="$(grep -c '^kind: Deployment$' <<< "$DEFAULT_RENDER" || true)"
  SERVICE_COUNT="$(grep -c '^kind: Service$' <<< "$DEFAULT_RENDER" || true)"
  if [ "$DEPLOYMENT_COUNT" -eq 1 ] && [ "$SERVICE_COUNT" -eq 1 ]; then
    pass "the default render holds exactly one Deployment and exactly one Service"
  else
    fail "expected one Deployment and one Service, found $DEPLOYMENT_COUNT Deployment and $SERVICE_COUNT Service resources"
  fi
fi
echo ""

# ---- Check 4: exactly two /api/health paths, one per probe ----
echo "Check 4: the default render holds exactly two /api/health probe paths"
if [ "$DEFAULT_RENDER_OK" -eq 0 ]; then
  fail "the default render exited non-zero, so the /api/health occurrences could not be counted"
else
  HEALTH_COUNT="$(grep -o '/api/health' <<< "$DEFAULT_RENDER" | wc -l | tr -d '[:space:]')"
  READINESS_COUNT="$(grep -c '^ *readinessProbe:$' <<< "$DEFAULT_RENDER" || true)"
  LIVENESS_COUNT="$(grep -c '^ *livenessProbe:$' <<< "$DEFAULT_RENDER" || true)"
  if [ "$HEALTH_COUNT" -eq 2 ] && [ "$READINESS_COUNT" -eq 1 ] && [ "$LIVENESS_COUNT" -eq 1 ]; then
    pass "/api/health occurs exactly twice, with one readiness probe and one liveness probe"
  else
    fail "expected two /api/health occurrences across one readiness and one liveness probe, found $HEALTH_COUNT occurrences, $READINESS_COUNT readinessProbe and $LIVENESS_COUNT livenessProbe blocks"
  fi
fi
echo ""

# ---- Check 5: container requests 100m/128Mi and limits 500m/512Mi ----
# Each block is read as its own two leaf lines, so a value under `requests`
# cannot satisfy an assertion about `limits`.
echo "Check 5: the container carries the default resource requests and limits"
if [ "$DEFAULT_RENDER_OK" -eq 0 ]; then
  fail "the default render exited non-zero, so the container resources could not be read"
else
  REQUESTS_BLOCK="$(grep -A2 '^ *requests:$' <<< "$DEFAULT_RENDER" | tr -d ' "' || true)"
  LIMITS_BLOCK="$(grep -A2 '^ *limits:$' <<< "$DEFAULT_RENDER" | tr -d ' "' || true)"
  RESOURCE_PROBLEMS=""
  grep -q '^cpu:100m$' <<< "$REQUESTS_BLOCK" || RESOURCE_PROBLEMS="$RESOURCE_PROBLEMS requests.cpu!=100m"
  grep -q '^memory:128Mi$' <<< "$REQUESTS_BLOCK" || RESOURCE_PROBLEMS="$RESOURCE_PROBLEMS requests.memory!=128Mi"
  grep -q '^cpu:500m$' <<< "$LIMITS_BLOCK" || RESOURCE_PROBLEMS="$RESOURCE_PROBLEMS limits.cpu!=500m"
  grep -q '^memory:512Mi$' <<< "$LIMITS_BLOCK" || RESOURCE_PROBLEMS="$RESOURCE_PROBLEMS limits.memory!=512Mi"
  if [ -z "$RESOURCE_PROBLEMS" ]; then
    pass "requests are 100m CPU and 128Mi memory, limits are 500m CPU and 512Mi memory"
  else
    fail "unexpected container resources:$RESOURCE_PROBLEMS"
  fi
fi
echo ""

# ---- Check 6: a disabled ingress renders no Ingress resource ----
echo "Check 6: ingress.enabled=false renders zero Ingress resources"
if ! INGRESS_OFF_RENDER="$(helm template "$RELEASE_NAME" "$CHART_DIR" --set ingress.enabled=false 2>&1)"; then
  fail "helm template with ingress.enabled=false exited non-zero"
else
  INGRESS_OFF_COUNT="$(grep -c '^kind: Ingress$' <<< "$INGRESS_OFF_RENDER" || true)"
  if [ "$INGRESS_OFF_COUNT" -eq 0 ]; then
    pass "helm template exited 0 and rendered zero Ingress resources"
  else
    fail "expected zero Ingress resources, found $INGRESS_OFF_COUNT"
  fi
fi
echo ""

# ---- Check 7: an enabled ingress renders one Ingress with the read timeout ----
# The annotation value is quoted in the render, so the assertion reads the
# literal `"3600"` rather than a bare number a YAML parser would widen.
echo "Check 7: ingress.enabled=true renders one Ingress with proxy-read-timeout \"3600\""
if ! INGRESS_ON_RENDER="$(helm template "$RELEASE_NAME" "$CHART_DIR" --set ingress.enabled=true 2>&1)"; then
  fail "helm template with ingress.enabled=true exited non-zero"
else
  INGRESS_ON_COUNT="$(grep -c '^kind: Ingress$' <<< "$INGRESS_ON_RENDER" || true)"
  TIMEOUT_COUNT="$(grep -c 'nginx\.ingress\.kubernetes\.io/proxy-read-timeout: "3600"$' <<< "$INGRESS_ON_RENDER" || true)"
  if [ "$INGRESS_ON_COUNT" -eq 1 ] && [ "$TIMEOUT_COUNT" -eq 1 ]; then
    pass "helm template exited 0 and rendered exactly one Ingress carrying proxy-read-timeout \"3600\""
  else
    fail "expected one Ingress carrying one proxy-read-timeout \"3600\" annotation, found $INGRESS_ON_COUNT Ingress resources and $TIMEOUT_COUNT matching annotations"
  fi
fi
echo ""

# ---- Check 8: a base path without a leading slash is rejected ----
# `scrum-poker` is caught by the values.schema.json pattern `^$|^/` before any
# template runs, so the rejection arrives one layer earlier than guard 6; either
# way the emitted message names `config.basePath`, which is what is asserted.
# The if/elif/else form keeps the expected non-zero status from tripping `set -e`.
echo "Check 8: config.basePath=scrum-poker is rejected with a message naming config.basePath"
if BASE_PATH_OUTPUT="$(helm template "$RELEASE_NAME" "$CHART_DIR" --set config.basePath=scrum-poker 2>&1)"; then
  fail "helm template with config.basePath=scrum-poker exited 0, expected a non-zero status"
elif grep -q 'config\.basePath' <<< "$BASE_PATH_OUTPUT"; then
  pass "helm template exited non-zero and the message named config.basePath"
else
  fail "helm template exited non-zero but the message did not name config.basePath"
fi
echo ""

# ---- Check 9: a base path disagreeing with the ingress path is rejected ----
# Guard 13 compares the normalised `config.basePath` against each ingress path
# while `ingress.enabled` and `config.preservePath` are both true; `/other`
# differs from the default `/scrum-poker` path, so the render must abort.
echo "Check 9: a base path disagreeing with the ingress path is rejected with a message naming config.basePath"
if MISMATCH_OUTPUT="$(helm template "$RELEASE_NAME" "$CHART_DIR" \
  --set config.preservePath=true,ingress.enabled=true,config.basePath=/other 2>&1)"; then
  fail "helm template with a mismatched config.basePath exited 0, expected a non-zero status"
elif grep -q 'config\.basePath' <<< "$MISMATCH_OUTPUT"; then
  pass "helm template exited non-zero and the message named config.basePath"
else
  fail "helm template exited non-zero but the message did not name config.basePath"
fi
echo ""

# ---- Check 10: a long release name still yields legal resource names ----
# `metadata.name` is the only `name:` key rendered at exactly two spaces of
# indentation, so that anchor collects the resource names without picking up
# the deeper container, port, or ingress-backend `name:` keys.
echo "Check 10: a ${#LONG_RELEASE_NAME}-character release name renders resource names of at most 63 characters ending in a non-hyphen"
if ! LONG_NAME_RENDER="$(helm template "$LONG_RELEASE_NAME" "$CHART_DIR" 2>&1)"; then
  fail "helm template with the release name $LONG_RELEASE_NAME exited non-zero"
else
  RENDERED_NAMES="$(grep -E '^  name: ' <<< "$LONG_NAME_RENDER" | sed -e 's/^  name: //' -e 's/^"//' -e 's/"$//' || true)"
  NAME_PROBLEMS=""
  NAME_COUNT=0
  while IFS= read -r RENDERED_NAME; do
    [ -n "$RENDERED_NAME" ] || continue
    NAME_COUNT=$((NAME_COUNT + 1))
    if [ "${#RENDERED_NAME}" -gt 63 ]; then
      NAME_PROBLEMS="$NAME_PROBLEMS\n    $RENDERED_NAME is ${#RENDERED_NAME} characters, over the 63-character limit"
    fi
    if [ "${RENDERED_NAME: -1}" = "-" ]; then
      NAME_PROBLEMS="$NAME_PROBLEMS\n    $RENDERED_NAME ends in a hyphen"
    fi
  done <<< "$RENDERED_NAMES"

  if [ "$NAME_COUNT" -eq 0 ]; then
    fail "the render with the release name $LONG_RELEASE_NAME held no metadata.name value to check"
  elif [ -z "$NAME_PROBLEMS" ]; then
    pass "all $NAME_COUNT rendered resource names are at most 63 characters and end in a non-hyphen character"
  else
    printf '%b\n' "$NAME_PROBLEMS"
    fail "$NAME_COUNT rendered resource names checked, some break the truncation rule"
  fi
fi
echo ""

# ---- Check 11: the README documents every top-level values key ----
# Keys are read from values.yaml with a comment- and indentation-aware match,
# so `# comment` lines and every nested key are ignored. A key that only has
# nested rows in the README table (`image.repository` and friends) is matched
# by prefix: the key followed by `.`, `[`, or the closing backtick.
echo "Check 11: $CHART_README documents every top-level key of $VALUES_FILE"
if [ ! -f "$CHART_README" ]; then
  fail "the chart README is missing: $CHART_README"
else
  TOP_LEVEL_KEYS="$(grep -E '^[a-zA-Z_][a-zA-Z0-9_]*:' "$VALUES_FILE" | sed -E 's/^([a-zA-Z_][a-zA-Z0-9_]*):.*$/\1/' || true)"
  UNDOCUMENTED_KEYS=""
  KEY_COUNT=0
  while IFS= read -r VALUES_KEY; do
    [ -n "$VALUES_KEY" ] || continue
    KEY_COUNT=$((KEY_COUNT + 1))
    if ! grep -qE "^\| \`$VALUES_KEY(\`|\.|\[)" "$CHART_README"; then
      UNDOCUMENTED_KEYS="$UNDOCUMENTED_KEYS $VALUES_KEY"
    fi
  done <<< "$TOP_LEVEL_KEYS"

  if [ "$KEY_COUNT" -eq 0 ]; then
    fail "no top-level key could be read from $VALUES_FILE"
  elif [ -z "$UNDOCUMENTED_KEYS" ]; then
    pass "all $KEY_COUNT top-level values keys hold at least one values-table row in $CHART_README"
  else
    fail "undocumented top-level keys in $CHART_README:$UNDOCUMENTED_KEYS"
  fi
fi

# ---- Summary ----
echo ""
echo "=== Results: $PASS passed, $FAIL failed, $SKIP skipped ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

exit 0
