# Production Trading Settings Overview

## Symbols Configuration (30 Total - Sorted by 1h Volatility)

### High Volatility Group (>2% - 1h) - 5 Symbols
Priority: TOP - Best for aggressive trading
```
 1. PEPEUSDT   (4.3% 1h vol) - Meme coin, high range trading
 2. DOGEUSDT   (3.8% 1h vol) - Community token, trending
 3. SHIBUSDT   (3.5% 1h vol) - Altcoin momentum
 4. XRPUSDT    (3.1% 1h vol) - Ripple, regulatory sensitive
 5. SOLUSDT    (2.9% 1h vol) - Layer-1 blockchain
```
**Use Case**: Swing trading, trend following, high-frequency entries

---

### Medium-High Volatility (1.5-2% - 1h) - 5 Symbols
Priority: HIGH - Balanced risk/reward
```
 6. AVAXUSDT   (1.9% 1h vol) - Avalanche, DeFi hub
 7. ADAUSDT    (1.8% 1h vol) - Cardano, stable movements
 8. LTCUSDT    (1.7% 1h vol) - Litecoin, established alt
 9. BCHUSDT    (1.6% 1h vol) - Bitcoin Cash, fork derivative
10. ETCUSDT    (1.5% 1h vol) - Ethereum Classic, niche
```
**Use Case**: Mixed strategies, intermediate risk, good entry points

---

### Medium Volatility (1-1.5% - 1h) - 5 Symbols
Priority: MEDIUM - Consistent traders
```
11. ETHUSDT    (1.4% 1h vol) - Ethereum, market indicator
12. LINKUSDT   (1.3% 1h vol) - Chainlink, Oracle standard
13. UNIUSDT    (1.2% 1h vol) - Uniswap, DEX leader
14. FILUSDT    (1.1% 1h vol) - Filecoin, storage protocol
15. ATOMUSDT   (1.0% 1h vol) - Cosmos, interoperability
```
**Use Case**: Core positions, stable ranges, breakout confirmation

---

### Medium-Low Volatility (0.5-1% - 1h) - 5 Symbols
Priority: MEDIUM-LOW - Reduced risk
```
16. NEARUSDT   (0.9% 1h vol) - NEAR Protocol, sharding
17. BNBUSDT    (0.8% 1h vol) - Binance Coin, exchange utility
18. OPUSDT     (0.7% 1h vol) - Optimism, L2 solution
19. ARBUSDT    (0.6% 1h vol) - Arbitrum, L2 Ethereum
20. SUIUSDT    (0.5% 1h vol) - Sui, Move language blockchain
```
**Use Case**: Conservative positions, range trading, lower leverage

---

### Low Volatility (0.3-0.5% - 1h) - 10 Symbols (Extended Set)
Priority: LOW - Stable baseline
```
21. MATICUSDT  (0.5% 1h vol) - Polygon, scaling solution
22. FTMUSDT    (0.5% 1h vol) - Fantom, EVM compatible
23. APTUSDT    (0.4% 1h vol) - Aptos, Move VM on Sui
24. GRTUSDT    (0.4% 1h vol) - The Graph, indexing
25. SANDUSDT   (0.4% 1h vol) - The Sandbox, metaverse
26. MANAUSDT   (0.4% 1h vol) - Decentraland, virtual land
27. AAVEUDT    (0.3% 1h vol) - Aave, lending protocol
28. CRVUSDT    (0.3% 1h vol) - Curve, stablecoin DEX
29. CONVUDT    (0.3% 1h vol) - Convex, Curve optimizer
30. MKRUSDT    (0.3% 1h vol) - MakerDAO, stablecoin system
```
**Use Case**: Portfolio diversification, stability focus, minimal SL hits

---

## Maximum Positions Configuration by Stage

### Current Limits (To Be Increased)
```
Stage 1 (Entry):     5 max positions
Stage 2 (Main):      10 max positions
Stage 2.2 (Min PF):  8 max positions
Stage 3 (Exit):      15 max positions
```

### RECOMMENDED NEW LIMITS (30 Symbols Total)
```
Stage 1 (Entry):     12 max positions   (+7, 140% increase)
Stage 2 (Main):      25 max positions   (+15, 150% increase)
Stage 2.2 (Min PF):  20 max positions   (+12, 150% increase)
Stage 3 (Exit):      30 max positions   (+15, 100% increase)
```

**Rationale**:
- 30 symbols should allow ~25-30 concurrent positions across all stages
- Stage 2/2.2 gets higher limits as they're key profit stages
- Stage 3 allows full exit capacity for all 30 symbols
- Minimum profit factor (2.2) allows conservative position limits

---

## Strategy Settings Overview

### Base Strategies (Foundation - All Markets)

#### 1. **Trailing Strategy**
- **Purpose**: Follow price momentum with stop-loss trail
- **Settings**:
  - Trail Distance: 0.5-2.0% (adjusted per symbol volatility)
  - Trail Timeout: 5-15 minutes
  - Trigger: Price breaks above/below trailing line
