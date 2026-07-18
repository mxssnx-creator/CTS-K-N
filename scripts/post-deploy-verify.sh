#!/usr/bin/env bash
# Portable post-deployment verification for Vercel, Kilo/Cloudflare, and Node hosts.

set -uo pipefail

RAW_DEPLOYMENT_URL="${DEPLOYMENT_URL:-${VERCEL_URL:-${NEXT_PUBLIC_APP_URL:-}}}"
READ_TIMEOUT_SECONDS="${DEPLOY_VERIFY_TIMEOUT_SECONDS:-30}"
CRON_TIMEOUT_SECONDS="${DEPLOY_VERIFY_CRON_TIMEOUT_SECONDS:-75}"
FAILURES=0

if [ -z "$RAW_DEPLOYMENT_URL" ]; then
  echo "[Deploy Verify] ERROR: set DEPLOYMENT_URL, VERCEL_URL, or NEXT_PUBLIC_APP_URL"
  exit 1
fi

case "$RAW_DEPLOYMENT_URL" in
  http://*|https://*) BASE_URL="${RAW_DEPLOYMENT_URL%/}" ;;
  *) BASE_URL="https://${RAW_DEPLOYMENT_URL%/}" ;;
esac

http_status() {
  local endpoint="$1"
  local timeout_seconds="$2"
  shift 2
  local status
  status="$(curl --silent --show-error --output /dev/null --write-out "%{http_code}" \
    --max-time "$timeout_seconds" "$@" "${BASE_URL}${endpoint}" 2>/dev/null)"
  printf '%s' "${status:-000}"
}

check_endpoint() {
  local endpoint="$1"
  local expected_status="${2:-200}"
  local status
  status="$(http_status "$endpoint" "$READ_TIMEOUT_SECONDS")"
  if [ "$status" = "$expected_status" ]; then
    echo "[Deploy Verify] PASS ${endpoint} (HTTP ${status})"
  else
    echo "[Deploy Verify] FAIL ${endpoint} (HTTP ${status}, expected ${expected_status})"
    FAILURES=$((FAILURES + 1))
  fi
}

verify_cron() {
  local endpoint="/api/cron/server-continuity"
  local unauthenticated_status
  local cron_secret="${CRON_SECRET:-}"
  unauthenticated_status="$(http_status "$endpoint" "$READ_TIMEOUT_SECONDS")"

  case "$unauthenticated_status" in
    401)
      echo "[Deploy Verify] PASS cron rejects unauthenticated traffic; bearer secret is configured"
      ;;
    503)
      if [ "${DEPLOYMENT_CRON_MODE:-}" = "cloudflare-scheduled" ] || \
         [ "${CTS_DEPLOYMENT_RUNTIME:-}" = "cloudflare-workers" ]; then
        echo "[Deploy Verify] PASS external cron is fail-closed; Cloudflare scheduled handler owns the minute trigger"
      else
        echo "[Deploy Verify] FAIL CRON_SECRET is missing for the portable/external minute scheduler"
        FAILURES=$((FAILURES + 1))
      fi
      ;;
    *)
      echo "[Deploy Verify] FAIL unauthenticated cron returned HTTP ${unauthenticated_status}; expected 401 or fail-closed 503"
      FAILURES=$((FAILURES + 1))
      ;;
  esac

  if [ "${#cron_secret}" -ge 16 ]; then
    local status
    for endpoint in /api/cron/server-continuity /api/cron/sync-live-positions; do
      status="$(http_status "$endpoint" "$CRON_TIMEOUT_SECONDS" --header "Authorization: Bearer ${cron_secret}")"
      if [ "$status" = "200" ]; then
        echo "[Deploy Verify] PASS authorized minute tick ${endpoint} (HTTP 200)"
      else
        echo "[Deploy Verify] FAIL authorized minute tick ${endpoint} (HTTP ${status})"
        FAILURES=$((FAILURES + 1))
      fi
    done
  fi
}

echo "[Deploy Verify] Target: ${BASE_URL}"
echo "[Deploy Verify] Timestamp: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"

check_endpoint "/api/health"
check_endpoint "/api/health/database"
check_endpoint "/api/system/init-status"
check_endpoint "/api/install/database/status"
check_endpoint "/api/settings"
check_endpoint "/api/trade-engine/status"
check_endpoint "/api/trade-engine/functional-overview"
check_endpoint "/api/data/positions?connectionId=bingx-x01"
verify_cron

if command -v node >/dev/null 2>&1 && [ -f "scripts/verify-deployment-contract.mjs" ]; then
  if node scripts/verify-deployment-contract.mjs "$BASE_URL"; then
    echo "[Deploy Verify] PASS schema, persistence, identity, and continuity contract"
  else
    echo "[Deploy Verify] FAIL schema, persistence, identity, or continuity contract"
    FAILURES=$((FAILURES + 1))
  fi
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "[Deploy Verify] FAILED with ${FAILURES} verification error(s)"
  exit 1
fi

echo "[Deploy Verify] READY: all required production checks passed"
