# Last-N lanes: three one-day studies on 12 symbols, 2026-11-27

## Setup

Three separate studies. Each has one UTC prehistory day as warm-up and one UTC trading day, on 12 BingX perpetuals (BTC, SOL, BCH, XRP, ETH, BNB, DOGE, ADA, AVAX, LINK, DOT, ATOM), with 1-minute candles, all contiguous (2,880 bars per symbol per study). The days are 11-21/22, 11-23/24 and 11-25/26. Each study ran the full sweep: 108 entry plans × 4 Last-N grids = 416 lanes. Costs are 0.15 % round trip (base) and 0.26 % (stress). The lane table is in `reports/last-n-lanes-3-days/lanes.md`. The study inputs are in the same folder.

Harness change: `scripts/regression/last-n-stage-market-replay.ts` now accepts a study whose final boundary equals the selection end, so one trading day with one prehistory day runs. The previous check required three strictly increasing boundaries.

## Results

- Lanes evaluated: 416 per day, 1,248 in total.
- Lanes that pass Base on at least one day: 33.
- Lanes net-positive on every one of the three days: **0**.
- Best raw population after cost, pooled over three days and with no gate at all: 108 plans, best PF 1.043, **0 plans at PF ≥ 1.10**.
- Base passes per day are single digits (0–11 positions per lane), too few to support any PF estimate.

## What this means

The stage gates are not rejecting a profitable population. Before any gate, the entry plans have no after-cost edge in these three days. A gate can only select past winners, and the selected lanes lose on the following day (for example momentum-5 tp0.6 slr1: PF 0.20, 0.30, 0.07 on the three days). So no change to stage thresholds or PF floors will produce a positive, repeatable result from these entries. Tuning a threshold to one day would be overfitting.

## Open issue found by code reading (not yet measured)

`scripts/regression/last-n-stage-market-replay.ts` `bookClose` records a closed trade only under the exact ancestors of its final chosen path. A trade that passes Base but fails Main is recorded only under the direction key, not under the Base lane. A downstream lane's parent tape is therefore built from trades that already passed that lane, which biases the downstream gate toward its own survivors. This would inflate post-Base PF, so fixing it should lower measured post-Base PF, not raise it. It needs a separate change and its own check, and was not changed in this work.