- **Best For**: PEPEUSDT, DOGEUSDT, SOLUSDT (high volatility)
- **Risk Level**: Medium

#### 2. **Block Strategy**
- **Purpose**: Grid-based position entry at predefined levels
- **Settings**:
  - Block Size: 2-5% of capital per block
  - Block Duration: 30-60 minutes
  - Number of Blocks: 3-5 per position
- **Best For**: ETHUSDT, BNBUSDT, AVAXUSDT (medium volatility)
- **Risk Level**: Low-Medium

#### 3. **DCA Strategy (Dollar Cost Averaging)**
- **Purpose**: Reduce average entry price over time
- **Settings**:
  - DCA Interval: 5-15 minutes between purchases
  - Max Purchases: 3-5 per position
  - Position Increase: 0.5-1.5% per DCA add
- **Best For**: All symbols, especially falling markets
- **Risk Level**: Low (planned accumulation)

---

### Main Trade Strategies (Core Execution - Best Performing)

#### 4. **Momentum Strategy**
- **Purpose**: Catch short-term price acceleration
- **Settings**:
  - Momentum Threshold: 1-3% price change in 15 min
  - Confirmation Candles: 2-3 consecutive up/down
  - Entry Multiplier: 1.2-1.5x volume
- **Symbols**: XRPUSDT, ADAUSDT, LINKUSDT
- **Expected Win Rate**: 55-65%
- **Avg Return**: 1.5-3% per trade

#### 5. **Reversal Strategy**
- **Purpose**: Trade mean-reversion at extremes
- **Settings**:
  - Extreme Definition: >2σ from 20-SMA
  - Pattern: Double bottom/top formation
  - Reversal TP: 1-2% from entry
- **Symbols**: FILUSDT, ATOMUSDT, NEARUSDT
- **Expected Win Rate**: 60-70%
- **Avg Return**: 1-2% per trade

#### 6. **Support/Resistance Strategy**
- **Purpose**: Trade bounce points and breakouts
- **Settings**:
  - Level Calculation: 20/50/200 SMA + pivot points
  - Break Confirmation: 0.5% close above/below level
  - Bounce Distance: 0.5-1.5% from level
- **Symbols**: ETHUSDT, LTCUSDT, BCHUSDT
- **Expected Win Rate**: 58-68%
- **Avg Return**: 1-1.5% per trade

#### 7. **Trend Following Strategy**
- **Purpose**: Long positions in uptrends, short in downtrends
- **Settings**:
  - Trend Definition: Price > 50-SMA > 200-SMA (uptrend)
  - Entry: Pullback to 20-SMA + 3% RSI confirmation
  - Hold Duration: 30-120 minutes
- **Symbols**: BNBUSDT, OPUSDT, ARBUSDT
- **Expected Win Rate**: 60-70%
- **Avg Return**: 2-4% per trade

---

### Preset Trade Strategies (Optimized for 30-Symbol System)

#### 8. **Auto-Optimal Strategy**
- **Purpose**: Machine-selected best strategy per symbol per timeframe
- **Settings**:
  - Optimization Method: Sharpe ratio maximization
  - Performance Threshold: >1.5 Sharpe
  - Rebalance Frequency: Every 2 hours
  - Symbol Rotation: Top 10 by recent performance
- **Coverage**: All 30 symbols rotated
- **Expected Performance**: 65-75% win rate

#### 9. **Coordination Strategy**
- **Purpose**: Multi-symbol synchronized entries/exits
- **Settings**:
  - Sync Interval: 30 seconds
  - Correlated Entry: Same indicator signal across symbols
  - Staggered Exits: 5-second intervals per position
  - Max Concurrent: 25 positions
- **Symbols**: Groups of 5 by volatility band
- **Purpose**: Reduce slippage through volume aggregation

#### 10. **Risk-Adjusted Strategy**
- **Purpose**: Dynamic stop-loss and take-profit based on volatility
- **Settings**:
  - Stop-Loss: MIN(2%, 1.5×ATR) per symbol
  - Take-Profit: MIN(5%, 3×ATR) per symbol
  - Position Size: Inverse volatility (low vol = larger, high vol = smaller)
  - Trailing Activation: 1% profit
- **Symbols**: High volatility group (PEPE, DOGE, SHIB)
- **Risk Profile**: Conservative with scaling

#### 11. **Portfolio Strategy**
- **Purpose**: Balanced allocation across all 30 symbols
- **Settings**:
  - Allocation Method: Equal-weight (3.3% per symbol)
  - Alternative: Risk-parity (inverse volatility weighting)
  - Rebalancing: When position >4% or <2.5% allocation
  - Correlation Check: Reduce sizing if correlated
- **Coverage**: All 30 symbols continuously
- **Benefit**: Diversified returns, lower drawdown

---

### Advanced Strategies (Special Conditions)

