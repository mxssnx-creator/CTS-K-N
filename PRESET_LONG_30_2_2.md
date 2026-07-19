# Production Configuration Preset: "long-30-2.2"

## Overview

**Label**: Long-Term 30 Symbols @ Min PF 2.2  
**Created**: 2026-07-19 13:21:06 UTC  
**Purpose**: Proven configuration for 8+ hour continuous production trading  
**Status**: Production Ready & Tested

This preset captures all settings for a long-term, high-capacity trading session with strict quality filters.

---

## Quick Reference

| Setting | Value |
|---------|-------|
| **Duration** | 8+ hours continuous |
| **Symbols** | 30 (1h volatility sorted) |
| **Min Profit Factor** | 2.2 |
| **Max Drawdown Time** | 40 minutes |
| **Max Positions** | 60 concurrent (Stage 3) |
| **Exchange** | BingX |
| **Live Trading** | ON |
| **Rate Limits** | 10 req/s, 600 req/min |

---

## Configuration Details

### Symbols (30 Total - Sorted by 1h Volatility)

**High Volatility Band (10)**  
BANKUSDT, AKEUSDT, ARIAUSDT, HOMEUSDT, HUSDT, ALLOUSDT, EVAAUSDT, BEATUSDT, KAITOUSDT, LDOUSDT

**Medium Volatility Band (10)**  
ONDOUSDT, ARBUSDT, PENDLEUSDT, APEUSDT, ORDIUSDT, ENSUSDT, AVAXUSDT, JUPUSDT, XPLUSDT, RUNEUSDT

**Low Volatility Band (10)**  
MAGAUSDT, CVXUSDT, GMXUSDT, PERPUSDT, RDNTUSDT, WLDUSDT, ZKUSDT, TAOUSDT, DYDXUSDT, AKITAUSDT

### Strategy Stages

| Stage | Direction | Max Pos | Total | Coverage | Purpose |
|-------|-----------|---------|-------|----------|---------|
| **1** | 12L + 12S | 12 | 24 | 40% | Entry from indications |
| **2** | 25L + 25S | 25 | 50 | 83% | Primary profit stage |
| **2.2** | 20L + 20S | 20 | 40 | 67% | Quality filter (PF≥2.2) |
| **3** | 30L + 30S | 30 | 60 | 100% | Full exit capacity |

### Global Parameters

- **Min Profit Factor (Stage 2.2)**: 2.2 (for every $1 loss, $2.20+ win)
- **Max Drawdown Time**: 40 minutes (hard stop)
- **Max Portfolio Drawdown**: 15%
- **Daily Loss Limit**: 10%
- **Min Win Rate**: >50%
- **Min Sharpe Ratio**: 1.0

### Risk Management

- Minimum Trade: $10 USDT
- Max Position per Symbol: 10% portfolio
- Total Exposure: 100% (fully deployed)
- Leverage: 2x maximum
- Stop Loss: 1.5-3% per symbol
- Take Profit: 2-5% per symbol

### Engine Configuration

- Phase: live_trading
- Cycle Interval: 200ms
- Cycles/Second: 5
- Cycles/Minute: 300
- Rate Limits: 10 req/s, 600 req/min (BingX defaults)
- Max Concurrent API: 5

### Monitoring

- Health Checks: Every 5 minutes
- Auto-Recovery: Enabled
- Restart Recovery: 30 seconds
- Error Suppression: Transient errors only

---

## Performance Targets

### Conservative Estimate
- Win Rate: 58-65%
- Avg Win: 1.5-2.5%
- Avg Loss: 1-1.5%
- Daily Return: 0.5-1.5%
- Max Drawdown: 8-12%
- Sharpe Ratio: 1.2-1.5

### Optimistic Scenario
- Win Rate: 65-72%
- Avg Win: 2-3.5%
- Avg Loss: 1-1.2%
- Daily Return: 1-2%
- Max Drawdown: 5-8%
- Sharpe Ratio: 1.8-2.2

---

## How to Restore This Configuration

### Step 1: Load the Preset File
```bash
cd /vercel/share/v0-project
cat configs/preset-long-30-2.2.json | jq
```

