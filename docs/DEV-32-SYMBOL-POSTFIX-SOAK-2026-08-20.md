# CTS-K-N 32-symbol post-fix development soak — 2026-08-20

## Decision

**FAIL.** The run was stable and productive, remained strictly in paper mode,
and stayed below the 7,168/8,192/10,240 MiB protection boundaries. It did not
meet the unchanged development API contract: steady-state p95 was **3,714 ms**
against a maximum of **3,000 ms**. This result is not an acceptance pass and
the latency limit was not weakened.

## Source and recovery provenance

The expected persistent source and runtime directories were absent when this
continuation started. GitHub `main` was independently queried and proved newer
than the last recorded 2026-08-15 checkpoint:

| Item | Identity |
| --- | --- |
| Last recorded checkpoint | `605ddba` |
| Current GitHub `main` before validation | `1851c00db71e485d474289f259a060b440fe32bc` |
| Current Git tree | `6c8e93570c0ad52ec5d8645f34a51d589430ad8a` |
| Difference | GitHub `main` is 33 commits ahead |
| Restored source | `/workspace/CTS-K-N-v3.7` |
| Restored runtime | `/workspace/CTS-K-N-runtime` |
| Validation branch | `agent/postfix-soak-validation-20260820` |

The local pre-run HEAD and tree matched GitHub exactly. No older backup was
overlaid onto the newer repository.

## Execution safety and isolation

- Entrypoint: `/workspace/CTS-K-N-runtime/run-dev-soak-32.sh`
- Raw log: `/workspace/CTS-K-N-runtime/logs/dev-soak-32-2026-08-20T05-37-29Z.log`
- Runtime mode: development paper/simulation (`FORCE_SIMULATED=1`,
  `FORCE_LIVE=0`, credentials blank)
- Symbols: 32
- Configured observation: 1,200,000 ms plus bounded productive-completion grace
- Redis: locally built official Redis 8.10.1, loopback-only port 6382, isolated
  DB13, verified empty before start
- No automatic `FLUSHDB` was used. Aborted setup diagnostics in DB12 were
  preserved; DB13 contained 115,659 persistent keys after shutdown.
- The engine repeatedly reported `live_trade=false`, skipped private exchange
  synchronization, and maintained zero real positions. Real/authenticated
  orders observed: **0**.

## Fixed acceptance boundaries

| Boundary | Required | Observed / decision |
| --- | ---: | --- |
| Dev RSS soft | 6,400 MiB | Exceeded; final internal sample 6,778 MiB |
| RSS emergency | 7,168 MiB | Not reached |
| RSS hard | 8,192 MiB | Not reached |
| Absolute process memory | 10,240 MiB | Not reached |
| Steady API p95 | <= 3,000 ms | **FAIL: 3,714 ms** |
| Real/authenticated orders | 0 | Pass: 0 |

The verifier completed all database, heap, absolute-RSS, engine-productivity,
paper-lifecycle, restart/toggle, and safety assertions before stopping at the
API-p95 assertion.

## Runtime measurements

| Metric | Start / early | Final / peak |
| --- | ---: | ---: |
| Verifier rounds | 1 | 530 |
| Outer process-tree RSS | 4,223,256 KiB | peak 6,846,672 KiB (6,686.2 MiB) |
| Internal runtime RSS | 4,329 MiB | 6,778 MiB |
| Heap used | 2,358.8 MiB early | 3,637.7 MiB final |
| Heap total | 2,613.8 MiB early | 4,680.8 MiB final |
| External / array buffers | 1,469.6 / 1,459.1 MiB | 1,023.0 / 997.2 MiB |
| Strategy memory throttles | 0 | 18 |
| Strategy elevated GCs | 0 | 2 |
| Strategy GC wait | 0 ms | 7,378 ms |
| Strategy RSS peak | n/a | 6,754.6 MiB |
| Maintenance GC | none | 2 observed, last 2,347 ms |
| Event-loop utilization | 84.0% | 95.4% |
| Event-loop delay p50 | 20.6 ms | 22.6 ms |
| Event-loop delay p95 | 48.6 ms | 133.1 ms |
| Event-loop delay max | 217.4 ms | 5,763 ms |
| Redis keys sampled | 25,114 | 110,885 |
| Redis DB13 after shutdown | n/a | 115,659 |

