# Stable calculation baseline — 2026-09-19

Marked by the operator as the stable, correct calculation configuration.
Use it as the reference for later coordination changes: re-run the simulation
on the SAME candles and compare against the numbers below. Any difference then
comes from the change under test, not from the data.

Git tag: `baseline-2026-09-19`

## Reproduce

```bash
gunzip -c docs/baseline/candles-2026-09-19-1m.json.gz > /tmp/baseline-candles.json
CTS_BASELINE_CANDLES=/tmp/baseline-candles.json \
  node --import tsx scripts/baseline/simulate-24h-portfolio.ts
```

The candle file is committed so the comparison never depends on a live fetch.

| Dataset field | Value |
|---|---|
| Source | BingX perpetual swap, 1-minute klines |
| Symbols in file / used | 29 / 22 |
| Candles per symbol | 1,440 (24 h) |
| Window | 1789846440000 – 1789932780000 (ms) |
| SHA-256 (uncompressed) | `727100eac2d32bcc55437eb604103bfa796f1455111ca4b5c804df322f832619` |

## Configuration

### Cost and geometry
| Parameter | Value | Note |
|---|---|---|
| Round-trip cost | 0.26 % | taker fee 0.10 % x 2 + slippage 0.06 % — `lib/trading-round-trip-cost.ts` |
| PositionCost | 0.10 % | SIZING setting only, never a cost |
| Take profit | 5 x PositionCost (0.50 %) | |
| Stop loss | 20 x PositionCost (2.00 %) | = 22.6 R on a full stop, cost included |
| Max hold | 240 min | |

### Stage chain
| Stage | What runs |
|---|---|
| Base | every indication config, validated on its own **last 50** positions, threshold **PF >= 1.1** |
| Main | **Axis** as a strategy (prev 6 / last 2 / cont 1 / pause 8), beside DCA — never a pre-filter |
| Real | **Block** on the Main output: counts 1 and 2, ratio 0.2, 3 increment steps |
| Live | venue replay, max **100** concurrent positions |

### Indication grid
| Parameter | Value |
|---|---|
| Window range | 5 – 48 (`MAX_INDICATION_WINDOW`), was 5 – 30 |
| drawdownRatio / lastPartRatio / factorMultiplier | 1 / 0.5 / 1 (inert in the replay — see below) |

### Block
| Parameter | Value |
|---|---|
| Sizing | recovery entries only; entries after a win run at base size |
| Additive ratio | 0.2 per valid count |
| Shared ratio | 0.8 uniform, once at least one Block is valid |
| Stack ceiling | 5 x base volume, on the final multiplier |
| Active | skips opening steps, bounded to steps - 1; default off |
| Hold | binds at the last step; default on |
| Lanes | overall + symbol + direction, additive and independent |

### Position sizing (simulation)
A full stop costs **0.30 %** of current balance: `unit = 0.003 x balance / 22.6`.
Without this normalisation one position risked 22.6 x its PositionCost, and
100 concurrent positions exceeded the whole account in a single bad hour.

## Results

| Stage | Trades | ProfitFactor |
|---|---|---|
| Base, raw | 670,846 | 0.6916 |
| Base, validated lanes | 47 | — |
| Main (Axis) | 17,151 | **1.1405** |
| Real (Block c1 + c2) | 34,302 | **1.1415** |

| Portfolio | Value |
|---|---|
| Balance | $10.00 -> $158.7330 |
| Max drawdown | 15.63 % |
| Positions taken / rejected by cap | 17,576 / 33,877 |
| Orders | 52,728 (entry + SL + TP) |
| Win rate | 95.2 % |
| ProfitFactor, R-normalised | **1.1373** |
| ProfitFactor, gross | 2.6607 |
| Positive hours | 18 / 24 (75 %) |
| Max open | 100 |

## How to read these numbers

- **The per-trade ProfitFactor is the comparable figure.** It is normalised per
  trade and independent of position size. Compare changes against 1.1373.
- **The return is a compounding artefact.** 17,576 trades in one day, each
  sized to the growing balance, grow exponentially from a small edge. It is
  not a forecast.
- **A $10 account cannot place these orders.** One R-unit starts near
  $0.0013; live positions are clamped to the venue minimum (~$6.15 observed),
  so the simulated sizes are far below what the exchange accepts.

## Known limitations of this baseline

- `drawdownRatio`, `lastPartRatio` and `factorMultiplier` produce bitwise
  identical results in the replay (`deriveConfigSignals`). Whether the
  production `calculateDirectionIndication` shares that insensitivity is
  **unverified** — if it does not, the replay is incomplete for those axes.
- The Base last-50 window has weak predictive power on this data: lanes
  validated at an average window PF of 1.184 carry 0.753 over their full
  stream. Axis, not the Base selection, carries the edge.
- The Real stage sorts candidates by ProfitFactor but applies no PF filter
  (`created == passed`). This baseline reproduces that behaviour.
- One 24-hour window. Results on other days will differ.
