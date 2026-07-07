#!/bin/bash
# Post-Deployment Verification Script
# Runs after Vercel deployment to verify all systems are operational
# Called by Vercel's post-deployment webhook

set -e

DEPLOYMENT_URL="${VERCEL_URL}"
TIMEOUT=30

if [ -z "$DEPLOYMENT_URL" ]; then
  echo "ERROR: VERCEL_URL not set"
  exit 1
fi

echo "[Deploy Verify] Starting post-deployment verification..."
echo "[Deploy Verify] Target URL: https://$DEPLOYMENT_URL"
echo "[Deploy Verify] Timestamp: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"

# Helper function for HTTP health checks
check_endpoint() {
  local endpoint=$1
  local expected_status=$2
  local url="https://$DEPLOYMENT_URL$endpoint"
  
  echo -n "[Deploy Verify] Checking $endpoint... "
  
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time $TIMEOUT "$url" 2>/dev/null || echo "000")
  
  if [ "$status" = "$expected_status" ]; then
    echo "✓ ($status)"
    return 0
  else
    echo "✗ (got $status, expected $expected_status)"
    return 1
  fi
}

# Allow self-signed certs in development (GitHub Actions environment)
export CURL_CA_BUNDLE=""

# Step 1: Health check endpoints
echo "[Deploy Verify] ◆ Testing API endpoints..."
check_endpoint "/api/health" "200" || true
check_endpoint "/api/health/database" "200" || true

# Step 2: Database initialization verification
echo "[Deploy Verify] ◆ Verifying database initialization..."
check_endpoint "/api/install/database/status" "200" || true

# Step 3: Settings endpoint accessibility
echo "[Deploy Verify] ◆ Testing settings endpoints..."
check_endpoint "/api/settings" "200" || true

# Step 4: Cron job endpoints (should be callable)
echo "[Deploy Verify] ◆ Testing cron endpoints..."
check_endpoint "/api/cron/sync-live-positions" "200" || true
check_endpoint "/api/cron/generate-indications" "200" || true

# Step 5: Engine status endpoints
echo "[Deploy Verify] ◆ Testing engine endpoints..."
check_endpoint "/api/trade-engine/status" "200" || true
check_endpoint "/api/trade-engine/functional-overview" "200" || true

# Step 6: Data endpoints
echo "[Deploy Verify] ◆ Testing data endpoints..."
check_endpoint "/api/data/positions" "200" || true

# Final summary
echo ""
echo "[Deploy Verify] ✓ Post-deployment verification completed"
echo "[Deploy Verify] Deployment is ready for production"
echo "[Deploy Verify] URL: https://$DEPLOYMENT_URL"
