# Offline 70-symbol engine soak — verify: canonical stats + consistency audit, Base measured-history gate opened offline

Window 30 min; steady state from 2026-10-14T20:31:59.470Z (54 samples); verifier exit 0.

| Measure | Value |
|---|---|
| Realtime pass, sampled last pass (ms) | p50 565397 / p95 598543 / max 598543 |
| Realtime pass, recorded max (ms) | 598543 |
| Passes over 5000 ms | 4 (p50 567211 / p95 598542 / max 598542) |
| Realtime cycles / passes | 3 / – |
| Per-symbol pass time (ms) | p95 of pass p95 33807 / max 69109 |
| Phase split per pass, median (ms) | indication 11197 / pseudo 219 / strategy 1113204 |
| Event-loop delay, process lifetime (ms) | p50 20.1 / p95 35.6 / p99 80.3 / max 845.2 |
| Simulated positions created / closed (counters) | 254 / 75 |
| Indication symbol errors | – |
| Liveness latency (ms) | p50 5 / p95 70 / p99 197 / max 484; >1 s 0% of 925 |
| Slowest stats route per sample (ms) | p50 2159 / p95 3361 / max 3823 |
| RSS (MB) | 1747 → peak 1851 → 1842 |
| Heap used (MB) | 597.4 → peak 798.2 → 691.4 |
| Redis keys | 189798 → peak 196930 → 196923 |
| Redis used_memory (MB) | 224 → peak 270 → 270 |
| Set keys (total / per symbol min–median–max) | 2390 / 34–34–36 (70 symbols) |
| Paper positions open / closed | 179 / 75 |
| Audit issues / server alerts / sample failures | 0 / 0 / 0 |
| Cross-route consistency issue kinds (samples affected) | 7 (25) |

Consistency issues:

- indications direction: stats=224 engine-stats=228
- indications move: stats=239 engine-stats=243
- indications optimal: stats=148 engine-stats=149
- indications trend: stats=123 engine-stats=124
- dataIntegrity: strategyDetail.real.positionStats.hedge.netEntries=-2 is negative
- indications active: stats=33 engine-stats=34
- indications auto: stats=0 engine-stats=1
