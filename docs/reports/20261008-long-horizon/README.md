# Long-horizon lab, development window (2026-10-08)

The question: do entries on hourly bars, held for hours to days, have an edge large enough to pay the real round trip? The engine's short-hold entries do not (`scripts/pf-attribution.ts`: gross PF 0.93–1.01 for every type × direction).

## Setup

- **Data:** BingX public hourly bars for 50 symbols. Development runs from the first available bar (2025-10-19) to 2026-06-30.
- **Holdout:** 2026-07-01 to 2026-09-30, **not viewed**. It is evaluated only for rows the development selection picks.
- **Entries:** decided on a closed bar, filled at the next bar's open. Four families:
  - time-series momentum: 24 h, 72 h, 168 h;
  - Donchian breakout: 20, 55, 120;
  - EMA cross: 12/48, 24/96, 50/200;
  - 4 h Wilder-RSI reversion: 25/75, 20/80.
- **Sides:** both, long-only, short-only.
- **Exits:** stop at 2 or 3 ATR; target at 3 or 6 ATR, or a 3 ATR trailing stop; maximum hold 48 h or 168 h. A bar touching both levels counts as a stop.
- **Costs:**
  - base: 0.26 % round trip plus 0.03 % per day held (funding, conservative);
  - stress: 0.39 % plus 0.06 % per day.
- **Selection rule** (fixed in advance): at least 300 trades; PF > 1 under base and stress costs; base PF > 1 in both development halves; ranked by drawdown.

## Result: 0 of 396 configurations qualify. The holdout stays unused.

- **No row has PF > 1 in both halves.**
- **Short-only trend following looks strong over the whole window, but it is a regime effect.** Examples:
  - 168 h momentum short: PF 1.44 base, 1.34 stress.
  - EMA 50/200 short: PF 1.32.
  - Halves: about 1.6–2.2 in the first half (the Oct 2025 – Feb 2026 downtrend), 0.75–0.98 in the second.
- **Long-only and both-sides rows are below 1 after costs.** The best both-sides gross PF is about 1.1, PF 0.94 after costs.

Conclusion: no entry family tested here has a stable edge after costs on this data. Nothing is integrated into the engine, and no defaults change. `summary.json` holds every row: trades, gross PF, PF at base and stress cost, net, drawdown and halves.
