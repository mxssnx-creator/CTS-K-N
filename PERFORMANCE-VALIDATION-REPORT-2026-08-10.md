# CTS-K-N persistent-workspace validation

Date: 2026-08-10

All order and lifecycle checks in this report are paper/synthetic checks. No
exchange order was submitted and no exchange credential was used.

## Correctness changes completed

- Direct-Trade PF is calculated canonically as aggregate ratio-weighted net
  positive PNL divided by aggregate absolute ratio-weighted net loss. It does
  not average row PFs or take-profit range averages. Take-profit ratio mean is
  retained as a diagnostic only.
- Base and Block PNL/PF ledgers are independent. Block Count 1..12 uses the
  causal volume formula `base + base × count × volumeRatio` and its own PF/DDT
  eligibility ledger.
- Live fills require authoritative exchange `filledQty` and `filledPrice`.
  Requested quantity/price cannot create a phantom fill or volume/PF entry.
- BingX `bingx-api` is the default perpetual order fast path. Ambiguous SDK
  acknowledgements are reconciled without unsafe REST replay; missing control
  order acknowledgements cannot create duplicate protection orders.
- Paper Direct-Trade ticker reads are deterministic and offline. Public BingX
  reads are restricted to verified official hosts; unverified fallback hosts
  are ignored.
- The restored persistent checkout has ESLint flat config, Git metadata, and
  refreshed recreation manifests. Database migration target is v94.

## Automated validation

| Check | Result |
|---|---:|
| Full Jest suite | 143 suites, 972 tests passed |
| Targeted live/PF/SDK/control tests | 6 suites, 215 tests passed |
| TypeScript | `tsc --noEmit` passed |
| ESLint flat-config parse run | passed |
| Source and script syntax | passed |
| Release secret scan | 1,356 files, 0 findings |
| Kilo deployment preflight | 37 checks passed, schema v94 |
| Recreation manifests | 1,348 project files verified |
| Local dev liveness/migration endpoints | ready; v94/94, sequential, health current |
| Production UI build | 42 pages, 347 complete trace files, standalone assets passed |
| Dev UI/API paper smoke | 12 symbols, QuickStart/Progression/Stats/Live/Signal routes passed, 0 real orders |

## Direct-Trade 48h matrix

The deterministic 1m/10m/15m matrix used PositionCost TP ratios `[4, 8, 12,
14]`, step 4, PF floor 0.8, recent PF floor 25, all six enabled strategy
types, and no network/order path.

| Symbols | Evaluated sets | Valid sets | Valid rate | Duration | Heap |
|---:|---:|---:|---:|---:|---:|
| 4 | 236,544 | 500 | 0.211% | 33.590 s | 143 MiB |
| 8 | 473,088 | 802 | 0.170% | 64.152 s | 144 MiB |
| 16 | 946,176 | 1,645 | 0.174% | 133.084 s | 144 MiB |

16-symbol strategy breakdown:

| Type | Evaluated | Valid | Mean finite PF | Mean DDT min | Simulated PNL |
|---|---:|---:|---:|---:|---:|
| standard | 43,008 | 83 | 0.889 | 0.100 | 75,059.649 |
| trailing_fixed | 129,024 | 186 | 5.434 | 0.047 | 276,881.204 |
| trailing_auto | 129,024 | 195 | 5.362 | 0.040 | 236,005.669 |
| combination | 301,056 | 464 | 4.729 | 0.051 | 587,946.521 |
| inverse | 286,720 | 698 | 1.128 | 0.983 | -466,459.035 |
| high_protection | 57,344 | 19 | 3.949 | 0.139 | 77,356.567 |

The best-first paper selector chose 154 positions from a 192-position
16-symbol capacity (`12/symbol`, `6/direction`), with no infinite PF in the
selected set.

The measured 4→8→16 timings remain near-linear (`142`, `136`, and `141 ms`
per thousand evaluated sets respectively) with a stable 143–144 MiB heap.

## Block on/off and DDT comparison

Four symbols, 90 minutes, 33,792 identical base rows, and 405,504 independent
Block Count 1..12 ledger rows were compared.

| Metric | Without Block | With selected Block | Independent Block ledger |
|---|---:|---:|---:|
| Aggregate PF | 2.186 | 2.513 | 2.504 |
| Net positive PNL | 8,728.262 | 19,918.188 | — |
| Absolute net loss | 3,992.626 | 7,927.427 | — |
| Realized PNL | 4,735.636 | 11,990.754 | 137,007.332 projected |
| Evaluated rows | 33,792 | 33,792 | 405,504 |

Selected Block PF delta is `+0.327` versus Base. The Base PF remains the same
in the on/off comparison by design; the selected Block PF and the independent
ledger PF are calculated from their own scaled net PNL components.

Block aggregate PF by count: Count 1 `2.360`, 2 `2.448`, 3 `2.515`, 4
`2.538`, 5 `2.536`, 6 `2.527`, 7 `2.519`, 8 `2.516`, 9–12 `2.513`.

Disabled configuration counts: without Block, 33,792 strategy rows were
disabled by the strict 90-minute warming/recent gate; with Block, the switch
was enabled for all 33,792 base rows, while all 405,504 independent Block
ledger rows were correctly marked disabled by the same eligibility gate. The
four-hour DDT bucket was `0-4h`, maximum DDT 33 minutes, mean average DDT
0.405 minutes.

## Live Direct-Trade paper lifecycle

The isolated Next dev server and external processor completed the requested
live-mode lifecycle with `FORCE_SIMULATED=1` and synthetic data:

- exact historic warmup: 48h;
- calculation: 24 sets evaluated, 14 valid;
- Block ledger: 288 rows evaluated, 131 valid;
- realtime: 8 ticks, healthy, 0 errors;
- stats: Base PF 7.501, selected Block PF 7.910, Block ledger PF 7.835;
- orders: 0 exchange orders, 0 filled orders, 0 open paper positions in the
  observed no-signal run.

The final merge-branch rerun also completed the exact 48h warmup with a healthy
processor and 4 realtime ticks. The 90-minute Block comparison reproduced Base
PF `2.186`, selected Block PF `2.513`, independent Block PF `2.504`, and PF
delta `+0.327`, with zero identity mismatches.

## Persistence and publication state

Persistent workspace: `/workspace/CTS-K-N`. A local recovery commit exists and
the origin is configured for `https://github.com/mxssnx-creator/CTS-K-N.git`.
The GitHub CLI is installed persistently at
`/workspace/tools/github-cli/2.97.0/bin/gh`, but it is not authenticated in
this environment, so no remote push was attempted. Authenticate explicitly
before publishing:

```bash
export PATH=/workspace/tools/github-cli/2.97.0/bin:$PATH
gh auth login
gh auth status
git -C /workspace/CTS-K-N push origin recovered
```
