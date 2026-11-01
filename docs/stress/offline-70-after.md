# Offline 70-symbol engine soak — after: completed-minute Common + caches, synthetic 30 h Common backfill

Window 30 min; steady state from 2026-10-14T19:37:05.661Z (84 samples); verifier exit 1.

| Measure | Value |
|---|---|
| Realtime pass, sampled last pass (ms) | p50 15885 / p95 26587 / max 27982 |
| Realtime pass, recorded max (ms) | 31708 |
| Passes over 5000 ms | 92 (p50 21112 / p95 29760 / max 31706) |
| Realtime cycles / passes | 92 / – |
| Per-symbol pass time (ms) | p95 of pass p95 1442 / max 2232 |
| Phase split per pass, median (ms) | indication 7253 / pseudo 58 / strategy 23775 |
| Event-loop delay, process lifetime (ms) | p50 21.2 / p95 49.7 / p99 79.5 / max 574.1 |
| Simulated positions created / closed (counters) | – / – |
| Indication symbol errors | – |
| Liveness latency (ms) | p50 7 / p95 45 / p99 137 / max 384; >1 s 0% of 1488 |
| Slowest stats route per sample (ms) | p50 2811 / p95 3481 / max 4027 |
| RSS (MB) | 1691 → peak 1815 → 1784 |
| Heap used (MB) | 1137.9 → peak 1323.9 → 403.6 |
| Redis keys | 185422 → peak 185423 → 185423 |
| Redis used_memory (MB) | 191 → peak 287 → 287 |
| Set keys (total / per symbol min–median–max) | 2390 / 34–34–36 (70 symbols) |
| Paper positions open / closed | 0 / 0 |
| Audit issues / server alerts / sample failures | 0 / 0 / 0 |
