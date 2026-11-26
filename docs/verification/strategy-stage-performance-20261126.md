# Strategy stage performance, 2026-11-26

The comparison starts at CTS-K-N commit `f267df097ea7eb4afd2095db245b1aa5bf61e188` on PR #584. Already blocked strategy passes skip the indication snapshot read. An admitted pass computes the indication fingerprint once and submits it to coordination. Changes to stage-relevant fields, exact ledger counters or settings invalidate reuse. Base, Main and Real reuse requires a completed compact Live snapshot. Oversized or interrupted snapshots rerun the full flow, and eligible cached flows continue Live reconciliation.

Position context refreshes share one pending read across symbols and retain the latest eight eligible closes while counting all eligible closes. Redis reads use the necessary fields and bounded native commands. Empty candidate lists skip history lookups. Small candidate lists check membership against the validated history index, with exhaustive legacy behavior when the index cannot establish completeness. Main renews the TTL of identical fingerprint caches and replaces changed snapshots.

## Native Redis comparison

Both revisions used fresh Redis 7.2.10 instances and the same seed. The fixture had 32 symbol prefixes, 50,000 exact Set keys, 4,000 position close-index rows and 24 extra metadata fields per close. Each timed workload ran eight times after a warm read. The snapshots, selected history keys and position-context counts matched.

| Workload | Before median | After median | Before response | After response | Before sampled heap rise | After sampled heap rise |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Closed counts for 8,000 Set keys | 128.61 ms | 45.59 ms | 2.91 MB | 0.47 MB | 77.6 MB | 46.0 MB |
| History membership for 64 candidates | 267.06 ms | 1.94 ms | 31.59 MB | 0.01 MB | 57.6 MB | 2.0 MB |
| Position context | 252.65 ms | 125.67 ms | 115.28 MB | 2.53 MB | 107.5 MB | 47.7 MB |

Response bytes cover eight reads. The Set count benchmark issued 192,000 individual hash reads before and 128 packed hash reads after. Position context still performs one command per close, with smaller replies and a bounded result accumulator. Heap rise is the largest sampled increase above the process heap at the start of a workload. Redis persistence was disabled in the disposable instances, so production disk consumption and long-term retention remain unmeasured.

## Production-build paper runs

Both 16-symbol runs used 180 seconds, one hour of synthetic prehistory, the measured-history Base gate, loopback Redis and identical simulation settings. Neither reached steady state. Liveness and cross-route accounting checks showed no failures. Both verifiers stopped at the paper-order lifecycle gate with zero orders and fills. The separate 70-symbol paper fixture tested the order lifecycle, including TP, SL, maximum hold and manual closes, and reconciled all 140 positions exactly once.

| Observed measure | Before | After |
| --- | ---: | ---: |
| Realtime cycles | 24 | 46 |
| Sampled realtime pass p95 | 13.02 s | 4.83 s |
| Median strategy phase per pass | 11.27 s | 6.09 s |
| Liveness p95 | 90 ms | 45 ms |
| Peak process RSS | 1,546 MB | 1,593 MB |
| End heap sample | 337.3 MB | 747.6 MB |
| End Redis memory | 110 MB | 111 MB |
| Set inventory | 554 | 554 |
| Paper positions opened | 0 | 0 |

This is a short synthetic comparison. Higher realtime throughput also coincided with more heap usage at the final sample. Long-run memory behavior requires a steadier comparison with qualified orders.

## Market replay

The trailing replay re-read the same 783,360 BingX perpetual candles covering 32 symbols. It used November 9–11 UTC for warm-up, November 12–18 for selection and November 19–25 for validation. All 4,406 configuration rows were identical to the preceding run in both selection and validation, including realized exits and drawdown. PF uses 0.15% base and 0.26% stress round-trip cost. TON, MKR and PEPE remain outside the sample because their candle requests failed.

| Seven-day validation | Closed positions | Net PF | Stress PF | Marked drawdown |
| --- | ---: | ---: | ---: | ---: |
| Fixed trailing | 2,125 | 0.8351 | 0.7257 | 3.17% |
| Dynamic trailing | 2,121 | 0.8331 | 0.7238 | 3.20% |
| Previous fixed trailing | 3,794 | 0.7666 | 0.6390 | 6.34% |
| Previous dynamic trailing | 3,773 | 0.7646 | 0.6377 | 6.37% |
| Matched fixed bracket | 2,053 | 0.8417 | 0.7324 | 2.98% |

The DCA run reproduced all 15,552 records byte-for-byte for BCH, XRP and SOL. It covered 5, 15 and 30-minute intervals, four entry rules, one to four adds, alternate volume and distance ladders, four targets and three final stop multipliers. At 0.15% baseline cost and 0.225% stress, no configuration qualified for promotion. The leading stress-PF diagnostics after selection reached 0.678, 0.831 and 0.747 on the later window with respective adverse drawdown bounds of 18.12, 19.19 and 19.92 percentage points of initial notional.

The repeat checks parity, and its dates overlap the previous study completely. It covers modeled trailing and DCA fills. Independent market profitability of Axis, Block and Relate, sustained multi-day production latency, and current x02 execution parity remain unverified. The x02 connectivity check timed out before authenticated preflight. Earlier virtual-funds evidence is recorded in [the trailing continuation report](trailing-continuation-20261126.md).

## Reproduction

Use the locked dependencies and the frozen input with SHA-256 `42c4b2fe91aac82948fe6b909e107d22ec2a4267743f781643bbac7b7b29d6d9`.

```bash
node --import tsx scripts/regression/trailing-walkforward.ts \
  bingx-trailing-20261109-17d-32.json 42c4b2fe91aac82948fe6b909e107d22ec2a4267743f781643bbac7b7b29d6d9 \
  trailing-replay --expanded-entry-plans --fresh-from 2026-11-22 --compare-selection selection-configs.json
node --import tsx scripts/research-dca-matrix.ts dca-frozen
node --require ./scripts/test-network-isolation.cjs scripts/run-native-redis-coordination.mjs
```

The selection JSON passed to `--compare-selection` is from the older 24-symbol study. The later 32-symbol selection and validation digests are `627cfa6613ffcb77d1f23c3d2c48293b67812d9be3c4bc4f6e917a60669d26f4` and `4bff78d96d7a733c97ef10536680046ba6210f6b488a704be02d376c20dd5d54`. The DCA directory contains the frozen plan and candle input.

## Verification coverage

TypeScript and the production build with 356 verified traces passed. The isolated Jest run covered 3,833 tests in 570 suites. It passed 3,832 tests on the first full pass. The remaining assertion expected the old in-flight guard syntax and passed after updating it and rerunning both throttle and stage-reuse suites. The native Redis verifier passed its 12 batch commands and four outcome scenarios. The first concurrent production build was killed with exit 137. The lower-heap retry succeeded. All simulation and regression runners used isolated Redis and no exchange credentials.
