# Trade window simulation (multi-day, prehistory, 30 symbols)

Simulation only. Public BingX 1-minute klines, no keys, no orders, no engine state written.
Generalizes `docs/stress/last-6h-simulation.md` (the 6 h / 6 h case, `scripts/simulate-last-6h.ts`).

## Run

```bash
# 5 trading days, 3 prehistory days, 30 engine symbols, 4-hour buckets (defaults)
SIM_OUT_DIR=reports/trade-window node --import tsx scripts/simulate-trade-window.ts
node scripts/render-trade-window-report.mjs reports/trade-window

# 6 h / 6 h, 1 h buckets
SIM_OUT_DIR=reports/last-6h node scripts/simulate-last-6h.ts
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `SIM_TRADE_DAYS` / `SIM_TRADE_HOURS` | 5 days / off | Trading window; hours overrides days |
| `SIM_PREHIST_DAYS` / `SIM_PREHIST_HOURS` | 3 days / off | Prehistory (not booked; feeds the Base gate and indicators) |
| `SIM_BUCKET_HOURS` | 4 (1 in hours mode) | Bucket size; must divide the trading window |
| `SIM_SYMBOLS` | 30 engine symbols (`BTC-USDT` … `RUNE-USDT`) | Symbol list, engine order |
| `SIM_END` | last completed UTC midnight (hours mode: last minute) | Window end |
| `SIM_WORKERS` | 4 | Worker processes; symbols are split across them |
| `SIM_PAGE_CONCURRENCY` | 1 | Kline pages in flight per symbol |
| `SIM_REQUEST_INTERVAL_MS` | 400 | Spacing between requests per process (shared public limit) |

Output in `SIM_OUT_DIR`: `trade-window-simulation.json` (everything), `trade-window-series.json`
(per-minute equity for every family), then `trade-window-report.md` and `trade-window-report.html`
from the renderer.

## What is replayed

- **Entries**: the engine's own direct-indication rows (`replayDirectIndicationTypes`) on the real
  1-minute bars, with the engine's protection (take-profit and stop-loss from the Set's profit factor),
  one open position per type × direction × rule.
- **Indications**: every flag in the engine's indication set is forced on (`directionEnabled`,
  `moveEnabled`, `activeEnabled`, `optimalEnabled`, `autoEnabled`, `trendEnabled`,
  `trendCombinedEnabled`) and the whole common-indicator catalogue is evaluated as the engine does.
  The report lists each enabled type and whether it produced an admitted entry.
- **Base gate**: `applyBaseGate` with `BACKTEST_BASE_GATE` (5 measured closes, window 25, stage PF
  1.10, PositionCost-relative). The prehistory closes are the measured history; prehistory trades are
  never booked. `lib/trade-simulation/gate-explain.ts` classifies every trading-window candidate as
  admitted, *history short* (fewer than 5 measured closes before it) or *PF below stage*; its admitted
  total is checked against the gate and the report says whether they match.
- **Families over the admitted stream**:
  - `normal`: one position per admitted entry.
  - `axis`: `deriveAxisTrades` (Position-Count admission from the own outcome sequence).
  - `block`: `deriveBlockTrades` (volume multiplier per Block count).
  - `trailing`: `replayTrailing` walks each admitted entry forward on its own candles with a trailing stop.
    Defaults from the Historic Test: stop 2 % (20 × PositionCost), take-profit 0.5 % (5 × PositionCost),
    trailing distance 0.4 %, start ratio 0.3.
  - `dca`: `runDcaBacktest` for each entry model (momentum, mean reversion, breakout, relative) with
    `DEFAULT_DCA_PROFILE`, accumulation on, 15-minute timeframe, TP 5 × and SL 20 × PositionCost.
- **Money**: start balance 1000 USDT, 10 USDT per base entry (1 %). Block scales the stake by its
  multiplier, DCA by its exposure ratio. Equity is marked to the minute close, gross of exit fees.
  Round-trip cost is the shared `roundTripCostPercent` (taker fees both sides plus slippage).

## What is not modelled

- Main, Real and Live stages (the funnel reports their Base-valid count only).
- Capital, margin and concurrency limits. Positions are not capped by balance, so DCA exposure can
  exceed the account; the report shows peak open positions and peak gross exposure beside the equity.
- Signal-provider indications (external feeds) and manual or live-only settings.
- Partial fills, intrabar path beyond the one-minute bars, funding, latency.

## Performance

| Stage | Before | Now |
| --- | --- | --- |
| Ledger (4 000 positions, 5 days, 120 hourly buckets) | 13.2 s (per-minute scan, O(n²) running peak per bucket) | 116 ms (one-off benchmark on identical inputs, not committed) |
| Kline fetch | sequential pages; the first burst hit BingX `100410` and every symbol failed | 400 ms paced requests per process, retry with backoff on `100410`, 429, 5xx and network errors |
| Symbols | one process, one symbol at a time | 4 worker processes |

The remaining cost is the engine's own per-decision work: the Common grid is evaluated for every
one-minute decision (about 3 ms per bar on this 4-core container, roughly 45–60 s per symbol for 8 days).
Every symbol processes all 13,379 bars with no gaps in the reported run.

## Limits

- One sample on public candles. These numbers are not a validation of live profitability.
- Admission is by design strict: a coordinate with negative measured closes after real cost cannot be
  admitted. A zero-admission coordinate is therefore a gate result, not a missing computation.
- `AGENTS.md` sets 14 completed UTC days as the standing historic-test length. This run covers
  5 trading days plus 3 prehistory days, as requested for this study.

## Result of the reported run

Run on 2026-11-27 (UTC): trading 2026-11-22 00:00 → 2026-11-27 00:00, prehistory 2026-11-19 00:00 → 2026-11-22 00:00,
30 symbols, all 30 complete (13,379 bars each, no gaps), 4-hour buckets. Gate explanation matches `applyBaseGate`.
Report: `reports/trade-window-5d-3d-30sym/trade-window-report.html` (and `.md`, with one line per bucket and family).
Raw numbers: `reports/trade-window-5d-3d-30sym/trade-window-simulation.json`.

| Family | Positions | Win % | Net USD | PF | End equity | Max equity DD % | Peak open | Peak exposure USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Normal | 3,450 | 44.4 | −79.57 | 0.444 | 920.43 | 7.98 | 73 | 730 |
| Axis | 901 | 87.0 | +23.03 | 3.624 | 1,023.03 | 0.11 | 43 | 430 |
| Block | 3,450 | 44.4 | −247.13 | 0.240 | 752.87 | 24.72 | 73 | 1,806 |
| Trailing | 3,450 | 53.1 | −77.17 | 0.454 | 922.83 | 7.75 | 84 | 840 |
| DCA | 17,328 | 56.9 | −3,944.00 | 0.208 | −2,944.00 | 394.4 | 110 | 4,090 |

- Funnel: prehistory 74,816 candidates (4,125 admitted, not booked); trading 97,385 candidates, 3,450 admitted (3.5 %).
- Every enabled indication type produced admitted entries (`active` 652, `auto` 112, `direction` 71, `move` 834,
  `optimal` 191, `trend` 1,590). Two of 26 coordinates admitted nothing: `direction|long|multi_range` and
  `direction|short|multi_range`. Both reached PF 1.94 on their rows, but their measured closes stayed below the
  1.10 stage after real round-trip cost, so the gate rejects them (reason counts are in the report).
- DCA has no capital or concurrency limit in the simulation: 17,328 positions on a 1,000 USDT account drive equity
  below zero. That is a property of the simulated exposure, not an account result. It is shown, not capped.
- One sample on public candles over five days. Not a validation; no configuration is promoted by this run.