### Step 2: Apply Symbol Configuration
```bash
# Set symbol order to volatility_1h with 30 symbols
curl -X PUT http://localhost:3002/api/settings/connections/bingx-x01/settings \
  -H "Content-Type: application/json" \
  -d '{
    "settings": {
      "symbol_order": "volatility_1h",
      "symbol_count": 30
    }
  }'
```

### Step 3: Verify Strategy Stage Configuration
```bash
# Verify these constants are set in lib/constants.ts:
# - STAGE_1_MAX_LONG_POSITIONS = 12
# - STAGE_1_MAX_SHORT_POSITIONS = 12
# - STAGE_2_MAX_LONG_POSITIONS = 25
# - STAGE_2_MAX_SHORT_POSITIONS = 25
# - STAGE_2_2_MAX_LONG_POSITIONS = 20
# - STAGE_2_2_MAX_SHORT_POSITIONS = 20
# - STAGE_3_MAX_LONG_POSITIONS = 30
# - STAGE_3_MAX_SHORT_POSITIONS = 30
# - MIN_PROFIT_FACTOR = 2.2
# - MAX_DRAWDOWN_TIME_MINUTES = 40
```

### Step 4: Enable Live Trading
```bash
curl -X PUT http://localhost:3002/api/settings/connections/bingx-x01/settings \
  -H "Content-Type: application/json" \
  -d '{
    "settings": {
      "tradingEnabled": true,
      "controlOrdersEnabled": true,
      "liveTrading": true
    }
  }'
```

### Step 5: Start Monitoring
```bash
# Monitor the 8+ hour session
bash scripts/monitor-prod-8h.sh
```

### Step 6: Verify All Systems
```bash
# Check effective settings
curl http://localhost:3002/api/settings/connections/bingx-x01/settings

# Check engine status
curl http://localhost:3002/api/trade-engine/progression

# Verify symbols
curl "http://localhost:3002/api/settings/connections/bingx-x01/symbols?order=volatility_1h&count=30"
```

---

## Key Features of This Preset

✅ **Proven Stability**: Tested in 8+ hour continuous sessions  
✅ **High Capacity**: 30 symbols with 60 max concurrent positions  
✅ **Quality Focus**: Min PF 2.2 ensures only best positions trade  
✅ **Risk Controlled**: 40-min drawdown limit, 10% daily loss cap  
✅ **Exchange Defaults**: Uses BingX standard rate limits (10 req/s)  
✅ **Auto-Recovery**: Automatic restart on failure  
✅ **Comprehensive Monitoring**: Health checks every 5 minutes  

---

## When to Use

**Use "long-30-2.2" when you want to:**
- Run extended trading sessions (8+ hours)
- Trade 30 high-quality symbols simultaneously
- Enforce strict profit factor requirements (≥2.2)
- Maximize position capacity (50-60 concurrent)
- Have automatic recovery and monitoring
- Use proven settings from production

**Do NOT use this preset if you:**
- Want to run short sessions (<1 hour)
- Need fewer symbols (<15)
- Can tolerate lower quality positions (PF <2.0)
- Want manual-only monitoring
- Need custom rate limiting

---

## Customization Options

If you want to modify this preset:

| Parameter | How to Adjust |
|-----------|---------------|
| Symbols | Change `sortOrder` or `count` |
| Max Positions | Edit stage constants in `lib/constants.ts` |
| Min PF | Adjust `MIN_PROFIT_FACTOR` constant |
| Max Drawdown | Modify `MAX_DRAWDOWN_TIME_MINUTES` constant |
| Duration | Adjust monitoring scripts |
| Risk Limits | Update `MAX_PORTFOLIO_DRAWDOWN_PCT` etc. |

---

## File Locations

- **Configuration JSON**: `configs/preset-long-30-2.2.json`
- **This Guide**: `PRESET_LONG_30_2_2.md`
- **Stage Config**: `STRATEGY_STAGES_CONFIG.md`
- **Constants**: `lib/constants.ts`
- **Monitoring Script**: `scripts/monitor-prod-8h.sh`

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-07-19 | Initial preset creation |

---

## Support & Notes

This is a production-ready preset. Use the JSON configuration file to quickly restore settings for future runs. All parameters are type-safe and persist across server restarts.

**Last Updated**: 2026-07-19 13:21:06 UTC

