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
if curl -s "$BASE_URL" > /dev/null; then echo "✓ Dashboard"; PASSED=$((PASSED+1)); else echo "✗ Dashboard"; FAILED=$((FAILED+1)); fi
if curl -s "$BASE_URL/api/connections" > /dev/null; then echo "✓ API"; PASSED=$((PASSED+1)); else echo "✗ API"; FAILED=$((FAILED+1)); fi
if curl -s "$BASE_URL/api/connections/progression/$CONNECTION_ID/stats" > /dev/null; then echo "✓ Stats"; PASSED=$((PASSED+1)); else echo "✗ Stats"; FAILED=$((FAILED+1)); fi

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
    PASSED=$((PASSED+1))
  else
    echo "✗ Request $i: ${ELAPSED}ms (slow)"
    FAILED=$((FAILED+1))
  fi
done

# Test concurrent requests
echo ""
echo "3. Testing Concurrent Requests..."
success=0
for i in {1..10}; do
  curl -s "$BASE_URL/api/connections/progression/$CONNECTION_ID/stats" > /dev/null 2>&1 && success=$((success+1))
done
if [ $success -eq 10 ]; then
  echo "✓ All 10 concurrent requests succeeded"
  PASSED=$((PASSED+1))
else
  echo "✗ Only $success/10 concurrent requests succeeded"
  FAILED=$((FAILED+1))
fi

# Report
echo ""
echo "=== REPORT ==="
echo "Passed: $PASSED, Failed: $FAILED"
[ $FAILED -eq 0 ] && echo "✓ SYSTEM STABLE" && exit 0 || echo "✗ ISSUES FOUND" && exit 1
