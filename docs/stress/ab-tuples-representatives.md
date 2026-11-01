# Offline 70-symbol engine soak — ab representatives

Window 10 min; steady state from 2026-10-19T15:27:58.819Z (16 samples); verifier exit 1.

| Measure | Value |
|---|---|
| Realtime pass, sampled last pass (ms) | p50 8165 / p95 8434 / max 8434 |
| Realtime pass, recorded max (ms) | 30741 |
| Passes over 5000 ms | 33 (p50 8433 / p95 30517 / max 30739) |
| Realtime cycles / passes | 33 / – |
| Per-symbol pass time (ms) | p95 of pass p95 662 / max 1208 |
| Phase split per pass, median (ms) | indication 4428 / pseudo 10 / strategy 11417 |
| Event-loop delay, process lifetime (ms) | p50 20.7 / p95 45.4 / p99 65.6 / max 310.6 |
| Simulated positions created / closed (counters) | – / – |
| Indication symbol errors | – |
| Liveness latency (ms) | p50 6 / p95 38 / p99 60 / max 120; >1 s 0% of 283 |
| Slowest stats route per sample (ms) | p50 2884 / p95 3501 / max 3501 |
| RSS (MB) | 1662 → peak 1686 → 1666 |
| Heap used (MB) | 521 → peak 1086.2 → 436.1 |
| Redis keys | 185421 → peak 185423 → 185422 |
| Redis used_memory (MB) | 186 → peak 202 → 200 |
| Set keys (total / per symbol min–median–max) | 2390 / 34–34–36 (70 symbols) |
| Paper positions open / closed | 0 / 0 |
| Audit issues / server alerts / sample failures | 0 / 0 / 0 |
| Cross-route consistency issue kinds (samples affected) | 7 (33) |

Consistency issues:

- indications direction: stats=2346 engine-stats=2328..2328 (outside the window)
- indications move: stats=2418 engine-stats=2401..2401 (outside the window)
- indications active: stats=537 engine-stats=533..533 (outside the window)
- indications optimal: stats=1688 engine-stats=1676..1676 (outside the window)
- indications signal: stats=38854 engine-stats=38240..38240 (outside the window)
- indications trend: stats=1551 engine-stats=1533..1533 (outside the window)
- indications auto: stats=72 engine-stats=71..71 (outside the window)
