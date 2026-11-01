# Offline 70-symbol engine soak — baseline: merged main 85afc16 + instrumentation 57475cb

Window 30 min; steady state from 2026-10-14T14:48:35.286Z (83 samples); verifier exit 1.

| Measure | Value |
|---|---|
| Realtime pass, sampled last pass (ms) | p50 21315 / p95 23444 / max 24688 |
| Realtime pass, recorded max (ms) | 31169 |
| Passes over 5000 ms | 84 (p50 21198 / p95 24314 / max 31167) |
| Realtime cycles / passes | 83 / – |
| Per-symbol pass time (ms) | p95 of pass p95 1434 / max 2006 |
| Phase split per pass, median (ms) | indication 17928 / pseudo 52 / strategy 24213 |
| Event-loop delay, process lifetime (ms) | p50 21.1 / p95 47.1 / p99 68.6 / max 432.3 |
| Simulated positions created / closed (counters) | – / – |
| Indication symbol errors | – |
| Liveness latency (ms) | p50 6 / p95 39 / p99 98 / max 378; >1 s 0% of 1486 |
| Slowest stats route per sample (ms) | p50 2935 / p95 3538 / max 3750 |
| RSS (MB) | 2055 → peak 2176 → 2147 |
| Heap used (MB) | 796.5 → peak 1569.6 → 1323.3 |
| Redis keys | 185352 → peak 185355 → 185352 |
| Redis used_memory (MB) | 178 → peak 264 → 264 |
| Set keys (total / per symbol min–median–max) | 2390 / 34–34–36 (70 symbols) |
| Paper positions open / closed | 0 / 0 |
| Audit issues / server alerts / sample failures | 0 / 0 / 0 |
