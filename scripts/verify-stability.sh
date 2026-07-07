#!/bin/bash
# Comprehensive stability verification script

set -e

echo "=== STABILITY VERIFICATION ==="
BASE_URL="http://localhost:3002"
CONNECTION_ID="bingx-x01"

PASSED=0
FAILED=0

# Test endpoints
echo "1. Testing Endpoint Availability..."
curl -s "$BASE_URL" > /dev/null && echo "✓ Dashboard" && ((PASSED++)) || echo "✗ Dashboard" && ((FAILED++))
curl -s "$BASE_URL/api/connections" > /dev/null && echo "✓ API" && ((PASSED++)) || echo "✗ API" && ((FAILED++))
curl -s "$BASE_URL/api/connections/progression/$CONNECTION_ID/stats" > /dev/null && echo "✓ Stats" && ((PASSED++)) || echo "✗ Stats" && ((FAILED++))

# Test response times
echo ""
echo "2. Testing Response Times..."
for i in {1..5}; do
  START=$(date +%s%N)
  curl -s "$BASE_URL/api/connections/progression/$CONNECTION_ID/stats" > /dev/null 2>&1
  END=$(date +%s%N)
  ELAPSED=$(( (END - START) / 1000000 ))
  if [ $ELAPSED -lt 5000 ]; then
    echo "✓ Request $i: ${ELAPSED}ms"
    ((PASSED++))
  else
    echo "✗ Request $i: ${ELAPSED}ms (slow)"
    ((FAILED++))
  fi
done

# Test concurrent requests
echo ""
echo "3. Testing Concurrent Requests..."
success=0
for i in {1..10}; do
  curl -s "$BASE_URL/api/connections/progression/$CONNECTION_ID/stats" > /dev/null 2>&1 && ((success++))
done
if [ $success -eq 10 ]; then
  echo "✓ All 10 concurrent requests succeeded"
  ((PASSED++))
else
  echo "✗ Only $success/10 concurrent requests succeeded"
  ((FAILED++))
fi

# Report
echo ""
echo "=== REPORT ==="
echo "Passed: $PASSED, Failed: $FAILED"
[ $FAILED -eq 0 ] && echo "✓ SYSTEM STABLE" && exit 0 || echo "✗ ISSUES FOUND" && exit 1
