# CTS-K-N X02 Prod-VST · one-hour live continuity and result audit

Generated: 2026-08-27T00:38:16.404Z
Observed production: ec3be8359f9caf9d85956492ff7ed3d94f0b0bea
Observer scope: read-only; the engine remained live-enabled, but the observer itself submitted no order.

## Decision

**No configuration is qualified for Mainnet from this hour.** No new X02 entry was created in the observation window, the deployed Direct worker exhibited a reproducible progress/error-accounting defect during its historical projection, current internal aggregate PF is below 1.0 in every indication/strategy group, and the exchange ledger is not fully settled. The release candidate repairs continuity and reporting; it does not create or guarantee profitability.

## One-hour continuity

| Metric | Result |
|---|---:|
| Samples / median interval | 241 / 15.0 s |
| Health HTTP 200 | 241 / 241 |
| Direct processor healthy | 196 / 241 |
| Heartbeat / progress healthy | 240 / 196 samples |
| Progress age p95 / max | 47993 / 63791 ms |
| Lifecycle counter resets / positive cycle delta | 20 / 5,816 |
| Reported errors-last-5m max / final | 210 / 84 |
| Direct open / closed maximum | 7 / 18 |

Root cause: the deployed worker synchronously waited on an already leased historical projection, retried HTTP 409 at tick speed, counted each expected conflict as an error, and returned before persisting lifecycle progress. The repaired worker runs one historical publisher asynchronously, uses lease-aware backoff, keeps position management/progress active, and decays the five-minute error window.

Release review also found that a follow-up Main coordinator candidate physically dispatched every qualified Set in one symbol cycle. That behavior was rejected before deployment: all Sets remain fully calculated and published, while exchange/paper side effects are limited to four per symbol/cycle with a family-interleaved Redis cursor. Deferred Sets resume on later cycles instead of being dropped, and the hard ceiling cannot be raised through runtime environment configuration.

## API latency

| Endpoint | Requests | Failures | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|
| direct | 241 | 0 | 29.600 | 604.900 | 764.400 | 881.800 |
| overview | 241 | 0 | 92.700 | 682.400 | 801.800 | 975.000 |
| system | 241 | 0 | 96.600 | 683.000 | 832.800 | 987.100 |
| ledger | 61 | 0 | 108.700 | 691.500 | 950.200 | 950.200 |

## Resource envelope

| Metric | min | p95 | max/end |
|---|---:|---:|---:|
| App RSS MB | 843.6 | 2553.2 | 2659.3 |
| Heap MB | 324.0 | 1322.0 | 1686.0 |
| Redis requests/s | — | 4110 | 6509 |
| Redis keys | 135,247 | — | 136,030 |
| Event-loop delay p95 / utilization | — | 25.9 ms | 71.4% |

## Exchange-real ledger

The first/last rows below are the exact one-hour observer boundary. The detailed group snapshot that follows was captured at 2026-08-27T00:38:16.098Z and is explicitly a post-window validation, not silently folded into the hour.

| One-hour boundary | returned | executed | open | closed | settled | pending | net USDT | classic PF |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Start | 1,010 | 725 | 5 | 719 | 90 | 629 | -2.15000000 | 0.73876063 |
| End | 1,008 | 725 | 3 | 721 | 90 | 631 | -2.15000000 | 0.73876063 |
| Delta | -2 | +0 | -2 | +2 | +0 | +2 | +0.00000000 | — |

### Detailed post-window snapshot

| Metric | Value |
|---|---:|
| Rows / executed-real | 1,008 / 725 |
| New entries / closes in observation | 0 / 2 |
| Open / closed | 3 / 736 |
| Settled / accounting pending | 92 / 644 |
| W / L / BE | 28 / 59 / 5 |
| Settled net PnL | -2.15000000 USDT |
| Classic realized PF | 0.73876063 |
| PF coordinate | — |
| PositionCost coverage | 2 / 92 settled rows |
| Mean / median / p95 hold | 100.4 / 35.0 / 297.7 min |
| Holds in requested 20–60 min band | 22 / 92 |

