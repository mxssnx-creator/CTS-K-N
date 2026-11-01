# CTS-K-N audit and continuation — 2026-11-01

Canonical checkout: `/workspace/CTS-K-N`, recovered from a verified complete Git bundle. Original GitHub main: `1a4d2b23a89586bb798f2ee0b563704ac53913b5`. Integration parents: PR561 `888a65f37d445782cd04dca7af9ea0744025dfe6`, PR562 `c1f4cda8eca06de2641339882a9ebc84f9ecf4ae`. The source was validated with the final changes present; the final publication commit and tree are available from the release PR.

## Corrected behavior

- Preserve the pending Common-history, incremental replay/cache, validated-only Base PF, trailing and Signal forward-measurement work. Resolve overlapping fee edits at the existing 0.15% round-trip model. Do not revert mainnet, ownership or protection controls.
- Closed legacy rows retaining both executed and closed sizes count the fill once. Explicit zero current execution wins over old fills and stale exchange quantities.
- Keep exact executed Set membership, local lifecycle rows, pending entry intents and venue symbol/direction positions separate. Combined membership excludes its parent; repeated rows of one Set do not inflate Set counts. Do not infer pending orders from the difference between two position counts.
- Refresh created-indication counters on cached statistics responses; the engine and cached statistics use the same counter priority. Refresh corresponding overview projections as well.
- Signal statistics accept ISO and epoch-second close timestamps, exclude future, unresolved and provably foreign closes, and exclude zero-current-quantity rows from open exposure. Last-N windows select settled results before slicing. The Signal UI reads its effective configured window.
- Block recovery uses total settled net PnL with each leg's entry-basis correction, with Forex notional conversion. A last exit fill cannot overwrite the sign of a complete multi-fill result. Incomplete accounting cannot consume the idempotency marker. A reduction predating a Block leg lacks a provable per-leg allocation and does not reset that leg's recovery state.
- Add RVI and five Low-Range methods from CTS-A-O. They share the existing Common registry, settings, live/optimizer/replay wiring, independent tuple/timeframe/direction identities and stage gates. RVI has a rational reference-vector test; held events reset across gaps. These six new research types are opt-in. There are 135 registered types, 129 enabled by the existing defaults; 2,427 available default parameter tuples, 2,325 enabled.
- Allow Common history up to seven days. Every default tuple at the default 1/5/15/30m timeframes fits this cap; the longest needs about 132h. Keep the 30h default workload unchanged. Configure and benchmark `COMMON_HISTORY_MINUTES=10080` when full long-timeframe warm-up is needed.
- Audit tooling separates running Sets from position counts, reports inaccessible process-tree RSS as unavailable or uses server telemetry, and labels short runs as whole-run samples when steady state is not reached.

## Verified and limited evidence

{
  "unitSuites": 547,
  "unitAssertionsPassed": 3592,
  "unitAssertionsFailed": 0,
  "rerunEvidence": "Two initial failures resolved: isolated Redis test session and legacy source guard; unit-rerun.txt: 2 suites/215 assertions passed.",
  "integrationSuites": 6,
  "integrationAssertionsPassed": 86,
  "integrationAssertionsFailed": 0
}

TypeScript, full ESLint, source syntax and production build pass. Production build validates 356 complete trace files. Six UI routes return 200 with no invalid numeric rendered text: overview, statistics, Signals statistics, Common settings, live trading and logistics. Browser visual inspection was unavailable because the local browser binary download failed; no screenshot/layout validation is claimed.

Native paper lifecycle: 140 rows on 70 symbols close by TP/SL/hold/manual and book once. Recording-exchange coverage includes 70 concurrent entries, deferred admission/retry, protection, partial/venue closes, long/short independence and cleanup. This is not a real exchange lifecycle test.

## Fourteen completed UTC days, 15 symbols

