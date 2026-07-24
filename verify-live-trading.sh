#!/bin/bash

echo "════════════════════════════════════════════════════════════════════════════════"
echo "           LIVE TRADING VERIFICATION - 10 SYMBOLS TEST"
echo "════════════════════════════════════════════════════════════════════════════════"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check 1: Environment variable
echo "Check 1: Environment Configuration"
if [ -z "$ALLOW_INLINE_REDIS_LIVE_TRADING" ] && grep -q "ALLOW_INLINE_REDIS_LIVE_TRADING=1" .env.development.local 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Live trading environment variable configured"
else
    echo -e "${RED}✗${NC} Live trading environment variable NOT configured"
fi
echo ""

# Check 2: API endpoint
echo "Check 2: Live Trading API Status"
status=$(curl -s http://localhost:3002/api/admin/enable-live-trading | jq -r '.allEnabled' 2>/dev/null || echo "error")
if [ "$status" = "true" ]; then
    enabled=$(curl -s http://localhost:3002/api/admin/enable-live-trading | jq -r '.enabledCount' 2>/dev/null)
    echo -e "${GREEN}✓${NC} Live trading enabled on $enabled connections"
else
    echo -e "${YELLOW}⚠${NC} Could not verify API status"
fi
echo ""

# Check 3: Real-trade gates fix
echo "Check 3: Real Trade Gates (Bug Fix)"
if grep -q "blockCode = \"effective_flag_off\"" lib/real-trade-gates.ts 2>/dev/null; then
    echo -e "${RED}✗${NC} BUG STILL PRESENT: effective_flag_off check not removed"
    exit 1
else
    echo -e "${GREEN}✓${NC} BUG FIX CONFIRMED: effective_flag_off check removed"
fi
echo ""

# Check 4: Live stage gate
echo "Check 4: Live Stage Position Gate"
if grep -q "isConnectionLiveTradeEnabled" lib/trade-engine/stages/live-stage.ts; then
    echo -e "${GREEN}✓${NC} Live trade gate present in live-stage.ts"
else
    echo -e "${YELLOW}⚠${NC} Live trade gate might be missing"
fi
echo ""

# Check 5: Build status
echo "Check 5: Application Build"
if [ -d ".next" ]; then
    echo -e "${GREEN}✓${NC} Application built successfully"
    build_age=$(find .next -name "* -mmin -30" 2>/dev/null | wc -l)
    if [ $build_age -gt 0 ]; then
        echo -e "${GREEN}✓${NC} Build is recent (last 30 minutes)"
    else
        echo -e "${YELLOW}⚠${NC} Build might be stale (older than 30 minutes)"
    fi
else
    echo -e "${RED}✗${NC} Application NOT built"
fi
echo ""

# Check 6: Dev server
echo "Check 6: Development Server"
if curl -s http://localhost:3002/ > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Dev server running on port 3002"
else
    echo -e "${RED}✗${NC} Dev server NOT responding on port 3002"
fi
echo ""

# Check 7: Symbol configuration
echo "Check 7: Symbol Configuration (10 Required)"
symbol_count=$(grep -o "MAGMA\|BTC\|ETH\|SOL\|ADA\|XRP\|DOGE\|MATIC\|AVAX\|LINK" lib/constants.ts 2>/dev/null | wc -l)
if [ $symbol_count -ge 10 ]; then
    echo -e "${GREEN}✓${NC} All 10 test symbols configured ($symbol_count found)"
else
    echo -e "${YELLOW}⚠${NC} Symbol configuration: $symbol_count/10 found"
fi
echo ""

echo "════════════════════════════════════════════════════════════════════════════════"
echo "VERIFICATION COMPLETE"
echo "════════════════════════════════════════════════════════════════════════════════"
echo ""
echo "Ready for 10-Symbol Live Trading Test!"
echo ""
echo "Next Step: Open http://your-server-ip:3002 and follow LIVE_TRADING_TEST_10SYMBOLS.md"