The strategy guard stayed below emergency pressure, but the host concurrency
profile was `critical` at the end for the combined reasons
`process_rss_critical`, `event_loop_utilization_critical`, and
`event_loop_delay_high`. Its CPU/calculation lanes were already reduced to one
and I/O to four.

## Productive engine and signal evidence

| Counter | Final observation |
| --- | ---: |
| Main / indication / strategy cycles | 35 / 35 / 35 |
| Realtime monitor cycles | 1,202 |
| Live-position cycles | 1,233 |
| Signal indications | 1,202 |
| Signal paper positions | 73 |
| Signal trailing positions | 36 |
| Simulated positions visible in server lifecycle | at least 88 |
| Engine services | Trade, Indication, Strategy and WebSocket all running |

The run exercised all 32 symbols and remained productive despite the control
plane becoming unhealthy under saturation. One engine-state transport request
was retried and recovered without resetting soak state.

## API latency failure

| Route | Route p95 |
| --- | ---: |
| `/api/system/init-status` | 6,888 ms |
| `/api/system/monitoring` | 6,745 ms |
| `/api/trading/trade-history?connection_id=bingx-x01&limit=500` | 4,574 ms |
| `/api/preset-optimizer?connectionId=bingx-x01` | 4,432 ms |
| Overall steady state | **3,714 ms** |

Compared with the 2026-08-15 pre-fix measurement (4,456 ms), overall p95
improved by 742 ms (16.7%), event-loop p95 improved from about 181.5 to
133.1 ms, and maximum loop delay improved from about 8,074 to 5,763 ms. The
improvement is real but insufficient for acceptance.

The post-fix evidence also disproves the earlier assumption that 6,400 MiB
would sit safely above the real 32-symbol plateau. Internal RSS reached
6,778 MiB, while the concurrency classifier marks RSS critical beginning at
95% of the soft limit (6,080 MiB). Raising the soft limit again would leave too
little margin to the unchanged 7,168 MiB emergency boundary and is therefore
not accepted as a latency fix. The remaining work is CPU/event-loop and
control-plane latency reduction, not relaxation of the 3,000 ms contract.

## Test and repository gates

An unrelated but reproducible test-process defect was found during the final
contract: importing immutable engine timing defaults kicked off Redis
initialization after Jest teardown. Runtime behavior is unchanged; module-load
refresh is now suppressed only when `NODE_ENV=test`, while Redis-aware tests
may still invoke the exported refresher explicitly.

| Gate | Result |
| --- | --- |
| Focused concurrency/timing suite | 1/1 suite, 7/7 tests, exit 0 |
| Canonical Jest contract | 183/183 suites, 1,221/1,221 tests, exit 0 |
| TypeScript | Pass (`tsc --noEmit`) |
| ESLint | Pass, zero errors |
| Deployment source syntax | Pass |
| Recreation manifests | Pass; 1,423 project files, 295 routes / 379 methods, 47 UI pages, 399 environment variables, 98 Redis migrations, 214 tests/verifiers |
| Credential scan | Pass; 1,431 files, zero findings |
| Soak acceptance | **FAIL**, API p95 3,714 ms > 3,000 ms |

## Configuration decision

- Keep dev soft/emergency/hard/absolute boundaries at
  **6,400/7,168/8,192/10,240 MiB**.
- Keep API p95 acceptance at **3,000 ms**.
- Keep all live/authenticated order paths disabled for this validation.
- Do not activate any DCA or Special historical candidate rejected in the
  2026-08-15 report; this runtime soak does not alter their economic verdicts.
- Treat the 32-symbol development runtime as **not accepted** until a later
  unchanged-gate rerun reaches <=3,000 ms.