Real public BingX OHLCV from 2026-10-18 through 2026-10-31: 302,400 complete one-minute bars, no gaps. Frozen six-type extension matrix: 102 parameter tuples × four timeframes × two directions × three fixed TP/SL/hold profiles × 15 symbols = 36,720 configurations. The first seven days select candidates; the next seven evaluate only those candidates. This is an independent unit-notional rule replay, not a portfolio, venue fills or a complete staged engine replay.

Training selected 41 (0.111656%) after base and 1.5x cost stress. All 41 had at least 12 holdout closes. Four were positive at base cost, zero at stress; zero pass both independent-validation requirements (0% retained). Holdout median PF 0.681993, best base-cost PF 1.127140. No new default is promoted, and no every-hour positivity or live profitability is claimed. The interactive HTML includes all configurations, hashes, PF, drawdown and active/positive hours; see the saved CTS-K-N Common extension audit. The reproducible harness is `scripts/audit-common-extension-replay.ts`. [Interactive results](https://chatgpt.com/library?file_id=libfile_6b0781e6230c8191a8f30530c1ebd3b6&account_id=personal).

## Runtime authorization and remaining blockers

The user explicitly authorized canonical `bingx-x01` mainnet with 15 symbols at minimum volume (current supported factor 0.1). The exact connection can opt in only with `BINGX_X01_MAINNET_LIVE=1`, `ALLOW_LIVE_ORDER_PLACEMENT=1` and `LIVE_ORDER_CONNECTION_IDS` containing `bingx-x01`, plus saved operator toggles, usable credentials, durable coordination and all normal runtime protection/ownership gates. Other mainnet identities and Bybit remain read-only. Migration111 still disables old saved mainnet flags; operator-approved re-enablement follows migration and readiness checks.

No mainnet order or server deployment was performed. `/workspace/.network-clients/activate-cts.sh` is absent, so the required managed/pinned server channel is unavailable. Do not substitute an ad-hoc route. The actual remote service revision and account state are unverified. Existing production data, credentials and services were not changed. Recover managed access, inspect the server and exchange read-only, checkpoint it, then use merged-green-main deployment and the exact 15-symbol/minimum-volume setup. Do not clear protection/accounting halts to force entries.

The initial three-minute, 15-symbol offline production run returned 200 for all sampled API routes, had no non-finite fields, no ledger audit errors and no server alerts. It exposed stale created-indication counts in cached responses (fixed afterward). It opened zero paper positions, so the run failed its lifecycle verifier and is not a production-readiness pass. Median progression pass was 3,654ms (p95 3,999ms, max recorded 5,081ms); the 500ms progression objective remains unmet. Event-loop lifetime p95 was 33.6ms. The first sampler incorrectly reported zero RSS and no liveness window; instrumentation now falls back to server RSS telemetry and uses the whole observation window when steady state is not reached. The final rerun on the rebuilt source recorded 10 whole-run samples: zero counter mismatches, zero ledger audit errors, zero server alerts and no non-finite values. It still failed lifecycle coverage (zero positions opened/closed). Median progression was 3,627ms, p95 3,801ms, max recorded 3,934ms; peak RSS 1,473.6MB. Liveness had 168 probes, one failure, p95 25ms and max 1,227ms. Steady state was not reached. This is a consistency correction, not a production-readiness pass. Preserve both raw runs as evidence.

## Earlier work inventory

558 published remote refs inspected; 484 are ancestors of the integrated local head. The two currently open PRs are incorporated. The remaining 74 already-published historical/experimental refs remain preserved and are listed individually in `branch-inventory.csv`; absence of ancestry is not claimed as proof their changes are absent. They are not wholesale merged over the newer implementation. No prior local uncommitted checkout existed in this session.

Verified checkpoints use only `scripts/create-checkpoint.sh`; the last pre-evidence checkpoint is `/workspace/backups/CTS-K-N/20261101T230258Z-before-final-docs`. GitHub publication and merge occur only after validation, with another verified checkpoint. The managed server channel and real venue lifecycle remain open.
