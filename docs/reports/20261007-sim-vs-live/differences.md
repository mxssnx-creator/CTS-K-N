# Simulation vs. live processing — differences (2026-10-07)

Request: "Is Live run PF and Processings fixed? High PF like earlier simulation
and correct results? … check differences from simulation and Live processings
and Engine". The operator chose "Abweichungen prüfen": compare the paths, fix
real divergences, report PF per path, do not loosen gates.

## Paths

- **A — per-type measurement:**
  - `lib/trade-engine/prehistoric-type-replay.ts` and `type-measurement.ts`.
  - Real 1 m bars, entry at the decision bar's close.
  - Exits on bar high/low; a bar touching both levels counts as a stop.
  - Cost: PositionCost charged once.
- **B — pseudo / paper positions:**
  - `lib/trade-engine/pseudo-position-manager.ts` and the realtime processor.
  - These rows feed the Base gate's buckets.
- **C — live:**
  - `lib/trade-engine/stages/live-stage.ts` for exchange orders, plus `simulated` live rows.

## Why the earlier simulation showed a high PF

1. **Synthetic prices.** Earlier runs used `OBS_MARKET_DATA=synthetic` / `FORCE_SIMULATED=1` generated prices, not market data.
2. **Coin-flip closes in the Base buckets.** `enforceSimBoundedLifecycle` closed the oldest open pseudo positions with a deterministic coin flip.
   - The win probability rose with the Set's own PF: `0.45 + (PF−1)·0.3`, up to 80 %.
   - Those fabricated outcomes were booked into the buckets the Base gate reads.
   - Nothing restricted this to a simulation: it also ran for paper on real data and for live connections.
3. **Look-ahead in the historic Common Sets.** Their indicators were computed on the 64 *future* bars of the forward grading window.

None of these is a market result. Measured on 14 real days, the entries have no positive edge after costs (see `../20261007-short-range-14d/report.html`).

## Differences and their status

| # | Item | A | B | C | PF effect | Status |
|---|---|---|---|---|---|---|
| 1 | `enforceSimBoundedLifecycle` | – | coin-flip closes on every connection; supplied TP/SL price ignored (closed at the stored mark) | – | fabricated, PF-weighted wins in the Base buckets | **Fixed:** runs only under `isForcedSimulation()`; `closePosition(…, exitPrice)` books the decided level |
| 2 | Bucket `pnl` unit | percent | USDT | sim: gross USDT; real: net USDT | classic PF, drawdown ratio, Previous/Last inputs mixed units; simulated live rows won or lost on the gross move | **Fixed:** outcome, PF and drawdown use the signed net percent every writer supplies (`pos-history.ts`); empty legacy fields are not read as 0 % |
| 3 | Trend adaptive TP | ignored | ladder factor (a PositionCost multiple) used as a percent: factor 6 = 6 % target instead of 0.6 % | ignored | B's trend rows rarely reached TP | **Fixed:** `deriveAdaptiveTrendProtection` converts factor × PositionCost into the PF coordinate, so all clamps and the SL floor apply; used by B, C (dispatch) and A |
| 4 | Common indicators in historic mode | – | computed on the forward grading window (look-ahead); realtime used flat synthetic candles | – | historic Common Sets graded on the future | **Fixed:** `getHistoryCandles` — causal OHLC up to the decision point, last 90 minutes, in both modes |
| 5 | Forward grading, bar touching both levels | stop | TP first | stop first | optimistic historic outcomes | **Fixed:** stop first |
| 6 | SL rejected by the venue | – | – | entry rolled back; reconcile retried the same price every tick | lost entries, request storms | **Fixed:** allowed SL range (`lib/protection-allowed-range.ts`), one re-place, 15/30/60 s backoff |
| 7 | Venue minimum quantity | – | – | never applied (key mismatch); 101400 correction written to an unread key | rejected or oversized orders | **Fixed:** `43e81b6` |
| 8 | Cost per round trip | 0.10 % (PositionCost) | 0.10 % | real: venue fees + spread + slippage (≈0.26 % noted in `live-stage.ts`) | A/B about 0.16 % per trade more optimistic than live | **Open (reported):** the research report shows every row at 0.10 / 0.15 / 0.20 / 0.26 % |
| 9 | Decision timestamp in historic indications (`engine-manager.ts`, `asOfMs` = bar open) | close time | – | – | rows stamped one bar early; grading starts after the bar, so outcomes are unaffected | **Open, minor:** stamping only |
| 10 | Exit trigger | bar high/low | last tick, TP checked first | mark price (BingX), last price (Bybit) | B slightly optimistic on fast bars | By design (tick vs. bar), recorded |
| 11 | Trailing | none in the measurement | tick ratchet | ratchet price | the measurement understates trailing variants | Research covers trailing (`lib/short-range-exits.ts`) |
| 12 | Max hold | 4 h, bar close | 4 h from `opened_at` | 4 h from order `createdAt`; Special 90 min | small | By design |
| 13 | SL derivation | PF-derived, size 1 | PF-derived; signal-dynamic trailing ≥ 0.8 % | × size multiplier, Block buffer, tuned PF | C stops wider | Partly by design (variants) |

## PF per path on real data

| Path | Window | Result |
|---|---|---|
| A: measurement (control run) | 24 h, 4 symbols | 612 closes; every type × direction net negative (PositionCost ratio 0.39–0.95) |
| Research, same rules plus 648 exit configurations | 14 days, 15 symbols | best original row PF 1.15 gross, 0.93 at 0.10 % cost; 0 candidates |
| B / C paper | — | Base admits no Set on these results, so there are no paper or live trades: the correct outcome of the gate |

## Range classes (Micro, Minimum, Short, General, Long)

All five classes are measured in the research report (TP distance in PositionCost multiples: < 2, 2–3, 3–6, 6–12, > 12):
- None is positive at 0.10 % cost for the original signals.
- The shortest ranges (Micro, Minimum) are the worst after costs: the cost is a larger share of a small target.
- `lib/short-range-grid.ts` is still not wired into the live stages. With no validated configuration there is nothing to activate.