The PF coordinate is emitted only when every settled row has a positive exchange notional and PositionCost denominator. Otherwise it is shown as unavailable. Accounting-pending rows never enter W/L/BE, PnL, PF or holding-time calculations.

### Exchange windows by close timestamp

| Window | closed | settled / pending | W/L/BE | net USDT | classic PF | mean hold min |
|---|---:|---:|---:|---:|---:|---:|
| 4h | 82 | 1 / 81 | 0/1/0 | -0.06000000 | 0.00000000 | 0.1 |
| 12h | 160 | 6 / 154 | 0/4/2 | -0.17000000 | 0.00000000 | 374.5 |
| 48h | 363 | 14 / 349 | 2/10/2 | -0.48000000 | 0.07692308 | 223.5 |

### Exchange results by indication

| Indication | total | open | settled / pending | W/L/BE | net USDT | classic PF | PF coordinate | avg hold min |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| signal | 579 | 2 | 42 / 364 | 12/27/3 | -2.39000000 | 0.616987 | — | 132.6 |
| move | 192 | 0 | 28 / 148 | 9/17/2 | -0.04000000 | 0.936508 | — | 58.5 |
| common | 172 | 0 | 13 / 89 | 3/10/0 | -0.08000000 | 0.923810 | — | 32.6 |
| trend | 32 | 1 | 5 / 20 | 3/2/0 | +0.29000000 | 4.222222 | — | 303.4 |
| optimal | 19 | 0 | 1 / 14 | 1/0/0 | +0.29000000 | — | — | 29.2 |
| direction | 11 | 0 | 3 / 6 | 0/3/0 | -0.22000000 | 0.000000 | — | 19.7 |
| auto | 3 | 0 | 0 / 3 | 0/0/0 | +0.00000000 | — | — | — |

### Exchange results by engine and direction

| Dimension | Name | settled / pending | W/L/BE | net USDT | classic PF | avg hold min |
|---|---|---:|---:|---:|---:|---:|
| Engine | signal | 42 / 364 | 12/27/3 | -2.39000000 | 0.616987 | 132.6 |
| Engine | main | 50 / 280 | 16/32/2 | +0.24000000 | 1.120603 | 73.4 |
| Direction | long | 47 / 340 | 24/21/2 | +3.75000000 | 3.586207 | 78.0 |
| Direction | short | 45 / 304 | 4/38/3 | -5.90000000 | 0.129794 | 123.8 |

### Exchange results by Set/engine lane

| Dimension | Name | total | settled / pending | net USDT | classic PF | PF coordinate |
|---|---|---:|---:|---:|---:|---:|
| Set variant | trailing | 695 | 77 / 486 | -0.77000000 | 0.887262 | — |
| Set variant | block | 313 | 15 / 158 | -1.38000000 | 0.014286 | — |
| Execution lane | signal_trailing | 579 | 42 / 364 | -2.39000000 | 0.616987 | — |
| Execution lane | default | 429 | 50 / 280 | +0.24000000 | 1.120603 | — |

### Exchange Block/TP step evidence

| Dimension | Step | total | settled / pending | net USDT | classic PF | qualification |
|---|---:|---:|---:|---:|---:|---|
| Block count | unknown | 692 | 77 / 486 | -0.77000000 | 0.887262 | not qualified |
| Block count | 1 | 260 | 15 / 130 | -1.38000000 | 0.014286 | not qualified |
| Block count | 5 | 40 | 0 / 28 | +0.00000000 | — | not qualified |
| Block count | 9 | 13 | 0 / 0 | +0.00000000 | — | not qualified |
| Block count | none | 3 | 0 / 0 | +0.00000000 | — | not qualified |
| Derived TP/PositionCost | unavailable | 997 | 92 / 635 | -2.15000000 | 0.738761 | not qualified |
| Derived TP/PositionCost | 15 | 10 | 0 / 9 | +0.00000000 | — | not qualified |
| Derived TP/PositionCost | 10 | 1 | 0 / 0 | +0.00000000 | — | not qualified |

Derived TP ratios are accepted only when the entry/TP price pair is in the same price domain and maps to an expected PositionCost ratio. Legacy mismatched pairs are quarantined as unavailable instead of producing extreme fictitious step values.

