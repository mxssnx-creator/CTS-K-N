# CTS-K-N validation results — 2026-08-14

## Outcome

The current checkpoint passed the complete local acceptance suite, a 15-minute
32-symbol development Paper/Demo soak, two independent 5-minute 32-symbol
production Paper/Demo soaks with shared persistent Redis, maximum-grid Direct
Trade calculations in development and production, physical restart recovery,
production UI coordination, and Linux installation preflight.

No authenticated BingX VST credential pair was available in this workspace.
Consequently, this checkpoint submitted **zero exchange orders** and the
`open-api-vst.bingx.pro` preflight correctly failed closed. All reported order
and position lifecycles are explicitly simulated/Paper lifecycles. These tests
validate correctness and stability; they do not establish future profitability.

## Code areas corrected in this checkpoint

- Historic indication batching, bounded historic checkpoints, and continuous
  Historic → Realtime handoff.
- Base/Main/Real/Live accounting, exact Set lineage, position-count grouping,
  lower-volume-ratio accumulation, Block coordination, and Long/Short identity.
- Direct Trade default minimum historical PF `4`, recent-position PF `25`,
  bounded history extension from `48h` to `90h`, and independent capacities of
  `300` total, `12` per symbol, and `6` per symbol/direction. The 30-second
  two-attempt guard staggers bursts; it is deliberately not an hourly cap.
- Direct Trade maximum-grid statistics now runtime-project only declared fields
  and use a normalized v2 row/index representation. This removes the nested
  Block-ledger duplication that caused `RangeError: Invalid string length`.
- Inline Redis snapshots retain Direct runtime state, settings, processor
  ownership, and positions while omitting deterministic, rebuildable historical
  grid caches. Snapshot flush waiting is bounded to prevent shutdown hangs.
- Shared Redis pending outcomes use atomic batching; generated soak databases
  were flushed and AOF/RDB were compacted after validation.
- Production readiness supports an explicit fresh init-status read and guards
  the SWR revision so a stale in-flight response cannot overwrite recovery
  state.
- Numeric Special settings with exact values `0` and `1` remain numbers rather
  than being decoded as legacy Redis booleans; import failures name mismatched
  fields.
- Direct-Trade development snapshots use collision-free filenames and exact
  cleanup, preventing stale multi-GB grids after PID reuse.
- BingX VST `.com` remains the default; `.pro` is available only by explicit
  configuration and remains fail closed without credentials.
- Serialized SWR route reads, bounded high-memory strategy concurrency, event
  coordination, UI hot reload, and production restart contracts were exercised
  together.

## Static acceptance

| Check | Result |
|---|---:|
| Jest | 173/173 suites, 1,171/1,171 tests |
| TypeScript | PASS (`tsc --noEmit`) |
| ESLint | PASS |
| Source syntax regression scan | PASS |
| Production build | PASS, Next.js 15.5.18 |
| Static pages | 42 |
| Complete build trace files | 340 |
| Linux installer preflight | PASS, Linux 6.18.35 x86_64, apt |
| Production UI surfaces | 47 |
| Real exchange orders | 0 |

The build emitted one non-blocking warning: the Next.js ESLint plugin is not
declared in the custom ESLint configuration.

## 15-minute development Paper/Demo soak

| Metric | Value |
|---|---:|
| Duration | 910,213 ms |
| Symbols / rounds / API requests | 32 / 390 / 4,796 |
| Historic completion | 32/32, 115,168 candles, 32 cycles |
| Realtime handoff | 5 cycles / 5 frames |
| Engine cycles | 16 → 791 |
| Main strategy cycles | 0 → 6 |
| Base / Main / Real / Live end rows | 29 / 29 / 79 / 219 |
| Base / Main / Real evaluated | 29 / 104,916 / 103,962 |
| Progression score | 32 → 324,637 |
| Simulated position lifecycles | 75 |
| Redis stable growth / volatility | 0 / 3 keys |
| API p95 / contract | 2,519 / 3,000 ms |
| Signal p95 | 1,017 ms |
| RSS start / peak / end | 4,767,220 / 6,483,028 / 6,245,636 KiB |
| Heap start / peak / end | 2,540,878 / 3,779,417 / 2,688,490 KiB |
| Evaluated heap growth | +126,188 KiB, within budget |

Strategy totals at the end of the development soak:

| Type | Created/passed Sets | Entries | Positions | Mean PF | Mean DDT |
|---|---:|---:|---:|---:|---:|
| Default | 40,902 | 61,353 | 65 | 1.302 | 7.5 min |
| Trailing | 204,510 | 306,765 | 5 | 1.302 | 7.5 min |
| Block | 19,028 | 28,542 | 10 | 1.832 | 82.5 min |
| DCA | 0 | 0 | 0 | 0 | 0 |
| Overall | 264,440 | 396,660 | 80 | 1.340 | 12.9 min |

