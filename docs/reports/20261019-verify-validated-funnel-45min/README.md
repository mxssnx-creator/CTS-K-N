# Verification run: validated Base funnel, 24 h prehistoric + 45 min realtime

Run `obs-verify5` on 2026-10-19 (01:28–02:17 UTC), connection `bingx-x01`, paper mode, 12 symbols, public BingX 1-minute data, no orders. Built `.next-prod` from the validated-PF revision (`ea1f862` runtime code; later commits changed tests and docs only).

## What it shows

| Check | Result |
|---|---|
| Prehistoric 24 h × 12 symbols | 12/12 complete, 1,036,722 candles in the earlier stopped run; this run 878,354 candles, 1,320/1,320 config tasks, 0 failed |
| Coverage verifier | 0 errors, 0 warnings |
| Funnel invariant violations (`stage_funnel_invariant_violation`) | 0 in events and server log |
| Base evaluated / passed, final stats payload | 2,305 / 0 (all 2,305 failed the gate); last 5-second sample: 1,977 / 0 |
| Validated Base PF | 0 when no Set has passed; 1.18–1.34 in windows where 1–2 Sets passed |
| Processing and running (Base) at finish | 0 and 0 |
| Main, Real, Live evaluated at finish | 0; the two closed trades came from Sets that were valid when they opened |
| Signal forward measurement at finish | 82 open across 12 symbols; closes: 1 short (DOTUSDT), 0 long |
| Type measurement | `measured`; backfill used up to 72 h of older bars and added 36 closes; one bucket still thin (BNBUSDT active long) |
| Pre-gate historic PF (all measured closes) | 0.6325 over 4,008 closes, labelled as a pre-gate measurement |

## How the validated count moved

The validated Base count was 0 at the start, then 1–2 in windows around 01:33–01:39, 01:46–01:50, and 02:08–02:12 UTC, and 0 in between. The validated PF followed it: it showed a value only while a Set passed, and 0 otherwise. The gate is not stable over this window: Sets enter and leave validity every few minutes.

Two paper trades closed in the run, both DOTUSDT move long at the take-profit: +0.73 % and +0.43 %. They opened at 01:32 and 01:45 UTC, in windows where the validated count was 1–2. Two trades are not a measurement of edge.

## What it does not show

- No Signal result. Signal forward measurement needs stops and targets to be reached, and in 45 minutes only one of 82 open entries closed. A longer realtime window is needed before any Signal bucket can be judged.
- No edge claim. The gross PF of measured closes is about 0.93–1.01 per type and direction in development data, and the pre-gate historic PF here is 0.63. The validated PF of 1.18–1.34 rests on one or two Sets at a time.

## Defect found by this run

The harness summary (`summary.json`, `trades`) counted the simulated paper rows as trade results: 2 closed, 2 wins. The results book, which excludes simulated rows by definition, reports 0 executed and 0 closed for the same window. The harness now writes the two blocks separately: `simulatedTrades` (paper rows, not results) and `resultsBook` (executed, real, own positions only). This run's `summary.json` predates that change and keeps the old `trades` key.

## Files

Output directory in the session scratchpad: `obs-verify5` (`summary.json`, `coverage-final.json`, `stats-final.json`, `results-book-final.json`, `simulated-trades.json`, `samples.jsonl`, `events.jsonl`).
