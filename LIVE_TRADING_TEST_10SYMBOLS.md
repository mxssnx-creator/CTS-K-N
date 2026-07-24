# Live Trading Test - 10 Symbols on BingX

## Test Objective
Verify that live trading is working correctly with real exchange positions being opened across 10 different symbols on BingX.

## Prerequisites
- BingX connection active (bingx-x01)
- Live trading enabled (is_live_trade = 1)
- Valid BingX API credentials configured
- At least $50 USDT available for testing

## Test Symbols (10)
1. MAGMA/USDT
2. BTC/USDT
3. ETH/USDT
4. SOL/USDT
5. ADA/USDT
6. XRP/USDT
7. DOGE/USDT
8. MATIC/USDT
9. AVAX/USDT
10. LINK/USDT

## Step-by-Step Test Procedure

### Step 1: Verify Live Trading is Enabled
1. Open the app on your server: http://your-server-ip:3002
2. Look for the **"Control Orders ON"** button in the top section
3. Button should be **GREEN** and **ENABLED** (not grayed out)
4. If disabled, click it to enable live trading

**Expected Result:** Control Orders toggle is ON (green)

### Step 2: Start the Engine
1. Click the **"START (MAGMAUSDT)"** button to begin trading
2. You should see the engine status change to "running"
3. The processing pipeline should activate

**Expected Result:** Engine starts and shows active symbols

### Step 3: Monitor Symbol Evaluation (2-3 Minutes)
1. Watch the "Strategies" page or dashboard for symbol processing
2. You should see multiple symbols being evaluated in sequence
3. All 10 symbols should appear in the strategy list
4. Look for strategy indications being generated

**Expected Result:** All 10 symbols showing in active evaluation

### Step 4: Check for Opened Positions (After 3-5 Minutes)
1. Go to "Live Trade" tab or check the "Active Connections" section
2. Look for opened positions
3. Positions should show:
   - Symbol name (e.g., MAGMAUSDT)
   - Entry price (not 0)
   - Position size (in USDT)
   - PnL (should show real P&L, not $0.00 for all)

**Expected Result:** 1-3 positions opened with real prices and PnL

### Step 5: Verify Exchange API Calls
1. Check the detailed logs (Logs section)
2. Look for API calls like:
   ```
   BingX: POST /order/place - MAGMAUSDT (BUY)
   BingX: GET /position - 1 open position
   ```
3. NO "simulated" or "test" messages should appear

**Expected Result:** Real API calls visible, no test/simulation mode

### Step 6: Monitor PnL Updates (5-10 Minutes)
1. Watch the PnL values for opened positions
2. They should change as market prices move
3. PnL should NOT be stuck at $0.00 or showing old values

**Expected Result:** PnL updating in real-time as market moves

### Step 7: Control Orders Toggle Test
1. Toggle the **"Control Orders ON"** button OFF
2. Wait 3 seconds
3. Toggle it back ON
4. **VERIFY:** The toggle does NOT auto-disable after a few seconds
5. **VERIFY:** Live trading remains enabled

**Expected Result:** Toggle stays ON, doesn't auto-disable

### Step 8: Verify on BingX Exchange (Optional)
1. Log in to your BingX account directly
2. Go to "Holdings" or "Open Orders"
3. Verify the positions are actually there:
   - Check symbol names match
   - Check position sizes match the app
   - Check entry prices are recent (within last 5 minutes)

**Expected Result:** Real positions visible on BingX

## Success Criteria

### Must Pass (Critical)
- [ ] Control Orders toggle stays ON (doesn't auto-disable)
- [ ] At least 1 position opens on the exchange
- [ ] Position shows real entry price (not 0)
- [ ] Position shows real market value (not $0.00)
- [ ] No "effective_flag_off" or "simulated" messages in logs
- [ ] All 10 symbols appear in strategy evaluation

### Should Pass (Important)
- [ ] 2-3 positions opened (not just 1)
- [ ] PnL values update in real-time
- [ ] Positions visible on BingX exchange directly
- [ ] API logs show real /order/place calls
- [ ] No errors in backend logs

### Nice to Have
- [ ] 5+ positions opened
- [ ] Realistic PnL ranges (not -100% or +1000%)
- [ ] Stops and targets visible for positions

## Troubleshooting

### Issue: Control Orders toggle auto-disables
**Solution:** The fix has been applied. If this still happens:
1. Check if there's a "blocked_reason" in the logs
2. Restart the app: `pnpm dev`
3. Verify `ALLOW_INLINE_REDIS_LIVE_TRADING=1` in .env

### Issue: No positions opening
**Solution:**
1. Verify BingX API credentials are correct
2. Check that capital is available ($50+ USDT)
3. Look for block reasons in logs: "credentials_missing", "shared_redis_required"
4. Try toggling Control Orders OFF then back ON

### Issue: Positions show $0.00 PnL
**Solution:**
1. This means simulated mode is still active
2. Check if `is_live_trade` is actually set to "1" on the connection
3. Look for "simulated" in the position details
4. Verify no "effective_flag_off" block reason

### Issue: Only 1-2 symbols processing
**Solution:**
1. Check strategy settings for symbol filters
2. Verify all 10 symbols have valid configurations
3. Check if there's a max symbol limit in settings
4. Monitor the logs for symbol filtering events

## What to Expect

### Normal Behavior
- Engine cycles every 2-3 seconds
- Symbols evaluated in batches
- 1-5 positions may open depending on market conditions
- PnL updates every 30-60 seconds

### Abnormal Behavior (DO NOT ignore)
- Toggle stays OFF (auto-disable bug)
- Positions show "simulated" indicator
- PnL stuck at $0.00
- API error messages in logs
- "effective_flag_off" block reason

## Performance Benchmarks

If test passes, you should see:
- 10 symbols: ~3-5 seconds to evaluate all
- Position opening latency: 1-2 seconds from signal
- PnL update frequency: Every 30-60 seconds
- Memory usage: Stable (no leaks)
- CPU usage: 20-40% during active trading

## Test Report

After completing the test, document:
1. Number of positions opened: ___
2. Symbols with open positions: ___________
3. Highest PnL: ___
4. Lowest PnL: ___
5. Toggle auto-disabled? Yes / No
6. Real positions on BingX? Yes / No
7. API errors encountered: ___________
8. Overall result: PASS / FAIL

## Next Steps After Passing

If the test passes:
1. Monitor live trading for 1 hour
2. Set up alerts for position limits
3. Configure risk management thresholds
4. Monitor PnL tracking accuracy
5. Deploy to production when confident

If the test fails:
1. Document the exact issue
2. Check logs for error messages
3. Verify all prerequisites are met
4. Contact support with error details

---

**Test Duration:** ~15-20 minutes
**Latest Update:** Live Trading Fix Applied
**Status:** Ready for Production Test