## Direct Trade · simultaneous historic calculation

Observed deployed settings: 32 symbols, all four entry indication types enabled, TP ratios 5–10× PositionCost, deployed Set-creation step 5. The release candidate changes the minimum/default step to 3; this observation therefore remains a step-5 production baseline.

| Indication | evaluated | valid | valid rate | aggregate PF | total simulated PnL |
|---|---:|---:|---:|---:|---:|
| breakout | 240,128 | 375 | 0.1562% | 0.57824970 | -155659.1485 |
| mean_reversion | 240,128 | 0 | 0.0000% | 0.63656721 | -754.8828 |
| momentum | 240,128 | 491 | 0.2045% | 0.55774678 | -200039.9595 |
| relative | 240,128 | 505 | 0.2103% | 0.55325778 | -283674.0093 |

| Strategy | evaluated | valid | aggregate PF | total simulated PnL |
|---|---:|---:|---:|---:|
| combination | 301,056 | 131 | 0.51177320 | -216751.9780 |
| dca | 14,336 | 12 | 0.64548170 | -17376.1132 |
| high_protection | 57,344 | 12 | 0.53804088 | -46498.3470 |
| inverse | 286,720 | 1,085 | 0.66082787 | -142749.5839 |
| standard | 43,008 | 16 | 0.52984555 | -31845.0191 |
| trailing_auto | 129,024 | 48 | 0.51521535 | -91802.7125 |
| trailing_fixed | 129,024 | 67 | 0.50173379 | -93104.2464 |

### TP PositionCost steps

| TP ratio | evaluated | valid | aggregate PF | total simulated PnL |
|---:|---:|---:|---:|---:|
| 5 | 480,256 | 304 | 0.43749370 | -358227.6256 |
| 10 | 480,256 | 1,067 | 0.65689589 | -281900.3745 |

Complete SL and Block count rows, including counts 1–12 and the requested minimum count 3, are in step-results.csv. A higher step or block count is not called profitable unless its aggregate net result, classic PF, PF coordinate, sample count and drawdown all qualify together.

## Main Trade snapshot

| Metric | Value |
|---|---:|
| Main indication trackings / evaluated / active / progressing Sets | — / — / — / — |
| Base Sets total / valid | 0 / 0 |
| Main Sets valid / overall | 0 / 0 |
| Real Sets valid / active | 0 / 0 |
| Live Sets total / executable / active | 0 / 0 / 0 |
| Main live executed / settled / pending | 14 / 0 / 0 |

Rows are Sets: Overall coordinates all Sets; Stage Real uses its valid Set population. The X02 connection row itself remained disabled for Main exchange entry in this observation, so no new Main entry is attributed to this hour. Direct state is independent and remained live-enabled.

## Accounting definitions

- Classic PF = gross settled profit / absolute gross settled loss.
- PF coordinate = 1 + 0.1 × (sum settled net PnL / sum PositionCost); 1.00 neutral, 1.10 means +1× PositionCost.
- Open and accounting-pending rows are excluded from realized PnL/PF.
- Historic/simulated aggregate PF is never relabeled as exchange PF.
- Missing denominator or sample is shown as unavailable; no PF is invented.

## Release-candidate verification

| Gate | Result |
|---|---:|
| Unit | 231 / 231 suites; 1,503 / 1,503 tests |
| Integration | 4 / 4 suites; 61 / 61 tests |
| TypeScript / ESLint | pass / pass |
| Production build | 42 / 42 static pages; 348 / 348 complete traces |
| Kilo preflight | 37 / 37 checks; schema v103 |
| Linux install preflight | pass; mutation-free |
| Secret scan | 1,537 files; 0 findings |

The release candidate also fixes a transient Next build race: a missing production BUILD_ID is retryable only after successful compilation reached page-data collection, while source/type failures remain fail-closed. The UI renders an unavailable marker rather than `+0.0000 USDT` when an indication has no settled live close. Release and remote commits are recorded in the final deployment handoff after GitHub review and atomic installation.
