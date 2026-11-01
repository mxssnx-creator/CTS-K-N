# Offline 15-symbol engine soak

Window 2 min; whole-run; steady state not reached; steady state from not reached (10 samples); verifier exit 1.

| Measure | Value |
|---|---|
| Realtime pass, sampled last pass (ms) | p50 3627 / p95 3801 / max 3801 |
| Realtime pass, recorded max (ms) | 3934 |
| Passes over 5000 ms | 0 (p50 – / p95 – / max –) |
| Realtime cycles / passes | 35 / – |
| Per-symbol pass time (ms) | p95 of pass p95 1116 / max 1116 |
| Phase split per pass, median (ms) | indication 1230 / pseudo 3 / strategy 5719 |
| Event-loop delay, process lifetime (ms) | p50 20.4 / p95 32.3 / p99 44.1 / max 198.3 |
| Simulated positions created / closed (counters) | – / – |
| Indication symbol errors | – |
| Liveness latency (ms) | p50 5 / p95 25 / p99 612 / max 1227; >1 s 0.6% of 168 |
| Slowest stats route per sample (ms) | p50 1422 / p95 5186 / max 5186 |
| RSS (MB) | 388.5 → peak 1473.6 → 1467.6 |
| Heap used (MB) | 253.4 → peak 940.8 → 717.6 |
| Redis keys | 330 → peak 194832 → 190949 |
| Redis used_memory (MB) | 3 → peak 152 → 101 |
| Set keys (total / per symbol min–median–max) | 520 / 34–34–36 (15 symbols) |
| Paper positions open / closed | 0 / 0 |
| Audit issues / server alerts / sample failures | 0 / 0 / 0 |
| Cross-route consistency issue kinds (samples affected) | 0 (0) |