Signal results: 35/35 sources exercised, 446 successful source reads, zero
failures, 178 indications, 71 signal positions, five trailing positions, and
3,312 Block-lane rows.

## Production Paper/Demo soak — complete Main progression

This run used the production build, 32 symbols, process coordinators, UI/API
reads, crash recovery, and configured shared Redis.

| Metric | Value |
|---|---:|
| Duration | 300,817 ms |
| Rounds / requests | 150 / 1,800 |
| Historic completion | 32/32, 172,800 candles, 32 cycles |
| Realtime handoff | 22 cycles / 22 frames |
| Engine cycles | 2 → 407 |
| Main strategy cycles | 0 → 54 |
| Base / Main / Real / Live end rows | 270 / 270 / 402 / 1,094 |
| Base / Main / Real evaluated | 270 / 799,902 / 799,902 |
| Progression score | 32 → 1,775,150 |
| Simulated lifecycles | 384 |
| Crash-recovered active positions | 381 |
| RSS start / peak / end | 488,612 / 2,075,820 / 1,995,812 KiB |
| Heap start / peak / end | 184,259 / 1,257,611 / 712,397 KiB |
| Evaluated heap growth | −112,582 KiB, within budget |
| Redis keys start / end | 18,217 / 104,582 |
| Redis plateau growth / volatility | 3 / 119 keys, within budget |
| API p95 / steady p95 | 214 / 216 ms |
| UI relation checks | 29 exact position/order relations |

Strategy totals at the end of the production Main run:

| Type | Created/passed Sets | Entries | Positions | Mean PF | Mean DDT |
|---|---:|---:|---:|---:|---:|
| Default | 465,318 | 697,977 | 321 | 1.262 | 7.5 min |
| Trailing | 2,326,590 | 3,489,885 | 25 | 1.262 | 7.5 min |
| Block | 202,450 | 303,675 | 78 | 1.833 | 82.5 min |
| DCA | 0 | 0 | 0 | 0 | 0 |
| Overall | 2,994,358 | 4,491,537 | 424 | 1.301 | 12.6 min |

## Production Paper/Demo soak — Signal focus

| Metric | Value |
|---|---:|
| Duration | 301,388 ms |
| Symbols / rounds / requests | 32 / 150 / 1,844 |
| Historic completion | 32/32, 172,800 candles, 32 cycles |
| Realtime handoff | 30 cycles / 30 frames |
| Engine cycles | 4 → 471 |
| Main strategy cycles | 0 → 67 |
| Base / Main / Real / Live end rows | 140 / 140 / 180 / 420 |
| Main / Real evaluated | 826,914 / 826,914 |
| Progression score | 32 → 1,827,904 |
| Simulated lifecycles | 155 |
| Crash-recovered active positions | 152 |
| Signal sources | 35 registered/configured/enabled/exercised |
| Source requests | 2,170 success / 0 failures |
| Indications | 2,896 total; 1,098 active peak |
| Signal positions | 121 peak; exact open cap 120 |
| Default / trailing positions | 112 / 9 peak |
| Signal Block ledger | 25,584 calculated/evaluated/eligible/emitted |
| Analytics | 120 open, 1 closed, 35 sources, 1,066 source-symbol rows |
| API p95 / steady p95 | 217 / 222 ms |
| Signal p95 / contract | 313 / 1,000 ms |
| RSS peak / end | 2,274,564 / 2,171,564 KiB |
| Heap peak / end | 1,288,785 / 554,835 KiB |
| Evaluated heap growth | −140,578 KiB, within budget |
| Redis plateau growth | 8 keys, within budget |
| UI relation checks | 59 exact position/order relations |

The one closed synthetic Signal sample was negative (`−0.67310733`, PF 0).
It is retained here to avoid turning a correctness test into a profitability
claim. Automatic disable remained false because one sample is below the
configured evidence threshold.

## Direct Trade historic calculations

Both matrices cover all seven types: Standard, fixed Trailing, automatic
Trailing, Combination, Inverse, High Protection, and DCA. The test dataset is
deterministic synthetic load data, not an exchange profit forecast.

| Metric | 48 hours | 90 hours |
|---|---:|---:|
| Symbols | 32 | 32 |
| Sets evaluated | 1,440,768 | 1,440,768 |
| Valid Sets | 1,024 | 1,248 |
| Valid rate | 0.071% | 0.087% |
| Calculation time | 41,310 ms | 58,843 ms |
| Reported heap | 176 MiB | 84 MiB |
| Best-first selected positions | 122 | 158 |
| Symbols represented | 16 | 18 |
| Long / Short positions | 53 / 69 | 78 / 80 |
| Historical Long / Short orders | 1,283 / 1,184 | 2,457 / 2,216 |
| Capacity | 300 total, 12/symbol, 6/direction | same |

The 90-hour extension produced 21.9% more valid Sets and 29.5% more selected
positions for 42.5% additional compute time. The policy expands only when the
48-hour evidence floor is not met, stops at 90 hours, and can continue safely
at the maximum instead of looping indefinitely.

