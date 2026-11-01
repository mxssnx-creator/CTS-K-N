# Offline 15-symbol engine soak

Window 3 min; steady state from 2026-11-01T22:54:48.874Z (13 samples); verifier exit 1.

| Measure | Value |
|---|---|
| Realtime pass, sampled last pass (ms) | p50 3654 / p95 3999 / max 3999 |
| Realtime pass, recorded max (ms) | 5081 |
| Passes over 5000 ms | 1 (p50 5079 / p95 5079 / max 5079) |
| Realtime cycles / passes | 48 / – |
| Per-symbol pass time (ms) | p95 of pass p95 1715 / max 1715 |
| Phase split per pass, median (ms) | indication 1135 / pseudo 5 / strategy 5831 |
| Event-loop delay, process lifetime (ms) | p50 20.5 / p95 33.6 / p99 45.2 / max 216.1 |
| Simulated positions created / closed (counters) | – / – |
| Indication symbol errors | – |
| Liveness latency (ms) | p50 null / p95 null / p99 null / max null; >1 s null% of 0 |
| Slowest stats route per sample (ms) | p50 1523 / p95 5436 / max 5436 |
| RSS (MB) | 0 → peak 0 → 0 |
| Heap used (MB) | 229.4 → peak 1023 → 447.2 |
| Redis keys | 327 → peak 195305 → 190940 |
| Redis used_memory (MB) | 3 → peak 156 → 100 |
| Set keys (total / per symbol min–median–max) | 520 / 34–34–36 (15 symbols) |
| Paper positions open / closed | 0 / 0 |
| Audit issues / server alerts / sample failures | 0 / 0 / 0 |
| Cross-route consistency issue kinds (samples affected) | 4 (11) |

Consistency issues:

- indications direction: stats=767 engine-stats=774..774 (outside the window)
- indications move: stats=870 engine-stats=878..878 (outside the window)
- indications optimal: stats=511 engine-stats=516..516 (outside the window)
- indications signal: stats=23470 engine-stats=23675..23675 (outside the window)