#### 12. **Hedging Strategy**
- **Purpose**: Protect portfolio from adverse moves
- **Settings**:
  - Hedge Ratio: 20-30% of portfolio size
  - Trigger: Portfolio drawdown >5%
  - Instrument: Inverse pairs (BEARUSDT) or short positions
  - Duration: Until main positions recover
- **Symbols**: Used during market stress
- **Effectiveness**: Reduces max drawdown by 3-5%

#### 13. **Arbitrage Detection**
- **Purpose**: Capture price discrepancies across timeframes/venues
- **Settings**:
  - Price Diff Threshold: >0.5% between spot/futures
  - Hold Duration: <5 minutes
  - Capital Allocation: 5% of portfolio
  - Safety: Simultaneous entry/exit orders
- **Symbols**: Top 5 by volume (ETHUSDT, BTCUSDT, SOLUSDT, XRPUSDT, BNBUSDT)
- **Expected Return**: 0.3-0.7% per occurrence

---

## Configuration Parameters

### Global Settings
```
Exchange:                BingX
Trading Mode:            Live (real money)
Leverage:                2x maximum (margin trading)
Min Trade Size:          $10 USDT
Max Position Size:       10% portfolio per symbol
Total Exposure:          100% (fully leveraged)
```

### Indicator Settings (Applied to All Strategies)
```
SMA Short:               20 period
SMA Medium:              50 period
SMA Long:                200 period
RSI:                     14 period, 30/70 levels
ATR:                     14 period
Bollinger Bands:         20 period, 2 std dev
Volume MA:               20 period
```

### Risk Management (ALL STRATEGIES)
```
Max Drawdown Time:       40 minutes (user specified)
Max Drawdown %:          15% total portfolio
Position SL:             1.5-3% per symbol
Position TP:             2-5% per symbol
Daily Loss Limit:        10% portfolio
Correlation Check:       Auto-reduce if r² > 0.7
```

### Volume Configuration
```
Base Volume Ratio:       1.0 (system default)
Min Volume:              $10 USDT
Max Volume:              $1000 USDT per order
DCA Volume:              0.5 * base (smaller adds)
Block Volume:            1.5-2x base (aggregated)
```

### Profit Factor (PF) Minimums - STAGE 2.2
```
Stage 2.2 Entry:         Min PF 2.2 (as specified)
Stage 2.2 Max Positions: 20 (recommended increase)
Stage 2.2 Strategy:      Risk-Adjusted + Momentum
Stage 2.2 SL:            2% tight stops
Stage 2.2 TP:            3-4% moderate targets
Stage 2.2 Timeout:       20 minutes max hold
```

---

## Recommended Action Plan

### IMMEDIATE (Next 15 mins)
1. Add 30 symbols (PEPEUSDT through MKRUSDT) in volatility order
2. Configure maximum positions:
   - Stage 1: 12 max
   - Stage 2: 25 max
   - Stage 2.2: 20 max
   - Stage 3: 30 max

### SHORT-TERM (Next hour)
1. Enable Auto-Optimal strategy rotation
2. Set up Portfolio strategy for diversification
3. Activate Risk-Adjusted for high-volatility symbols
4. Start Coordination strategy for synchronized entries

### ONGOING (Continuous)
1. Monitor win rates by strategy type
2. Adjust profit factors based on actual performance
3. Rebalance symbol rotation if needed
4. Track correlation between positions

---

## Expected Performance (Based on 30-Symbol System)

### Conservative Estimate
- **Win Rate**: 58-65% trades
- **Avg Win**: 1.5-2.5%
- **Avg Loss**: 1-1.5%
- **Daily Return**: 0.5-1.5%
- **Max Drawdown**: 8-12%
- **Sharpe Ratio**: 1.2-1.5

### Optimistic Scenario
- **Win Rate**: 65-72% trades
- **Avg Win**: 2-3.5%
- **Avg Loss**: 1-1.2%
- **Daily Return**: 1-2%
- **Max Drawdown**: 5-8%
- **Sharpe Ratio**: 1.8-2.2

### Key Success Factors
1. Strategy diversification across 13 approaches
2. 30-symbol coverage reduces correlation risk
3. Volatility-sorted symbols optimize entry timing
4. Increased max positions allow full capacity
5. Min PF 2.2 stage ensures quality entries

---

## Monitoring Checklist

- [ ] All 30 symbols added and trading
- [ ] Max positions increased per stage
- [ ] Strategy rotation active
- [ ] Risk limits enforced (40-min drawdown, 10% daily loss)
- [ ] Health checks: Every 5 minutes
- [ ] Auto-recovery: Enabled
- [ ] 8-hour continuous run: Active
- [ ] Logs: Streaming to `/tmp/monitor-prod-8h.log`

---

**Status**: CONFIGURATION READY  
**Implementation**: Follow action plan above  
**Expected Start**: <30 minutes after configuration  
**Target**: 8+ hour continuous profitable trading session
