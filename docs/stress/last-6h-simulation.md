# Last 6 h trade simulation (6 h pre-calc, 6 h trading)

Run: 2026-10-19 00:42 UTC snapshot. Pre-calc 2026-10-18 12:42 → 18:42 UTC (not booked); trading 18:42 → 00:42 UTC.
Market: BingX public 1 m klines, no keys. 12 liquid symbols (BTC, ETH, SOL, XRP, BCH, DOGE, ADA, LINK, AVAX, LTC, TRX, DOT); 2,579 bars each, no gaps.
Money: start 1,000 USDT; each base entry stakes 10 USDT (1 %). Equity marks open positions to the minute close, gross of exit fees.

## What is modelled

- Entries: the engine's direct-indication rows with the engine's own protection, replayed on the real bars.
- Base gate: `BACKTEST_BASE_GATE` (5 measured closes, window 25, stage PF 1.10). The pre-calc closes are the measured history; pre-calc trades are never booked.
- Exits: market execution through the shared short-range exit rules, with fees and slippage.
- Families over the admitted stream: normal, Axis (`deriveAxisTrades`), Block (`deriveBlockTrades`), DCA (`runDcaBacktest`, momentum entry, default DCA profile, TP 5 × and SL 20 × PositionCost).
- Not modelled offline: Main, Real and Live. The funnel shows them as the Base-valid count, so they are not measured stages.

## Results (trading window)

| Family | Positions | Closed | Win % | Net USD | PF | End equity | Max equity DD % |
|---|---:|---:|---:|---:|---:|---:|---:|
| Normal | 235 | 235 | 56.2 | −3.33 | 0.575 | 996.67 | 0.74 |
| Axis | 108 | 108 | 94.4 | +3.00 | 7.581 | 1,003.00 | 0.07 |
| Block | 235 | 235 | 56.2 | −14.21 | 0.262 | 985.79 | 1.82 |
| DCA | 127 | 127 | 57.5 | −19.36 | 0.157 | 980.64 | 1.94 |

Funnel: pre-calc 1,338 candidates, 164 admitted but not booked. Trading 1,502 candidates, 235 admitted (Base-valid, executed at market).
Hourly net USD (normal): +1.83, −2.64, −2.58, −0.48, +1.25, −0.70. Full hourly ledger: `scripts/simulate-last-6h.ts` output (JSON and the interactive HTML report).

## Limits

- One 6-hour sample on 12 symbols. These numbers are not statistically meaningful and are not a validation.
- Axis's PF of 7.6 comes from 108 trades with 6 losses. Treat it as a sample artifact until a longer window confirms it.
- The Block and DCA results reflect their own volume and entry models, not the indication rows.
- Main, Real and Live are not modelled, so the funnel cannot show their losses.
