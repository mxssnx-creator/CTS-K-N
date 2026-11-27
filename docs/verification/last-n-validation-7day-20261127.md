# Last-N lanes: independent attribution and validated sets, 2026-11-27

## Change

`scripts/regression/last-n-stage-market-replay.ts` previously recorded each closed trade only under the ancestors of one chosen path. Lanes that qualified for the same trade but were not chosen never received its outcome, so their histories depended on which sibling won. The replay now records each trade once under every lane that qualified for it, at the deepest stage reached. The position itself is still one per trade, taken on the best-ranked path. Lanes are therefore independent in their own histories, and the physical position is unchanged.

## Study

12 BingX perpetuals, 1-minute candles, contiguous. One prehistory day (2026-11-18), three development days (11-19 to 11-21), three validation days (11-22 to 11-24). All 416 plan × grid lanes. Base cost 0.15 % round trip.

Full lane table: `reports/last-n-validation-7day/lanes.md`.

## Result

- Lanes: 416. Development positions across all lanes: 3,585.
- Lanes with at least 30 development positions: 39. Lanes with at least 30 validation positions: 72.
- **Validated lanes: 0.**
- The strongest development lanes do not survive. For example momentum-15 tp1.2 slr1.5 has development PF 4.57 on 19 positions and validation PF 0.53 on 51 positions. momentum-30 tp1.2 slr1 has development PF 3.89 and validation PF 0.13.

## Why one day cannot validate

Across 12 symbols, one trading day yields about 100 positions in total, spread over 416 lanes. The qualification rule requires 30 development positions per lane, so a one-day study cannot validate any lane regardless of PF. Validation needs several days per window.

## What is still open

The three-day raw-edge result still holds: no entry plan reaches PF 1.10 after cost on the pooled days (see `last-n-lanes-3-days-20261127.md`). Gate tuning cannot create validated lanes from these entries. Positive validated sets need entry signals with an out-of-sample edge.