Maximum-grid route soaks:

- Development: 1,440,768 evaluated, 3,261 valid, 145 chunks; second statistics
  pulse 1,324 ms; 301 active signals; simulated lifecycle PnL `0.4` while open
  and `0.7` after close.
- Production with shared Redis: 1,440,768 evaluated, 2,769 valid, 145 chunks;
  second pulse 1,487 ms; 259 active signals; the same complete open/close
  simulated lifecycle.
- Physical recovery: lease takeover, saved settings, open position, same-port
  server crash/restart, restored state, worker adoption, and controlled disable
  all passed.

Direct maximum-grid evaluated counts by type were identical in both modes:

| Type | Evaluated | Dev valid | Prod valid |
|---|---:|---:|---:|
| Standard | 64,512 | 54 | 97 |
| Fixed Trailing | 193,536 | 253 | 353 |
| Automatic Trailing | 193,536 | 1,032 | 673 |
| Combination | 451,584 | 1,339 | 1,123 |
| Inverse | 430,080 | 188 | 244 |
| High Protection | 86,016 | 358 | 247 |
| DCA | 21,504 | 37 | 32 |

The different valid counts are expected because the two runtime soaks generate
fresh deterministic runtime baskets; the grid topology and total counts are
identical.

## Block and position-count verification

The four-symbol/48-hour Block comparison evaluated 180,096 unique base Sets
and 2,128,896 independent Count-1…12 ledger rows. The base Set count remained
180,096 with and without Block (`disabledConfigDelta = 0`), proving Block/pos-
count relations are not double-counted as extra Base Sets. Identity mismatches
were zero.

| Count | Ledger evaluated | Valid | Volume multiplier | Configured minimum PF |
|---:|---:|---:|---:|---:|
| 1 | 177,408 | 56 | 2× | 3.2 |
| 2 | 177,408 | 56 | 3× | 6.4 |
| 3 | 177,408 | 56 | 4× | 9.6 |
| 4 | 177,408 | 56 | 5× | 12.8 |
| 5 | 177,408 | 40 | 6× | 16.0 |
| 6 | 177,408 | 40 | 7× | 19.2 |
| 7 | 177,408 | 40 | 8× | 22.4 |
| 8 | 177,408 | 40 | 9× | 25.6 |
| 9 | 177,408 | 16 | 10× | 28.8 |
| 10 | 177,408 | 0 | 11× | 32.0 |
| 11 | 177,408 | 0 | 12× | 35.2 |
| 12 | 177,408 | 0 | 13× | 38.4 |

The selected Block aggregate PF was `0.759` versus base aggregate PF `0.709`
on this deliberately mixed synthetic dataset. This is diagnostic evidence of
ratio/accounting behavior, not evidence of a profitable strategy.

## UI, production, and Redis

- Production UI: 47 surfaces, 32 symbols, 721 ms QuickStart, six engine cycles,
  settings hot reload, settings backup round trip, credential sentinel
  persistence, runtime session lifecycle, independent Long/Short behavior,
  connection edit dialog, volume and Signal hot reload, 35-source registry,
  Main toggle, pause/resume/stop/start, and 19 final exact relations passed.
- Shared Redis: Redis 8.10.0, loopback-only protected mode, AOF `everysec`, RDB
  snapshots, and `noeviction`; production explicitly forbids Inline Redis.
- Inline Redis: runtime persistence and physical Direct-Trade restart recovery
  passed. Rebuildable maximum-grid caches are regenerated after restart.
- Generated Redis test databases 10–14 were flushed. AOF rewrite and RDB save
  completed successfully; unrelated databases were not modified.
- Linux preflight found 46 GiB free disk, a 20 GiB effective memory limit,
  11 GiB available memory, apt, an available port 3002, complete install
  artifacts, and valid shell syntax.

## Remaining validation gaps

1. **Authenticated BingX demo execution:** current `.pro` preflight exited with
   the expected code `2` because no API key/secret was present. A 20-minute
   authenticated VST soak covering Direct/Main/Signal orders, fills,
   protection, reconciliation, and final flatness must be repeated on a host
   with protected demo credentials.
2. **Kernel setting:** this container cannot apply `vm.overcommit_memory=1`.
   The Linux host administrator should set it before production Redis use.
3. **External topology:** shared Redis was tested across local production
   processes and restarts, not across multiple physical hosts or a managed
   Redis failover cluster.
4. **Duration:** 15-minute Dev and 5-minute Prod tests detect coordination,
   plateau, and restart defects but are not a multi-day endurance run.
5. **Profitability:** PF thresholds and synthetic outcomes are admission and
   accounting checks. No test can guarantee positive future trading results.

## Evidence handling

Raw logs, raw trade reports, database snapshots, credentials, `.env` files,
dependencies, and build output are deliberately excluded from the release
archive. This document and its JSON companion retain the non-sensitive,
decision-relevant results.
