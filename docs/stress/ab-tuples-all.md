# Offline 70-symbol engine soak — ab all

Window 10 min; steady state from 2026-10-19T15:42:52.485Z (16 samples); verifier exit 1.

| Measure | Value |
|---|---|
| Realtime pass, sampled last pass (ms) | p50 27076 / p95 29681 / max 29681 |
| Realtime pass, recorded max (ms) | 30804 |
| Passes over 5000 ms | 34 (p50 27075 / p95 29679 / max 30799) |
| Realtime cycles / passes | 34 / – |
| Per-symbol pass time (ms) | p95 of pass p95 1344 / max 1446 |
| Phase split per pass, median (ms) | indication 9324 / pseudo 67 / strategy 43840 |
| Event-loop delay, process lifetime (ms) | p50 20.7 / p95 44.3 / p99 62.1 / max 297.3 |
| Simulated positions created / closed (counters) | – / – |
| Indication symbol errors | – |
| Liveness latency (ms) | p50 6 / p95 34 / p99 62 / max 216; >1 s 0% of 284 |
| Slowest stats route per sample (ms) | p50 2428 / p95 3086 / max 3086 |
| RSS (MB) | 1619 → peak 1642 → 1615 |
| Heap used (MB) | 892.3 → peak 1054.5 → 985.5 |
| Redis keys | 185421 → peak 185423 → 185422 |
| Redis used_memory (MB) | 184 → peak 207 → 207 |
| Set keys (total / per symbol min–median–max) | 2390 / 34–34–36 (70 symbols) |
| Paper positions open / closed | 0 / 0 |
| Audit issues / server alerts / sample failures | 0 / 0 / 0 |
| Cross-route consistency issue kinds (samples affected) | 7 (31) |

Consistency issues:

- indications direction: stats=2452 engine-stats=2450..2450 (outside the window)
- indications move: stats=2639 engine-stats=2637..2637 (outside the window)
- indications active: stats=279 engine-stats=277..277 (outside the window)
- indications optimal: stats=1798 engine-stats=1797..1797 (outside the window)
- indications signal: stats=40698 engine-stats=40630..40630 (outside the window)
- indications trend: stats=1073 engine-stats=1070..1070 (outside the window)
- indications auto: stats=75 engine-stats=74..74 (outside the window)
