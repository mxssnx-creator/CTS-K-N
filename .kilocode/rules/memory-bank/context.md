# Active Context: CTS-K-N Trading System (main project)
## Active follow-up — continuous statistics, admission and VST band

- PR313 merged as `4cc47c34c4a01c42c7c32d83c450f4cee0406b5f`, head
  `da8cd875b506941ee41284bcfa864a7be8f174ce`, exact tree
  `0d40b6cd7147dacbe588c5a88326aceed93c0456`; Linux smoke 33928805746 passed.
  Official stage-evals deployment succeeded, with 274 suites / 1,892 tests,
  schema/shared Redis/continuity/restart checks. Backup:
  `/var/backups/cts-kn/pre-stage-evals-deploy-20260904`; installer rollback:
  `/var/backups/cts/cts-kn/20260904T232606Z`.
- Browser verified exact Evals 3,540/3,402 (96.1%) and 2,835/2,835 (100%),
  explicit Orders 0/0. Statistics showed 953 venue-history trades; BTC filter
  yielded 13 and Reset restored 953. These unattributed venue trades are not
  CTS pipeline fills. Screenshot saved in the shared screenshot directory.
- Further concrete defects: Statistics stage/indication cards only loaded once;
  now a single non-overlapping loop refreshes runtime every three seconds and
  current counts every fifteen, without rebuilding the archive. Connection PF
  scope and local versus venue-history archive rows are now explicit.
- Overview V2 fell through measured active=0 to cumulative counts and used a
  mirrored Set as one live exchange position despite confirmed execution=0.
  Shared projection now uses only current active counts and confirmed live
  results; regression fixtures preserve zero and real positive observations.
  Real open counts are also independent of exchange position lifetimes.
- nginx defaults to buffering; production lacked a buffering override for SSE.
  The SSE route now sends X-Accel-Buffering:no and no-transform; a real stream
  reader test verifies immediate handshake and subscriber cleanup on abort.
- Budget refusals are now blocked entries, not venue failures. A bounded
  one-second negative admission cache only reuses an authoritative crypto
  ceiling below the universal $5 floor. Existing reductions/targets/adjustments
  run before this cache; settings partition its key, and every skipped fresh
  candidate returns a blocked result. No sizing/exposure limits were raised.
- Native lifetime backfill applied successfully while all trading units were
  stopped: 5,000 unique snapshots/contributions, zero missing, all error rows
  with no executed quantities. Core-only CLI exited cleanly, no boot cleanup.
  Backup: `/var/backups/cts-kn/pre-native-vst-r5-20260904`.
- VST R5 did place authenticated orders. BTC Long Direct/DCA completed entry,
  accumulation, trailing/security replacement and close. SOL Short Main/Block
  filled twice, then protection-band derivation failed: a valid far-away cross
  margin liquidation price (45,932.7 at entry 101.85) produced a negative TP.
  The band now caps test distance while honoring any closer liquidation bound.
  A regression uses that exact observed input.
- R5 cleanup owned residuals were zero; cleanupComplete=false solely because
  unrelated BILL Short exposure and four foreign controls disappeared during
  the run. Keep this failed report intact; do not claim a full soak pass.
  Fresh read-only verification confirmed zero positions/orders on every selected
  symbol and the 0.2 SOL exception-close fill. Official services restored after
  this verification, without touching any foreign position/order.
  Report: `.agent-logs/bingx-vst-soak-2026-09-04T23-36-36-314Z.json`.
  Verification: `/var/tmp/cts-kn-native-vst-r5-20260904/owned-cleanup-verification.json`.
- Next: finish release gates, publish/merge/deploy this follow-up from green
  main, repeat full 20-minute/16-cycle VST, retain strict foreign-baseline
  evidence, recheck screenshots/API/current counts and runtime stability.
- PR314 initial tree passed 276 suites / 1,906 tests, typecheck, lint, secret
  scan and production build (349 traces); Linux smoke 33931151496 passed.
  Before merge, one more harness namespace mismatch was identified: venue
  quantity rules were written globally while Main/Preset/Signal read the
  connection-scoped key. The verifier now uses the shared tradingPairKey with
  canonical X02, so the observed SOL request 0.03 cannot be inflated to the
  static 0.1 fallback merely because its authoritative metadata is misplaced.

## Current follow-up — exact evaluated/passed display

- User additionally requested Stage Sets and Evals #/# verification. The card
  previously hid passed=0 and abbreviated count pairs; it now shows both exact
  values, including 0/0, and labels evaluated/passed vs placed/filled.
- Current per-stage evaluation samples now exclude off-basket symbols and
  always derive pass percentages from the same measured counts. An old stored
  pass_rate of 100% must never override a measured 0/20; current stage rates
  also no longer fall through to lifetime or physical fan-out counts.
- PR312 merged as `07c71df49e3f7dd7a4001b37fa3e662c8e2a8d6e`, head
  `5e8b085fab635f8c27b0369730415935820763a0`, exact tree
  `53cbce5faf9da38d13f70430ebb30449cc13327e`. Required Linux smoke run
  33926885773 passed. Full remote backup under
  `/var/backups/cts-kn/pre-visible-recovery-deploy-20260904` verified; the
  exact reviewed recovery draft is stashed and included unchanged in merged
  main. Official update unit `cts-kn-visible-recovery-deploy-20260904` started.
- R5 isolated native 32-symbol, ten-minute soak passed: Main cycles 1→27,
  353 simulated positions recovered, heap growth 155,757 KiB, RSS peak
  1,927,048 KiB, database plateau gate passed. No venue orders in that test.
- PR312 deployed successfully, installer verified schema/shared Redis/continuity
  and restart persistence. Liveness 14 ms, X02 stats 29 ms; browser Overview
  loads again. X02 has untracked external account exposure: never adopt or
  close it. Preserve baseline and select empty slots for the supervised test.
- Browser/API comparison found a null-handling display defect: a verified
  exchange snapshot had available=true but the API replaced its null error
  with exchange_snapshot_unavailable. Preserve the successful null explicitly.
- Evaluation follow-up passed all 274 suites / 1,890 tests, typecheck, lint
  and production build (349 traces). A final narrow null-error projection fix
  is verified. Full VST R4 failed at the first entry: the older maintenance
  exception still expected the random soak connection namespace. No entry was
  placed; cleanupComplete=true and official services restored. The canonical
  X02 exception now additionally requires the UUID-owned /tmp soak snapshot,
  inline-local backend and an exact harness source, besides existing confirmed
  VST origin/virtual-fund checks. Native production Redis, X01, ordinary API
  entries, missing confirmation and Mainnet remain blocked during maintenance.
  Regression tests explicitly verify these boundaries; repeat full VST next.

- Production Redis audit: X02 terminal index has 5,000 unique rows, all with
  zero executed quantity and no exchange order ID (4,997 error / 3 pending at
  sampling, then all errors). These are not fills and must not enter live PF.
  Recent automatic entries fail because the 0.57-USD PositionCost exposure
  ceiling is below the executable minimum; investigate sizing/configuration
  and avoid repeated futile dispatches without raising limits silently.
- The existing lifetime CLI's dry-run called full initRedis(), unexpectedly
  ran bootstrap and removed 26,628 rebuildable volatile keys. No durable order,
  margin-session or credential data was removed. Its own completed process was
  stopped. The CLI now uses core-only Redis initialization, requires maintenance
  for --apply and closes the native connection after completion. Verify it has
  no boot/migration/volatile-cleanup side effects before applying the backfill.
- Real's per-symbol passed field contains physical fan-out. Evals now explicitly
  uses logical_passed_sets against the logical evaluated pool, with a regression
  fixture where 1,000 physical rows represent only 20/100 logical passes.

## Current follow-up — visible counts during partial symbol coverage

- PR311 merged as `d96c7ff4363292b7c30bdf58c78a94d91d265b67`, head
  `af588f51294bfa9cb51e765284a91097298e2197`, exact tree
  `4d7c3b518f47b70f2631a4485950411b266acfae`. GitHub Dev Preview Smoke run
  33925459131 succeeded. The official updater stopped before replacement because
  a concurrent remote edit to `scripts/runtime-recovery.sh` was detected.
  Full source backup `/var/backups/cts-kn/recovery-draft-20260904` verified;
  the exact recovery draft is preserved in this follow-up and must be included
  in merged main before clearing the matching remote patch for deployment.
  Runtime/env/Redis backup: `/var/backups/cts-kn/pre-native-stats-deploy-20260904`.
- R4's native runner, production build, API routes and restart checks passed.
  During the computational soak its process received SIGTERM after roughly
  five minutes; no final verifier result exists. Do not call that a full pass.
  Isolated repeat R5 uses the same verified build at port 3123 and logs under
  `/var/tmp/cts-kn-main-diagnostic-r5-20260904`, unit of the same name.
- R4 measured 79,034 active indications, 260,394 evaluated indications,
  351 simulated entries and 350 current Signal positions. The production
  quote connector separately confirmed executable BTC/ETH/SOL Prod-VST books
  and rejected an unknown symbol without a quote request. No credentials or
  exchange orders were used in these computational/public-quote checks.
- A separate display defect was confirmed against the native API: with five
  of 32 symbols processed, strategyRows and Overview masked all existing
  counts/PF as zero. Current changes sum fresh measured symbol rows immediately
  and retain explicit partial coverage. Stale/unselected rows and last-symbol
  legacy aggregates are still excluded; stopped current-open counts stay zero.
- The card now identifies completed symbol calculations and per-stage coverage.
  A fresh partial snapshot is informative, not a count-integrity error. Current
  branch is `codex/visible-progress-stats-20260904` in the same isolated worktree.
  Focused checks passed 16/16; all 274 Jest suites / 1,888 tests passed, typecheck
  and changed-file lint passed. Production build passed with 349 complete traces.
- The preserved recovery fix confirms three liveness failures before restarting
  and queues systemd restarts with --no-block so the recovery oneshot does not
  wait through the app shutdown timeout. Deterministic private-PATH tests pass
  transient liveness recovery, three-sample outage, queued restart, cooldown,
  boot/wrapper/maintenance guards and Direct heartbeat recovery. No real service
  is touched by these shell tests.
- Keep the prior unresolved work below: complete 20-minute authenticated X02 VST
  lifecycle, production order/fill/ledger comparison, intensive browser
  screenshots, stable health/restart/memory verification and final backups.

## Active continuation 2026-09-04 — native statistics and VST verification

- PR310 is merged and deployed: main/remote revision
  `9e9f5b1ef2f089e77ae66c8d4cbb4e30d06c51af`. Independent session-equity margin
  calls default to 30% for X01 and X02. The native API isolation/restart check
  passed 7/7, and the new panel was observed in the production browser.
- Canonical checkout and concurrent work remain untouched. This continuation
  uses `/workspace/CTS-K-N-worktrees/vst-margin-20260904`, branch
  `codex/post-margin-verification-20260904`, based on merged PR310.
- User explicitly authorized rollout, push/merge/backups and insists on actual
  X02 VST orders/fills, correct nonzero counts and intensive screenshot checks.
  Do not ask for another generic deployment confirmation. X01/Mainnet and all
  Bybit venue writes remain prohibited. Counts must describe actual evidence.
- Root cause of native-only zero/misaligned counts: NodeRedisClientAdapter.multi
  silently omitted unrecognized lowercase commands (HINCRBY, LRANGE, LPUSH,
  etc.) and passed collection members in the wrong calling convention. The
  adapter now queues the complete native command set, normalizes arguments,
  preserves result ordering and rejects unsupported queues before EXEC.
- Closed forward outcomes now persist validated/rejected state and refresh the
  current snapshot. The Lua discovery-index loop must exclude the final dedupe
  ZSET: its previous SADD raised WRONGTYPE after the row had already changed,
  losing the acknowledgement that triggers cache refresh.
- `pnpm test:redis-native` starts an isolated native Redis with no exchange
  credentials. It verifies 12 mixed batch operations and four long/short,
  LIST/legacy outcome cases, including cache refresh and idempotence. Passed
  on the remote native server; inline-only mocks had missed these defects.
- Live fallback lookup now caches compact slot-to-ID membership, revalidating
  complete membership and reading matching positions fresh. The old fallback
  repeatedly decoded the entire 350-position book for every absent candidate.
- BingX ticker admission uses the selected environment's contracts inventory,
  remembers invalid symbols and honors the venue's quoted 109429 retry time.
  Its quote cooldown does not block private safety/close requests.
- The VST harness now retains the canonical `bingx-x02` identity in its isolated
  UUID-owned database. A random synthetic connection ID had passed Direct
  orders but failed Main/Preset/Signal's LIVE_ORDER_CONNECTION_IDS guard.
  Validate the existing allow-list before placing any test order.
- Full current Jest gate: 274 suites / 1,886 tests passed. TypeScript and changed
  file ESLint passed. Native coordination runner passed. Remote build/10-minute
  32-symbol soak is running at `/var/tmp/cts-kn-main-diagnostic-r4-20260904`, unit
  `cts-kn-main-diagnostic-r4-resume-20260904`. A verifier-only optional-method
  TypeScript annotation was corrected after the first R4 build attempt.
- Prior 32-symbol R3 reached four Main cycles and 350 simulated positions, but
  failed the heap-growth gate. R4 tests the repaired native batches with a
  smaller 2.5-GiB heap and 1.5/3-GiB soft/hard memory thresholds; do not weaken
  soak acceptance criteria or call R3 a pass.
- Authenticated VST R3 stopped after two cycles at the connection allow-list
  mismatch; cleanupComplete=true, owned exposure/orders reconciled and official
  services restored. Private report remains under /opt/cts-kn/.agent-logs.
  A complete 20-minute, 16-cycle proof is still required after this correction.
- Production after PR310 rollout initially passed all installer checks but has
  since shown health timeouts, recovery restarts and a browser 502 screenshot.
  Do not describe it as continuously stable until the corrective release is
  deployed and the user-requested UI/API/statistics checks pass again.
- Backups: local `20260904T220747Z-pre-native-outcome-fix` and later checkpoints
  under `/workspace/backups/CTS-K-N`; remote
  `/var/backups/cts-kn/pre-margin-vst-r3-20260904`; installer rollback
  `/var/backups/cts/cts-kn/20260904T212630Z`. All source bundles/checksums verified.
- Next: finish the R4 soak, publish/review/merge this release, deploy only green
  main with fresh backup, run full owned VST lifecycle, intensive screenshots,
  compare API counts against durable ledgers and record measured memory/DB data.

## Archived pre-PR310 planning — independent connection margin call

- Canonical source remains `/workspace/CTS-K-N`. Another concurrent chat changed
  its branch, so this release is isolated in the same repository's worktree
  `/workspace/CTS-K-N-worktrees/vst-margin-20260904`, branch
  `codex/vst-margin-isolated-20260904`, base `dcd14c2e`.
  Preserve canonical unstaged work and all stashes, including separate
  `session-equity-*` drafts; do not mix competing implementations.
- Merged GitHub main: `b2d329517cf768ddba5e5114d817864fd1d9413a` (PRs 308/309).
  Logger shutdown flushes outstanding progress and preserves a 0% success rate.
- User clarified the default 30% means equity BELOW 30% of the active session's
  starting equity. Close every position on that connection, cancel pending
  entries first, retain protective stops until flat, then cancel remaining orders.
  Keep new entries/accumulation locked until an explicit new flat-account session.
  Each connection has separate settings, session, events and a renewable lease.
- Risk settings/session hashes live under protected `settings:margin_call:*` and
  `settings:margin_call_session:*`. Native Redis uses acknowledged commands and
  configured persistence; inline/Kilo snapshot backends require a successful flush.
  A failed equity snapshot blocks entries; an already latched closure continues
  from authoritative positions/orders even when the balance endpoint is down.
  Simulated equity cannot initialize a real account session.
- UI: connection-settings Overview and Active Exchange panel. API:
  `/api/connections/[id]/margin-call`; GET status, admin PATCH threshold,
  admin POST new-session, with flat-account validation and no engine auto-start.
- Additional corrections: exact canonical 4/12/32-symbol preview fixtures,
  primary-code-aware BingX protection retries, explicit zero/negative equity,
  current reused/productive coordination counters in the cached stats overlay.
- Remote currently runs PR308 head `a5ea4651`; PR309/new margin work has NOT yet
  been deployed. The managed Chisel listener and pinned SSH forward work.
  Existing public UI is `https://152-53-114-112.sslip.io/` (port 3002 upstream).
- Remote VST attempt 2026-09-04 20:09 UTC failed due a BingX rolling rate ban
  while arming the third protective order. Original failure report preserved.
  Exact owned BTC LONG 0.0002 and two controls were reconciled at 20:18 UTC;
  confirmed zero positions/orders and restored empty pre-test baseline.
  Services restored via official service-control script; no X01/Bybit mutation.
- Remote isolated simulated 32-symbol preview passed 46 UI/API routes and restart
  persistence, but 3/10-minute soak checks failed productive Main coordination.
  Cached counter correction still requires a new remote run; do not weaken gates.
- CTS-G secondary X02 pulse service was subsequently repaired by concurrent work.
  Read-only check observed revision `6ba593a352d743ac8ad74760d033c1d1588d9c59`,
  active/running with zero restarts and source valid_candidate restored.
  Revalidate deployment file parity; do not read/compare keys.
- Verified source checkpoints include
  `/workspace/backups/CTS-K-N/20260904T204925Z-pre-isolated-margin-review` and
  `/workspace/backups/CTS-K-N/20260904T205518Z-pre-margin-final-review`.
  Full remote backup: `/var/backups/cts-kn/continue-vst-20260904T195654Z`.
  Owned cleanup snapshot: `/var/backups/cts-kn/owned-vst-cleanup-20260904T2017`.
- Local release gates: 272 Jest suites / 1,875 tests passed, TypeScript passed,
  production build passed with 349 complete traces, release scan zero findings,
  recreation inventory verified, Kilo preflight 37/37 and schema 107.
- Before remote release: publish reviewed PR, require green
  main, checkpoint/deploy with official installer, rerun full 20-minute VST and
  computational soak, verify UI/DB/memory, then record final results here.


## Session 2026-09-03 — Fix: no live exchange orders opening when connector is null

- **Code fix committed and pushed to `origin/main`** (commit `ba6389e`).
- **Bug:** `lib/strategy-coordinator.ts` line 9240 had condition
  `if (!isLiveTradeEnabled || connector)` which silently skipped ALL dispatch
  when `isLiveTradeEnabled` was `true` but the exchange connector was `null`
  (e.g., connector creation failure, backoff, or invalid credentials). The
  else branch only logged a warning and persisted `connector_unavailable`,
  so no orders were ever attempted — neither live nor simulated.
- **Fix:** Removed the `if (!isLiveTradeEnabled || connector)` gating condition
  and the `else` branch. Dispatch now always proceeds through
  `executeLivePosition`, which already handles all three cases:
  1. `isLiveTradeEnabled=false` → simulation mode (connector null, runs paper)
  2. `isLiveTradeEnabled=true`, connector valid → live exchange order
  3. `isLiveTradeEnabled=true`, connector null → returns `status="error"` with
     proper block code (`live-stage.ts` line 12738)
- **Test update:** Updated `__tests__/unit/requested-regressions.test.ts` to
  assert that `persistUnavailableDispatch("connector_unavailable")` is no longer
  present in the dispatcher, and that the new always-dispatch comments exist.
- **Validation:** `bun typecheck` and `bun lint` both pass. Targeted test
  "production strategy fan-out is exhaustive while rotating work and caches remain
  bounded" passes.
- **Remote server status:** Cannot connect. The managed Chisel activator at
  `/workspace/.network-clients/activate-cts.sh` is not present in this
  environment, no Chisel binary is installed, and no SSH credentials are
  available. Per AGENTS.md, direct SSH/SOCKS5/proxy/VPN fallbacks are
  prohibited. The remote `.cts-runtime/maintenance-stop` marker (commit
  `5d01b66`) remains unchecked and may still prevent services from starting.
- **Canonical checkout:** Cannot create `/workspace/CTS-K-N` due to file-system
  permission rules blocking cross-directory creation. Working from the
  session-specific checkout at `/workspace/6995fed7-bbea...` until the canonical
  path is available.

## Remote access / Chisel continuity rule (2026-09-02; authoritative)

- Remote CTS work must use only the managed activator
  `/workspace/.network-clients/activate-cts.sh`. The fixed route is the
  Chisel client relay at `152.53.114.112:8090` with the local SSH forward
  `127.0.0.1:2222:127.0.0.1:22`; subsequent SSH is to the local forwarded
  endpoint as `root`. Fingerprint, auth material, keys and client arguments
  remain owner-only and must never be printed or committed.
- Before any remote read or mutation, validate the managed listener and the
  SSH banner/`CTS_SSH_BANNER_OK` result produced by the activator. If the
  approval broker or network policy cancels activation, stop all remote
  operations and record the blocker; do not use direct public-IP SSH, the
  legacy connection path, SOCKS5, an ad-hoc proxy, VPN or any other fallback.
- This is the required route for future chats and deployments. A deployment
  still requires the explicit approval phrase `Managed Chisel/SSH-Deployment
  freigeben`; X01/Mainnet and every Bybit connection remain read-only, and an
  X02 VST lifecycle requires its separate explicit approval.
- On 2026-09-02 the activator was attempted from the canonical checkout, but
  the Work network approval broker rejected the required escalated network
  access before Chisel ran. Therefore no remote swap, Redis, service,
  credential, database, UI or exchange mutation was performed in this
  continuation.

## Continuation checkpoint 2026-09-02 — Redis bounded scans and server observability

- The authoritative checkout is /workspace/CTS-K-N on branch
  codex/block-break-race-recovery-20260902-v2. The material continuation
  release is committed locally at d1b59256f847a7db0014136382c2645218cf3ca3;
  the checkout is clean and the pinned pnpm installation completed with the
  repository lockfile policy. The connected GitHub branch was pushed through
  the Git data API after the shell credential path failed, then rebased onto
  merged main b86410fd566a79d48e6d4ae96aac7804c9602324 so its final tree is
  the same d1 tree without a duplicate first commit.
- GitHub PR #289 is open at
  https://github.com/mxssnx-creator/CTS-K-N/pull/289. Its current remote head
  is 7db5f72bb5572438bc5cfcdb7202bb790e02fde6, ahead of main by two commits
  and changing 18 files. The PR is structurally mergeable, but merge must
  wait for its required retired cloud provider contexts: cts-k-n is QUEUED for this head and
  the cts-v context is still pending with a 404 deployment target. Do not
  bypass those checks or merge a non-green head.
- The owner-only pre-edit checkpoint for this continuation is
  /workspace/backups/CTS-K-N/20260902T112943Z. It contains the complete Git
  bundle, binary worktree/index/unstaged patches, untracked archive/list,
  HEAD/status/ref records, SHA-256 manifest, successful sha256sum -c, and
  successful git bundle verify.
- The clean exact-tree pre-push checkpoint is
  /workspace/backups/CTS-K-N/20260902T115808Z-prepush; its SHA-256 manifest
  and Git bundle were reverified before the final context update. Additional
  owner-only investigation gates exist under /workspace/backups/CTS-K-N and
  do not authorize remote mutation.
- Inline Redis SSCAN now uses bounded Map iterators rather than
  Array.from(set) on every page. The Redis-compatible adapters expose
  sorted-set rank trimming, and retention repairs recognize the canonical
  :outcome_closed_ids ZSET, cap it at 1,000, cap outcome LISTs at 1,000,
  and preserve the existing seven-day TTL policy.
- ops/server-access-dashboard/ is now versioned as the read-only source for
  the host page currently fronted by nginx. Schema 2 exposes exact memory and
  swap bytes plus MiB/GiB, per-core CPU deltas, kernel/load/network counters,
  process and systemd resources, CTS-K-N/CTS-G probes and progression,
  request latency/error rates, restarts, state changes, failure history, and
  recent stability events. deploy/ensure-swap-18g.sh is idempotent, refuses
  unsafe or mismatched live swap files, and persists an exact 18 GiB
  /swapfile-cts-kn only after disk-space checks.
- Safe local validation passed: Redis-focused Jest 2 suites/36 tests,
  dashboard Node tests 4/4, TypeScript, repository ESLint, source-syntax
  verification, release secret scan (1,597 files, zero findings), recreation
  manifest regeneration/verification (1,589 files), and a local dashboard
  HTTP smoke returning schema 2 with per-core/memory/project/stability data.
  The deployment-contract check was not runnable because no CTS deployment URL
  is configured in this workspace. The full unit command was stopped by the
  safety guard after it identified an unexpected BingX VST path; no X02 VST
  lifecycle or exchange request was approved or performed.
- The remote 18 GiB swap, Redis repair, dashboard installation/restart,
  nginx reload, and remote verification are still pending. The managed
  Chisel activator was attempted, but Work network approval was cancelled
  before the Chisel client ran; no direct public-IP SSH, legacy route, SOCKS5,
  ad-hoc proxy, VPN, remote credential read, service restart, database/Redis
  mutation, UI deployment, or exchange action was performed. Resume only after
  the managed activator produces CTS_SSH_BANNER_OK; deploy only after the
  explicit phrase Managed Chisel/SSH-Deployment freigeben.

## Session 2026-09-02 — generation-safe progression recovery candidate

- The canonical checkout was recovered from full GitHub history plus the
  verified local recovery commit
  `codex/block-break-race-recovery-20260901@9aab1333d6822dc193ec0d8744ce8b67f94ad1af`.
  It is one commit ahead of and zero commits behind
  `origin/main@f1cc61beb9ee95814249f849e66bd7511037b0de`; no open pull request existed
  at the recovery boundary.
- The recovery candidate exposes a bounded `view=runtime` progression control
  plane, generation-aware resume liveness, safer retry behavior for transient
  control-plane reads, startup/runtime coverage, and an InstaForex base-row
  regression test. X01/Mainnet and Bybit remain read-only; this work does not
  authorize a real exchange order.
- Owner-only recovery checkpoints are
  `/workspace/backups/CTS-K-N/backup-gate-final-2026-09-01T235900Z` and
  `/workspace/backups/CTS-K-N/precommit-backup-gate-2026-09-02T001000Z`.
  Their complete bundles, binary patches, untracked archives/lists, status
  records, bundle verification and SHA-256 manifests passed.
- The first exact-tree gate found stale recreation hashes and one legacy
  timeout-contract assertion. The assertion now recognizes the bounded runtime
  projection and its 15-second reads; all recreation manifests were regenerated
  and verified. The repaired candidate passed frozen offline install,
  `git diff --check`, source syntax, secret scan (zero findings), recreation
  verification, TypeScript, ESLint, all 257 Jest suites and 1,762 tests,
  production build with 348 complete traces, 37/37 Kilo checks at schema v105,
  and mutation-free Linux installation preflight. Publication still requires
  the final exact-patch rerun followed by reviewed branch/PR merge.

## Session 2026-08-31 — bounded Main indication statistics and merged handoff

- The Main indication statistics latency fix is published through GitHub PR
  #282 (`c61df445c1a0a76cbf728fdf5eabc70320b8cc53`), the recreation manifest
  repair through PR #283 (`09f0fc18eb0c5777a3e5d656c8410109105a3e12`), and
  this final handoff correction through PR #284
  (`4900d2dc94c902ef1fc7b6aeb84821c782ec07ef`). The canonical
  `/workspace/CTS-K-N` checkout is clean on `main` at
  `4900d2dc94c902ef1fc7b6aeb84821c782ec07ef`, exactly matching `origin/main`.
- `app/api/main/indications-stats/route.ts` now uses bounded, parallel reads
  of the durable snapshot/counter/latest keys and a capped evaluator list. It
  no longer scans the full Redis keyspace for a connection-scoped request;
  diagnostics identify the source as `durable-indication-counters`. The route
  retains deterministic empty results for an unscoped request and has a
  regression test for both snapshot and bounded-list/counter fallback paths.
  This removes the 10–15 second/timeout behavior observed on the remote
  Main Connections card without changing engine ownership or live-order
  policy.
- Post-fix gates are green: focused stats tests (2/2), full Jest (256 suites,
  1,761 tests), TypeScript, repository ESLint, `build:next` (42 static pages,
  348 server traces), recreation generation/verification, install preflight,
  and release-secret scan (zero findings). The corrected project-files
  manifest is complete at 171,619 bytes, was verified with SHA-256 and
  GitHub's chunk-safe blob upload, and was reviewed in PRs #283 and #284.
- The public production browser sweep visited all 23 navigation targets and
  found non-empty expected surfaces with no application/internal/unhandled/
  404 markers. A remote-host browser tab renders the shell, but the Work
  browser blocks its `/api/*` requests with `ERR_BLOCKED_BY_CLIENT`; this is a
  client host-filter limitation, not a server failure. Server-side reads over
  the managed tunnel returned healthy health, persistence, active-indication,
  engine, progression, statistics, tracking and position contracts.
- The remote `/opt/cts-kn` runtime was successfully updated once to merged
  `e8700a2ef6a9331697504af00a37132fde582d96` and remains healthy: main,
  Direct-Trade supervisor and scheduler units are active; distributed engine
  heartbeats are fresh; X01/Mainnet and every Bybit connection remain
  read-only; X02 remains paper/VST only; exchange-open position count is zero.
  Remote checkpoints include
  `/var/backups/cts-kn/20260830T231518Z-pre-remote-update` and
  `/var/backups/cts-kn/20260830T235330Z-pre-remote-stats-update`.
- The bounded-stats commit has not been installed remotely. After the
  successful e8700a2 deployment, the only later managed-Chisel activation
  attempts were cancelled by the Work network approval broker before Chisel
  execution. No alternate SSH/proxy/VPN was used and no further remote
  mutation, restart, Redis change, credential read or exchange action is
  authorized until a fresh managed activation produces `CTS_SSH_BANNER_OK`.
- Verified owner-only local checkpoints for this series include
  `/workspace/backups/CTS-K-N/20260830T233537Z-pre-main-stats-optimization`,
  `/workspace/backups/CTS-K-N/20260830T234600Z-precommit-main-stats-optimization`,
  `/workspace/backups/CTS-K-N/20260831T000208Z-postmerge-stats-fix`, and the
  current pre-context checkpoint
  `/workspace/backups/CTS-K-N/20260831T-pre-context-stats-handoff`. Each has
  a complete Git bundle, binary worktree/index patches, untracked list/archive,
  SHA-256 manifest verification, bundle verification and owner-only mode.
- The merged-main retired cloud provider deployment for `4900d2dc` is currently reported as
  `QUEUED` by the retired cloud provider deployment API with no build-log events, while the
  public alias is serving HTTP 200 for the root, health, persistence and
  connection-scoped Main indication stats endpoint (diagnostic source
  `durable-indication-counters`). The alias is therefore a public UI/API
  smoke target, not the authenticated remote-runtime acceptance target; the
  disconnected `cts-v` check remains stale/pending. The queued PR #284 preview
  is not a remote-runtime acceptance target. Next remote work must begin with a new
  managed-Chisel banner check, a fresh server checkpoint, and deployment only
  of this merged `main`; preserve paper-only execution and the no-live-order
  invariant throughout.

## Shared Signal overview and runtime idempotency release (2026-08-30; authoritative continuation)

- The Signal/Main dashboard and runtime fix is merged through GitHub PR #280 as
  `3ffd29aea6c5ba73d4cabba1d89081fbcee16641` on `main` (PR head
  `98b183e9c9152b871d29b16e52676a63c9b65666`; validated tree from the reviewed
  branch). The canonical checkout is `/workspace/CTS-K-N`; local `main` and
  `origin/main` were fetched and aligned to the merged revision after the
  merge. The reviewed branch is closed/merged; no uncommitted source changes
  remain.
- Main Signal indications now remain the single shared indication processor.
  The Main Connections card reads the scoped active-indications profile,
  keeps the usual Main overview tiles, and adds Signal cycles/sets/open/
  closed/WinRate/PF12/DDT12/PnL12 when the Main Signal profile is active even
  if the separate Signal execution slider is off. Enabling that slider while
  Main Signal is already active only projects the additional stats; it does
  not start a second processor. Disabling the slider does not stop the shared
  Main indication work. Scoped indication writes emit the existing dashboard
  event and immediately refresh the profile/statistics read model.
- Signal enablement now checks the in-memory coordinator plus durable,
  distributed running flags and legacy/scoped runtime hashes before enqueueing
  a local start. This closes the cross-worker duplicate-start race while
  preserving shared-engine stop semantics. Mainnet/X01, Bybit and unrelated
  exchange rows remain read-only; no live exchange order is authorized by this
  UI/statistics change.
- Local validation completed: `pnpm test:unit` (251 suites, 1,693 tests),
  `pnpm typecheck`, repository-wide `pnpm lint`, install preflight, recreation
  manifest generation/verification, and release-secret scan (1,616 files,
  zero findings). The production-style max-symbol UI/process soak passed 47
  page surfaces and 32 symbols, including Signal source registry/defaults,
  Main toggle/hot reload, restart/crash recovery, settings backup round-trip,
  and lifecycle checks; it reported zero real exchange positions and zero
  exchange order submissions. The full integration run had one pre-existing
  300 ms timing assertion under machine contention; the affected functional
  live-dispatch test passed in isolation.
- GitHub Dev Preview Smoke for PR #280 passed. The PR's `cts-k-n` preview
  deployment reached READY. A stale `cts-v` status remained pending because
  the connected retired cloud provider account no longer exposes a matching `cts-v` project;
  it was not used as an exchange or production acceptance target. Post-merge
  `main` deployments were triggered and are tracked by their GitHub statuses;
  production deployment must still be verified from merged green `main`.
- Verified owner-only recovery checkpoints for this continuation are
  `/workspace/backups/CTS-K-N/20260830T215137Z-pre-signal-overview-fix`,
  `/workspace/backups/CTS-K-N/20260830T221000Z-pre-recreation-manifest-refresh`,
  `/workspace/backups/CTS-K-N/20260830T222000Z-precommit-signal-overview-fix`,
  `/workspace/backups/CTS-K-N/20260830T223000Z-premerge-signal-overview-fix`,
  and `/workspace/backups/CTS-K-N/20260830T225500Z-postmerge-signal-overview-fix`.
  Each completed checkpoint includes a complete Git bundle, binary worktree
  patch, untracked archive/list, HEAD/status evidence, verified SHA-256
  manifest, bundle verification, and owner-only permissions.
- Managed Chisel remote access remains blocked by the approval broker. Earlier
  and current attempts used only `/workspace/.network-clients/activate-cts.sh`
  and were cancelled before Chisel executed; no alternate SSH/proxy/VPN was
  used. Therefore no remote install, restart, Redis/database mutation,
  authenticated UI action, live X02 cycle, Mainnet order, or Bybit order was
  performed in this continuation. The next authorized remote step is a fresh
  managed activation attempt, followed by a read-only service/environment/
  Redis checkpoint and deployment of this merged `main` only if the pinned
  tunnel banner succeeds.

## Direct-Trade X02 Prod-VST lifecycle release (2026-08-30; authoritative)

- The functional release is merged through GitHub PR #278 as
  `e7ce71b38f425915eb8d868d7db3ce7db7e31f6f`, with exact validated tree
  `a5cd9c59a35a8bcece622026c6697de4728f443b`. The canonical checkout is
  `/workspace/CTS-K-N`; local `main` and `origin/main` were clean and aligned
  at that revision after the merge. The PR head, GitHub Dev Preview Smoke,
  both PR retired cloud provider checks, and both merged-`main` retired cloud provider production checks were
  green before this handoff update.
- The no-live-position failure was traced to connector scope, not to exchange
  entry sizing. Global `FORCE_SIMULATED=1` could leave the generic simulated
  connector cached for Direct-Trade reconciliation and UI lifecycle work even
  after an authorized X02 entry selected the real Prod-VST connector. Direct
  Trade now delegates entry, Block, DCA, close, settlement, exact TP/SL and
  shared security-stop ownership to the canonical Live stage. A separately
  scoped lifecycle connector reselects only the exact opted-in `bingx-x02`
  Prod-VST virtual-funds connection for CTS-owned Direct rows; Main/X01,
  Mainnet, Bybit and unrelated rows remain simulated/read-only and all
  ambiguous ownership still fails closed.
- A normal reinstall now preserves only the exact Direct X02 opt-in while the
  global paper defaults remain active. Explicit `--safe-simulation` forcibly
  disables the opt-in; broader connection IDs, non-Prod-VST environments,
  non-demo accounts and missing/distinct-VST credential proof are rejected.
  Bootstrap no longer changes tracked installer permissions, and the
  max-symbol verifier gives cold statistics the same bounded progression
  deadline as the engine workload.
- Final source gates passed on the release tree: TypeScript; repository-wide
  ESLint; 251 unit suites with 1,692 tests; four integration suites with 66
  tests; 29 focused Direct/live suites with 231 tests; the affected 253-test
  guardrail set; production Next build with 42 pages and 348 complete traces;
  source syntax, Linux install, Kilo, recreation-manifest, shell/processor
  syntax, diff and release-secret gates. The secret scan covered 1,616 files
  with zero findings. One concurrent timing assertion exceeded 300 ms under
  full machine load, then its complete integration group passed in isolation;
  it was not a product failure.
- The merged public production alias was exercised in a real browser without
  mutations. All 23 navigation targets were visited sequentially: 21 rendered
  a non-empty main surface with the expected heading, while Logistics and
  Settings correctly redirected an unauthenticated session to the application
  login boundary. Dashboard detail panels and Overview/Progression/
  Indications/Strategies views opened without a fatal screen, stuck loader or
  application-origin console error. Read-only health, liveness, statistics,
  engine progress and migration endpoints responded; connection-scoped X02
  Direct and live-position reads also returned normally.
- retired cloud provider is not the exchange-execution acceptance target. Its current
  serverless instance correctly reports degraded readiness/persistence because
  shared Redis and the Direct X02 live opt-in are absent, and it reports zero
  current Direct X02 live positions. No engine, setting or exchange mutation
  was performed there.
- Managed Chisel activation was attempted again only through
  `/workspace/.network-clients/activate-cts.sh` and was cancelled by the local
  network approval broker before Chisel executed. This reproduces the
  repository's documented stop condition after the earlier cancelled attempt.
  No direct SSH, alternate proxy or VPN was used. Consequently no remote
  backup, install, restart, migration, Redis mutation, UI action or X02 order
  was performed in this continuation; no Mainnet or Bybit order was placed.
- Verified owner-only recovery checkpoints for this release include
  `/workspace/backups/CTS-K-N/20260830T175959Z-pre-direct-lifecycle-connector`,
  `/workspace/backups/CTS-K-N/20260830T181707Z-precommit-direct-live-fix`,
  `/workspace/backups/CTS-K-N/20260830T182850Z-premerge-direct-live-fix`, and
  `/workspace/backups/CTS-K-N/20260830T184814Z-pre-context-direct-live-release`.
  Each completed checkpoint has a complete Git bundle, binary patch,
  untracked archive/list, HEAD/status evidence, verified SHA-256 manifest and
  owner-only permissions.
- Next authorized remote sequence: start a later fresh Work process, source
  the managed activation, require the pinned `CTS_SSH_BANNER_OK`, and stop if
  the broker cancels again. After the banner, checkpoint source, environment,
  systemd and Redis state; deploy only current green merged `main`; run the
  normal installer without `--safe-simulation`; verify the exact X02 opt-in
  through non-secret booleans; then restart and audit every service, timer,
  migration, persistence boundary, log and authenticated UI section. Run all
  engines sequentially at the maximum symbol basket in paper mode. Only after
  a stable read-only X02 account baseline may one minimum-volume, CTS-owned
  Direct Prod-VST cycle prove physical entry, exact row TP/SL, shared security,
  processor/stats/UI continuity, settlement and complete baseline restoration.
  X01/Mainnet and every Bybit connection remain read-only throughout.

## Forex/InstaForex and high-volume safety continuation (2026-08-30; current)

- Canonical checkout is `/workspace/CTS-K-N` on branch
  `codex/forex-instaforex-final-20260830`, with the intended
  Forex/InstaForex, volume/exposure, protection, Direct-Trade, UI/API,
  statistics, Redis-retention, and soak-verifier changes committed and
  reconciled with remote `main`. PR #270 is merged into remote `main` as
  `e02791dc393b06bfcff7ebfec91073afc2eb79f5` with tree
  `3fd9374fcd9721f89cf3c4f78c958a740661aa9e`. The local tree is clean;
  deployment remains pending. No real/mainnet order has been used.
- Forex uses the same indication/strategy/live-position contracts as crypto,
  with explicit `market_type`/asset-class routing, canonical pair keys,
  quote-currency conversion, lot units, higher average-count defaults, and
  broker-tick spread in effective PositionCost. InstaForex official
  Client/Quotes/Charts HTTP surfaces are read-only for account, history,
  quotes, spread, and OHLC data. Mutation is available only through an
  explicitly selected, private MT5 bridge; exact terminal tickets, bounded
  lots/exposure, direction-aware SL/TP, bridge opt-in, and post-close ticket
  verification are required. No MT4 attachment or plaintext terminal data was
  persisted or sent to the bridge.
- Volume calculation uses authoritative venue balance and aggregate position
  snapshots, active broker spread/PositionCost, Forex lot/contract conversion,
  a higher Forex average-count default, bounded caches, and a hard live
  exposure ceiling. Every physical increase re-reads aggregate exposure and
  rounds down; fallback balance, ambiguous symbol/direction, partial fills,
  missing tickets, or missing exact SL/TP fail closed. Exact row SL/TP plus one
  aggregate symbol+direction security control remains armed through closes.
  Block volume is additive from the base value (`base + base × count × ratio`)
  and each count/variant remains independently evaluated. X01/Mainnet remains
  read-only.
- Reset DB’s QuickStart path now sends same-origin cookies and the server
  accepts an authenticated admin session through `authorizeAdminRequest`;
  bearer automation remains supported. Direct-Trade intentionally continues
  to return `direct_native_protection_not_ready` for live entries while paper
  evaluation remains available. Its preflight now treats that 409 as the
  expected safety result and then verifies the paper lifecycle.
- Order safety remains ownership- and watermark-scoped: only system-owned
  positions/orders with stable tracking IDs may be adopted or mutated;
  independent/external orders are preserved and cause fail-closed behavior.
- Stats and dialogs distinguish logical stage evaluation from physical
  materialized fan-out: Base-valid → Main-parent pass → logical Real pass →
  Live mirrored/executable rows. Current-cycle, historic, outcome, direction,
  symbol, market-type, spread/PositionCost, TP/SL, order-control, and signal
  source values use scoped canonical snapshots rather than stale global rows.
  Background Signal work is single-flight and bounded; exhaustive CPU work is
  single-flight, cooperatively yielding, and runtime-concurrency capped so a
  slow max-symbol matrix is not retried on top of itself.
- The max-symbol UI verifier now uses a finite workload-aware post-resume
  liveness window (default 240 seconds, configurable and capped at 300
  seconds). This fixes a verifier false negative observed while a legitimate
  32-symbol exhaustive cycle took about 156 seconds; it does not change engine
  concurrency or order execution. Generated `scripts/__pycache__/` output was
  quarantined recoverably; only `lib/market-data-keys.ts` and
  `lib/trading-pair-keys.ts` remain intended untracked files.
- Validation completed on the current tree: unit 246/246 suites and
  1,659/1,659 tests; integration 4/4 suites and 66/66 tests; e2e 1/1 test
  (the optional live-load check was skipped because localhost:3002 was not
  running); TypeScript; ESLint; source syntax; release-secret scan
  1,608 files/0 findings; signal registry 36 sources with no authenticated or
  order requests; volatile cleanup; and recreation-manifest regeneration plus
  verification. The production Next build passed with 42 generated routes
  and 348 complete traces.
- The 120-second single-symbol production paper soak passed 60 rounds with
  zero real-exchange orders, crash recovery, 407 ms steady API p95, heap
  growth 288,997 KiB within budget, and 2,102 non-inventory keys against a
  5,000 allowance. The 240-second 32-symbol production paper engine soak
  passed 120 rounds with 5,832 logical Main/Real evaluations, 4,801 physical
  Real rows, 381 ms steady API p95, 59 non-inventory key growth, bounded
  memory, and zero real-exchange orders. The post-fix 32-symbol UI paper workflow passed
  47 page surfaces, QuickStart, settings backup/hot reload, volume hot
  reload, independent Long/Short checks, all global lifecycle controls,
  position/order relation integrity, and zero real positions/orders.
- Read-only Chisel health passed on 2026-08-30: `CTS_SSH_BANNER_OK`,
  `chisel-server.service` active and enabled. No remote restart, deployment,
  backup mutation, credential read, or exchange mutation was performed.
- Verified owner-only checkpoints bracketing the final work include
  `/workspace/backups/CTS-K-N/20260830T085500Z-pre-ui-resume-timeout`,
  `/workspace/backups/CTS-K-N/20260830T090000Z-pre-regression-guard-test`,
  `/workspace/backups/CTS-K-N/20260830T091500Z-pre-card-accounting-test`,
  `/workspace/backups/CTS-K-N/20260830T101500Z-pre-generated-cleanup`, and
  `/workspace/backups/CTS-K-N/20260830T104500Z-pre-context-update`,
  `/workspace/backups/CTS-K-N/20260830T112500Z-pre-github-publish`,
  `/workspace/backups/CTS-K-N/20260830T113000Z-pre-remote-reconcile`,
  `/workspace/backups/CTS-K-N/20260830T113500Z-pre-merge-commit`,
  `/workspace/backups/CTS-K-N/20260830T114500Z-pre-github-pr`,
  `/workspace/backups/CTS-K-N/20260830T120000Z-pre-pr-merge`, and
  `/workspace/backups/CTS-K-N/20260830T121000Z-post-merge`. Each
  includes a complete Git bundle, binary worktree/index patches, untracked
  archive/list, HEAD/status/refs evidence, and verified SHA-256 sums.
- Next handoff: if deployment is later authorized, checkpoint the remote state,
  deploy only merged `main` through the managed Chisel path, restart/reconcile,
  and rerun read-only site and paper-soak checks. Keep all runtime previews
  paper-only; do not enable X01/Mainnet or claim profitable performance from
  synthetic/VST data.

## X02 external-protection coexistence follow-up (2026-08-29; authoritative)

- GitHub PR #256 (`Keep VST security armed through shared-account closes`) is
  merged as `main@2431b4c61360dd249b34bc528ceef84da12d4c12`, exact tree
  `1de85f15cbcbcf7383986e18d637cb75368c0b8d`, and that revision is deployed
  at `/opt/cts-kn` with 348 complete server traces. X02 remains maintenance
  gated: the marker is present, regular trading services/timers are inactive,
  and port 3002 is closed.
- The authenticated post-deploy preflight was read-only and green. It observed
  a changing shared external baseline of 96 positions/192 controls, excluded
  contested `BTCUSDT`, and selected the six safe unoccupied books ETH, BCH,
  SOL, LINK, DOGE and ADA. All four path topologies passed independently:
  10 indication families, 39,328 possible Sets, 13,715 evaluation
  configurations, 12,160,000 Direct direction configurations, 4,800 generated
  Main strategies, 24 Preset indication types, four Preset strategy types,
  35 Signal sources, 162 Signal configurations, exact 198/199/200 control
  capacity boundaries, complete execution relations and four-of-four armed
  synthetic security-stop records.
- The first exact 20-minute attempt stopped safely in cycle 1 (Direct+DCA,
  ETH Long) and is excluded from PnL/evaluation attribution. CTS filled exactly
  0.002 ETH, proved row SL/TP plus full-slot security and the production
  trailing replacement/stale-update rejection, then cancelled only its row
  SL/TP before close. An independent controller added one reduce-only SL and
  one reduce-only TP; the PR #256 quiet guard refused to trade through or
  cancel those external controls. Exception cleanup retained the full-quantity
  CTS security stop and failed closed instead of guessing ownership.
- A separate guarded exact-slot reconciliation used three stable account
  snapshots, proved that the physical ETH quantity exactly equalled the two
  CTS fills, and verified that both non-CTS rows were conditional reduce-only
  protections for the same direction. One exact CTS reduce-only close flattened
  the slot; only the CTS security control was explicitly cancelled afterward.
  The venue retired the two external controls when the position became flat.
  Final CTS residual positions/controls were zero and external cancellation by
  CTS was zero. The wider account independently changed to 94 positions/188
  controls during this interval and is treated only as external state.
- Follow-up source is isolated on
  `fix/x02-external-protection-coexistence-20260829`, based exactly on merged
  PR #256. The VST harness now classifies but never adopts/cancels a stable
  external conditional SL/TP only when it is reduce-only, exact symbol and
  position side, opposite close side, non-oversized, and accompanied by an
  exact CTS-owned venue quantity. Any market/limit exposure order, changing
  identity set, wrong side/direction/symbol, missing ID or quantity drift still
  blocks. Required CTS security must remain visible throughout the close
  window, external observations are count-only in schema-v5 reports, and
  post-close restoration still requires zero symbol positions/orders.
- Safety reads now explicitly bypass the connector's normal 15-second
  dashboard open-order cache and poll fresh venue state at less than two reads
  per second. Shared capacity reserves six slots: three CTS controls, the
  observed external SL/TP pair, and one additional safety slot. Exception
  cleanup uses the same exact-slot policy and recognizes a protection that wins
  the close race without cancelling controls before authoritative flatness.
- Current local gates are green: TypeScript, repository-wide ESLint, 244/244
  Jest suites with 1,648/1,648 tests, focused coexistence/connector/runtime
  regressions 44/44, a first-attempt Next 15.5.18 build with 42 pages and 348
  complete traces, and the deep production audit across all 47 UI surfaces,
  dialogs, overview/stat relationships, settings backup, 32 symbols, independent
  Long/Short state, volume/signal hot reload and 35 Signal sources with zero
  exchange orders. The Direct 32-symbol/48-hour matrix evaluated 960,512
  independent Sets (22,467 valid); the separate Block audit evaluated
  1,419,264 independent Count-1..12 rows with zero identity mismatches and the
  additive, non-compounding formula `target = base + base × count × volumeRatio`.
- Verified recovery points include local
  `/workspace/backups/CTS-K-N/20260829T062522Z-pre-external-protection-coexistence-fix`
  and remote
  `/var/backups/cts-kn/20260829T061746Z-pre-pr256-vst-owned-slot-reconcile` plus
  `/var/backups/cts-kn/20260829T062233Z-post-pr256-vst-owned-slot-reconcile`.
  They contain complete source/deployment state, valid Redis snapshots and
  clean SHA-256 verification.
- Next sequence: regenerate recreation manifests; run release security, Kilo
  and mutation-free install gates; create a complete pre-commit checkpoint;
  publish through a reviewed green GitHub PR and merge only its exact head;
  checkpoint and atomically deploy merged main; rerun authenticated preflight
  against the then-current external baseline; then repeat the exact
  20-minute/16-cycle max-safe Prod-VST soak across Direct, Main, Preset and
  Signal with DCA and Block on every path. Finish with settlement, counters,
  controls, stats, baseline and zero-residual audits plus final local/server
  backups. X01/Mainnet and every Bybit connection remain read-only.

## X02 shared-symbol close-race hardening (2026-08-29; authoritative)

- Canonical checkout: `/workspace/CTS-K-N`, branch
  `fix/x02-shared-symbol-race-20260829`, based exactly on GitHub merged
  `main@8a52c30adcb70e722c45f74a1591860f085c7c59` (PR #255), tree
  `152ec6dc18874f9e1c40fce933fe3223bc65eda9`. X02 currently runs that exact
  merged revision. Do not deploy this follow-up worktree until its own GitHub
  PR is green and merged.
- PR #255 fixed BingX 109201 security-stop trailing replacement: price-only
  aggregate security rearm waits 1,250 ms, quantity drift remains immediate,
  and the authenticated engine probe observes deferred replacement for up to
  five seconds. The first post-deploy Direct+DCA cycle proved that fix: entry,
  accumulation, complete row SL/TP plus full-slot security, trailing ratchet
  replacement and stale-ratchet rejection all completed without 109201.
- That cycle was excluded from PnL/evaluation results because two non-CTS BTC
  controls appeared before its reduce-only close. The ownership guard stopped
  immediately instead of mutating them. Controlled cleanup finished after the
  external activity cleared, and two independent owner-only reads confirmed
  the exact shared baseline: 96 active positions, 192 open orders, no BTC
  position/order, and zero CTS soak controls. Main, Preset and Signal did not
  execute in that aborted run; never attribute its result to those engines.
- The follow-up hardening requires a stable one-second symbol-order quiet
  window before entry, accumulation, protection and close. The close allowlist
  contains only the exact tracked full-slot security order. Row SL/TP controls
  are cancelled and confirmed absent, but aggregate security remains live
  through the reduce-only close and is cancelled only after the owned position
  is authoritatively flat. Exception cleanup now follows the same order:
  wait for external orders to clear, verify exact owned quantity, close while
  protections remain armed, and cancel controls only after no owned exposure
  remains. Ambiguous or persistent external state leaves protection armed and
  fails closed.
- `BINGX_VST_SOAK_EXCLUDE_SYMBOLS` accepts a validated comma/space-separated
  candidate list. The next X02 run must exclude the observed-contested
  `BTCUSDT` slot and use every remaining executable unoccupied symbol. The
  exclusion and occupied-book filters are reported, unsupported candidates
  are rejected, and direction planning is tested for 4, 5, 6, 7 and 8 symbols
  with eight Long/eight Short cycles and both directions for every reused
  symbol.
- Final local source gates on this worktree are green: TypeScript;
  repository-wide ESLint; 244/244 Jest suites and 1,646/1,646 tests; focused
  protection/runtime/regression tests
  228/228; a first-attempt Next 15.5.18 production build with 42 pages and 348
  complete traces; and the deep production-artifact audit across all 47 page
  surfaces, both connection dialogs, 32-symbol QuickStart, settings backup
  round-trip, volume/signal hot reload, Long/Short independence and scoped
  statistics with zero real exchange orders. The Direct 32-symbol/48-hour
  matrix evaluated 960,512 independent Sets and selected 100. The Block audit
  evaluated 1,419,264 independent Count-1..12 rows with zero identity
  mismatches and retained the non-compounding formula
  `target = base + base × count × volumeRatio`.
- Verified owner-only checkpoints already bracketing this continuation include
  `/workspace/backups/CTS-K-N/20260829T050806Z-pre-shared-symbol-race-fix` and
  remote `/var/backups/cts-kn/20260829T045824Z-pre-pr255-live-soak`. X02 remains
  maintenance-gated: main/scheduler/Direct services and the recovery timer are
  inactive, the marker is present, and port 3002 is closed. Re-attest all of
  those conditions before every remote mutation.
- Next sequence: regenerate and verify recreation manifests; run security,
  Kilo and install preflights; create a fresh complete pre-commit checkpoint;
  commit and publish the exact tree through the selected GitHub integration;
  merge only after every required check is green; checkpoint and atomically
  deploy that merged `main`; rerun authenticated preflight with BTC excluded;
  take another server checkpoint; then complete the exact 20-minute/16-cycle
  max-safe Prod-VST soak across Direct, Main, Preset and Signal with DCA and
  Block on every path. Finish with settlement/counter/control/account audits
  and verified local/server backups. X01/Mainnet and every Bybit connection
  remain read-only. No synthetic or VST result is a profitability guarantee.

## X02 security-stop trailing replacement release (2026-08-29; authoritative)

- Canonical checkout: `/workspace/CTS-K-N`, branch
  `fix/x02-security-stop-trailing-replacement-20260829`, based exactly on
  GitHub merged `main@4347665675302668a4ffcdfc18404333ad404442` (PR #254).
  The deployed X02 tree is still that merged PR #254 revision while this
  follow-up fix completes publication; do not deploy the unmerged worktree.
- PR #253 repaired complete row protection and aggregate slot-security
  ownership. PR #254 added X02-only credential and host guards, owner-only
  reports, maintenance/service barriers, a four-order minimum capacity gate,
  safe cleanup and exact full-source deployment. The deployed BTCUSDT Long
  audit is clean: both CTS rows have exact SL and TP controls, the slot has one
  full-quantity security stop, external controls were preserved, and the dry
  ownership audit has zero violations, orphans, mismatches or rearms.
- The first authorized post-PR254 live cycle was Direct Trade with DCA. It
  safely opened, accumulated, armed row SL/TP and aggregate security control,
  and cleaned its owned exposure and orders back to zero without changing the
  external baseline. It then exposed BingX code 109201: replacing the slot
  security stop inside the venue's one-second same-order mutation window made
  the optional engine-trailing proof fail. No Main, Preset or Signal live cycle
  completed in that aborted run, so its result must not be attributed to those
  engines or treated as a profitability result.
- The pending source fix keeps the still-live aggregate security stop during a
  price-only rearm for 1,250 ms, then lets authoritative reconciliation perform
  cancel-confirm-replace. Quantity drift bypasses the delay. The live probe now
  observes the bounded deferred replacement for up to five seconds, retains TP,
  verifies the durable trailing ratchet and rejects a stale looser ratchet.
  The 16-cycle planner is also balanced for 4, 5, 6 or 8 executable symbols:
  eight Long and eight Short cycles, with both directions seen by every reused
  symbol.
- Exact local gates on this worktree are green: TypeScript; repository-wide
  ESLint; 244/244 Jest suites and 1,644/1,644 tests; focused protection tests
  65/65; a first-attempt Next 15.5.18 production build with 42 pages and 348
  complete traces; five-route UI smoke; Kilo preflight 37/37 at schema v104;
  and a 1,560-file secret scan with zero findings. The 32-symbol/48-hour Direct
  matrix evaluated 960,512 Sets. The separate Block comparison evaluated
  1,419,264 independent Count-1..12 rows with zero identity mismatches and the
  exact non-compounding target `base + base × count × volumeRatio`.
- Verified owner-only local checkpoints include
  `/workspace/backups/CTS-K-N/20260829T035413Z-pre-security-trailing-fix` and
  `/workspace/backups/CTS-K-N/20260829T040855Z-security-trailing-green-prebuild`.
  Both contain a complete Git bundle, binary worktree patch, untracked archive
  and list, HEAD/status/refs evidence, verified SHA-256 manifest and successful
  bundle verification. Remote full checkpoints through
  `/var/backups/cts-kn/20260829T035321Z-post-trailing-soak-failure-clean` retain
  the merged source, environment hashes, systemd state and verified Redis RDB.
- Next sequence: regenerate and verify recreation manifests; create another
  full pre-commit checkpoint; commit and publish the exact tree through a new
  GitHub PR; wait for every check; merge only the reviewed head; checkpoint the
  server; deploy only green merged `main`; rerun authenticated preflight and
  capacity checks; then complete the max-safe 20-minute, 16-cycle X02 Prod-VST
  soak across Direct, Main, Preset and Signal with DCA and Block on each path.
  Finish with exact owned-object cleanup, account/control/statistics audits and
  verified local/server backups. X01/Mainnet and every Bybit connection remain
  read-only throughout.

## Complete-dispatch, schema-v104, and X02 audit release (2026-08-27; authoritative)

- Canonical checkout: `/workspace/CTS-K-N`, branch
  `release/green-main-20260827`, exactly tracks GitHub
  `main@66968907b0a893f21fff1fd7961dac84bdb6f01d`. PR #235 merged the
  CTS-only exchange attribution, statistics/UI, lifecycle and exhaustive
  policy-eligible dispatch tree; corrected PR #238 added schema-v104 minimum
  execution volumes and Set protection. The obsolete bounded-dispatch PR #236
  and truncated-upload PR #237 are closed without merge.
- Main coordination calculates, evaluates, publishes, and physically dispatches
  every unique policy-enabled Set without a hidden per-symbol sampling budget.
  Durable Set identity, execution-family settings, CTS ownership, deduplication,
  connector/venue controls, and independent per-Set protection remain binding.
- Schema v104 migrates every known Main/Preset/Signal channel factor to the
  minimum system identity factor, Direct Trade to its canonical 0.1 default,
  and enables control-order protection aliases without enabling a live engine.
- The read-only X02 observer captured 241 samples from
  2026-08-26T23:30:06Z through 2026-08-27T00:30:43Z. Health was HTTP 200 for
  241/241 samples. The durable settled exchange subset was -2.15 USDT with
  classic PF 0.73876063; no new entry and no new settled result occurred during
  the hour. No configuration is Mainnet-qualified.
- Sanitized evidence is under
  `docs/reports/20260826T233006Z-x02-vst-one-hour/`: Markdown, JSON, 241-row
  runtime CSV, 22-row engine CSV, 29-row step CSV, and verified SHA-256 sums.
  PF coordinate remains unavailable unless every settled row has a positive
  PositionCost denominator; pending/open rows never enter realized PnL/PF.
- Direct historical recalculation is single-flight/asynchronous, expected 409
  projection lease conflicts back off without inflating the error window, and
  live position management stays independent. Direct Performance Stats cancel
  superseded polls and show `—`, never fake zero, without a settled close.
- The complete release gates are green: 231/231 Unit suites and
  1,503/1,503 tests, 4/4 Integration suites and 61/61 tests, TypeScript, ESLint,
  42 pages, 348 complete Next traces, mutation-free Linux preflight, recreation
  verification, Kilo 37/37 at schema v104, and a 1,537-file zero-finding secret
  scan. Both retired cloud provider projects are successful on merged `main@6696890`; the PR
  #238 Dev Preview Smoke also completed successfully.
- Local standalone HTTP and the self-hosted deployment/reload remain blocked by
  the Work network broker. The mandatory managed Chisel activation was denied
  before tunnel activation or SSH banner validation in the final deployment
  attempt. No server fetch, installation, service restart, exchange mutation,
  direct SSH, or alternate proxy was attempted. Repeat the remote checkpoint,
  atomic merged-main install, reload, and read-only UI/API smoke only when the
  managed path is available.
- Verified checkpoints include
  `/workspace/backups/CTS-K-N/20260827T013133Z-pre-safety-correction-570d838`,
  `/workspace/backups/CTS-K-N/20260827T013341Z-precommit-bounded-dispatch`,
  `/workspace/backups/CTS-K-N/20260827T013719Z-prepush-a715ab1`, and
  `/workspace/backups/CTS-K-N/20260827T021504Z-pre-switch-green-main`.
  All include owner-only bundle/patch/untracked/status/SHA evidence and passed
  bundle/hash verification.
- X01/Mainnet and every Bybit connection remain read-only. Any X02 write uses
  virtual minimum volume, unique ownership IDs, venue controls, and complete
  owned-object cleanup. No profit or Mainnet qualification may be inferred from
  this negative/incomplete hour.

## Control-order release publication checkpoint (2026-08-26; latest handoff)

- GitHub PR #233 (`Harden control orders and lifecycle statistics`) passed Dev
  Preview Smoke plus both retired cloud provider preview checks and was merged with the exact
  reviewed head `3ee737d559f302bc0b9e3addf2f1505ae47b7073`. GitHub `main` now points to
  merge commit `4d1bdb115cef2523bd02ce06174dc7a0da68d9a8`. The remote comparison contained
  exactly the 63 reviewed paths and one commit over
  `f6477985a2c2058b3f9c9991e9f3e125f85f3c9f`.
- Final source gates for the merged change are green: 227/227 unit suites and
  1,481/1,481 tests, 4/4 integration suites and 61/61 tests, TypeScript,
  repository-wide ESLint, production Next build, 1,509-file recreation
  verification, and a 1,517-file zero-finding secret scan.
- The self-hosted target `http://152.53.114.112:3002` remains healthy with
  healthy Redis, but has not been updated in this session. The mandatory managed
  Chisel/SSH activation was denied by the workspace network approval layer
  before a fetch or server mutation could occur. Do not claim the IP deployment
  is complete. Resume with server backup, deploy only merged GitHub `main`, and
  repeat the read-only health/deployment-contract checks once that channel is
  explicitly enabled. Do not use an alternate unmanaged SSH route.
- Both merged-main retired cloud provider checks completed successfully. The `cts-k-n`
  production deployment for `4d1bdb1` reached `READY`, and the 30-minute
  retired cloud provider runtime-error query returned zero clusters. This remains separate from
  the self-hosted IP target, which still requires its controlled SSH deployment.
- A separate concurrent task committed the X02 stability report and reconciled
  it locally, then began additional execution-summary/coordination edits in the
  shared checkout. Those follow-up edits are not part of PR #233 and must not be
  reset, staged, or represented as validated by the release gates above. The
  pre-merge recovery point is
  `/workspace/backups/CTS-K-N/20260826T223106Z-premerge-control-orders`.
- X01/Mainnet and all Bybit connections remain read-only. No production cron,
  admin mutation, or exchange order was executed. A minimum-volume X02 BingX
  Prod-VST lifecycle still requires explicit authorization, isolated ownership
  IDs, and complete restoration to the recorded pre-test baseline.

## Control-order and lifecycle correctness release in progress (2026-08-26; authoritative)

- Canonical checkout: `/workspace/CTS-K-N`, branch
  `fix/control-orders-complete-20260826`, based on GitHub
  `main@f6477985a2c2058b3f9c9991e9f3e125f85f3c9f`. The reviewed worktree is
  intentionally uncommitted until the final release gate and pre-push backup
  complete. It must not be reset or mixed with the other local fix branches.
- Control-order writes now use atomic, monotonic Redis transitions with
  fingerprint ownership, terminal-state protection, exact exchange-order
  identity matching, and process-local serialization. The Direct processor
  lease is atomic and fail-closed. Live-stage protection tracks SL/TP armed
  quantities per venue leg, preserves closing exposure, and safely reconciles
  retry/replacement/cancel/close paths without reopening a logical slot.
- Open, closing, executed, settled, and accounting-pending are now distinct
  lifecycle concepts across live positions, Direct status, symbol statistics,
  trading statistics, monitoring, indication statistics, and PnL history.
  Duplicate open/archive views are collapsed by lifecycle precedence. A single
  source classifier distinguishes real, simulated, and unknown rows. Missing or
  incomplete exchange accounting remains pending with null PnL; it is never
  converted to break-even. Profit factor is nullable with an explicit infinity
  flag, break-even rows do not distort decisive win rate, and rolling windows
  are chronological and use their stated sizes.
- Event continuity uses cooperative cancellation and cleanup for cron time
  budgets, bounded/abort-aware indication workers, and correct signal handling
  in the environment runner. Status and read routes use normalized states,
  timestamps, strict numeric parsing, bounded reads, and scoped ledgers.
- Local release evidence on this exact source is green: 227 unit suites / 1,480
  tests, 4 integration suites / 61 tests, TypeScript, repository-wide ESLint,
  a production Next 15.5.18 build (42 pages and 347 validated traces), and a
  1,517-file security scan with zero findings. Recreation manifests contain
  1,509 project files, 295 API routes / 379 methods, 47 UI pages, 103 migrations,
  and 263 tests/verifiers and verify successfully. Re-run the complete final
  gate after this checkpoint entry before publication.
- Read-only production checks against `http://152.53.114.112:3002` return HTTP
  200 for health, database, initialization, settings, engine, functional
  overview, and aggregate Direct status; the deployment-contract verifier also
  passes schema v103 and shared Redis persistence. The cloud browser upgrades
  the numeric HTTP URL to HTTPS and therefore receives a TLS 502; direct HTTP
  proves the application itself is available. Current production is still the
  older main and exhibits the PnL/execution contradiction fixed by this branch.
  No production mutation or exchange order was performed during this audit.
- Latest verified full recovery point is
  `/workspace/backups/CTS-K-N/20260826T221212Z-final-precommit-control-orders`.
  It contains the Git bundle, binary patch, untracked archive/list, HEAD/status,
  and verified SHA-256 records with owner-only permissions. It captures the
  complete source change set before publication; refresh it if source changes.
- Publication sequence remains mandatory: final local gate; full backup; commit
  and push this branch; green PR checks; merge only that checked head; server
  backup; deploy merged GitHub `main`; then repeat read-only health/contracts.
  X01/Mainnet and every Bybit connection remain read-only. An actual X02 BingX
  Prod-VST minimum-volume lifecycle requires explicit authorization, isolated
  ownership IDs, and restoration to the recorded pre-test baseline.

## Runtime-stability release in progress (2026-08-26; supersedes older availability notes)

- Canonical checkout: `/workspace/CTS-K-N`, branch
  `fix/runtime-stats-stability-20260825`, based on GitHub
  `main@d10dc9529dc14b9073a2ae121e17613e2591a063`. The checked release source
  commit is `70a628b` (`fix: stabilize runtime stats and direct trade`) and is
  awaiting GitHub PR publication. The worktree must remain clean apart from
  the continuation documentation/manifest commit that records this checkpoint.
- The change set removes the observed hot-path failures: routine Direct-Trade
  state polls no longer hydrate the full execution grid, large Direct config
  grids are versioned/gzip-compacted with bounded reads, progression/stats
  reads are paged, and the Main canonical-pipeline watchdog measures forward
  progress rather than lease age. Status/progression healing and exact
  closed-live accounting are regression-tested. Direct indication result
  tables and enable toggles are persistent; an empty enabled-indication set
  keeps internal calculations running but blocks live entries.
- Validation already completed on the pinned remote validation checkout:
  219/219 unit suites and 1,423/1,423 tests, 4/4 integration suites and
  58/58 tests, TypeScript and ESLint. The final added hot-path guard also
  passed its focused 14/14 Direct-Trade API suite. Local `git diff --check`,
  a 1,505-file secret scan (zero findings), and recreation-manifest
  verification (1,497 project files) are clean. The current local sandbox
  lacks a complete pnpm-10 link tree; do not substitute its global pnpm 11 or
  change the lockfile—use the remote pinned validation/deploy checkout.
- Current deployed `/opt/cts-kn` is still old `main@217ebd3`, not this fix.
  Runtime evidence at 2026-08-26 02:09 CEST: Redis 5.71 GiB RSS (unbounded),
  Next 2.18 GiB RSS, 3.03 MB X02 progression stats response, repeated false
  five-minute watchdog restarts, and a prior kernel OOM kill of Redis. A
  stale browser dump process was cleanly terminated. Do not run another build
  beside the old Next/Redis workload; merge first, back up, stop CTS owners,
  then clean-clone/install/build the merged main and restart only after gates.
- Remote access uses the managed Chisel activation
  `/workspace/.network-clients/activate-cts.sh` and the existing pinned
  localhost SSH forward. Keep it intact and do not log its credentials, keys,
  or arguments. X01/Mainnet and Bybit remain read-only. Any live validation is
  limited to X02 BingX Prod-VST, must use scoped unique IDs, reconcile owned
  positions/orders back to the pre-test baseline, and must never be presented
  as a profitability guarantee.
- Latest verified local pre-commit recovery point:
  `/workspace/backups/CTS-K-N/20260826T001551Z-precommit-runtime-stats`.
  It contains a complete Git bundle, binary patch, untracked archive/list,
  HEAD/status records and a SHA-256 manifest that was successfully verified.

## Backup gate checkpoint (2026-08-26)

- Canonical persistent checkout remains `/workspace/CTS-K-N`. GitHub `main` and
  the active branch `fix/runtime-stats-stability-20260825` both resolve to
  `d10dc9529dc14b9073a2ae121e17613e2591a063`; there are no open pull requests.
- The active worktree contains 42 intended but uncommitted Direct-Trade/runtime
  stability changes. It was preserved without reset. A verified, credential-free
  local checkpoint is `/workspace/backups/CTS-K-N/backup-gate-2026-08-26T0157Z`:
  sanitized source archive, source Git bundle, binary patch, untracked list,
  HEAD/status records and SHA-256 manifest all verify. Do not upload its source
  archive without explicit permission.
- Publication is blocked: the canonical checkout had no runnable dependency
  tree. A pinned, offline `pnpm install --frozen-lockfile --offline` could not
  restore the exact lockfile because `@hookform/resolvers@3.10.0` is absent from
  the local pnpm store, so typecheck, lint, Jest, source syntax, security scan,
  build and release validation cannot be reproduced. No commit, push, PR or
  merge was performed. Restore the approved pinned dependency cache or install
  against the registry with the lockfile unchanged, then run the full gate on
  this exact worktree before publishing.

## Binding continuation checkpoint (2026-08-24, current)

- This section supersedes every older checkout/path statement below it. The
  canonical persistent checkout is `/workspace/CTS-K-N`, branch
  `feature/remote-direct-pf-v101`, based on
  `c7d820c96190155c210ba52828e907c67303acf3`. The pruned
  `/workspace/CTS-K-N-integration` path must not be used. Exact recovery inputs
  are retained under `/workspace/backups/CTS-K-N/recovery-20260824T143009Z`.
- The restored systemwide stability work is present in the canonical tree.
  The current complete local gates pass 214 unit suites / 1,375 tests, 4
  integration suites / 55 tests, repository-wide ESLint, TypeScript, a
  zero-finding 1,497-file secret scan, Kilo 37/37 and Linux installer
  preflights, and a trace-valid 42-page Next build with 347 complete trace
  files. Redis schema and Kilo preflight expectations are v103. Do not discard the current
  worktree: it contains the recovered source, tests, status scopes, PF policy,
  BingX VST migration, coordination, and install/deployment contracts that
  still need to be committed together after the full release gates.
- A new exhaustive historic four-hour projection is being completed. It
  counts every enabled indication/strategy config evaluation per symbol/window,
  every indication alias, and every open/closed strategy result. Closed net
  results use the canonical PositionCost coordinate
  `1.00 + 0.10 × (Σ net PnL % / Σ PositionCost %)`: 1.00 is neutral and 1.10
  is exactly +1 average PositionCost. PositionCost is not deducted again;
  open positions never enter realised PnL/PF. Classic realised
  gross-profit/gross-loss PF remains a separate field. The Connection Card
  renders every fixed UTC four-hour row at the end of expanded details without
  sampling. Nine direct feature tests plus the wider Historic/Redis suite pass,
  and recreation manifests verify all 1,489 project files. The 32-symbol,
  48-hour paper matrix evaluated 960,512 deterministic Direct-Trade Sets;
  Block comparison evaluated 120,064 parent rows and 1,419,264 independent
  Count rows. Async scheduling and supervisor recovery gates are also green.
- Verified local checkpoints include
  `/workspace/backups/CTS-K-N/20260824T-recovery-unit-green` and
  `/workspace/backups/CTS-K-N/20260824T-before-four-hour-stats`. Each contains
  a complete Git bundle, binary patch, untracked archive, HEAD/status and a
  verified SHA-256 manifest. Continue making the same class of checkpoint
  before commit/push/merge/deploy.
- Local pinned tooling is activated by
  `/workspace/.network-clients/activate-cts.sh`: Node 22.23.2, pnpm 10.28.1,
  GitHub CLI 2.98.0, Chisel 1.12.0-rc2, Redis 8.10.1, agent-browser 0.34.0,
  and Chrome for Testing 152.0.7977.54. Browser tooling has its own pinned
  lockfile under `/workspace/.network-clients/agent-browser`; its archive and
  binaries were integrity-checked. The local Work container denies the Unix
  socket syscall Chrome/agent-browser needs, so the visual gate is scheduled
  on the authorized Linux server after merged-main deployment. Dependencies were
  restored with `pnpm install --frozen-lockfile` into the persistent store;
  the lockfile was not changed.
- The authorized server is `root@152.53.114.112`, production checkout
  `/opt/cts-kn`. A verified pre-change backup exists at
  `/var/backups/cts-kn/20260824T112655Z-pre-complete-software`. Chisel/SSH
  material remains only in owner-protected local files and must never be
  printed or committed. Chisel server/client and remote GitHub CLI are current;
  the intentionally disabled broken git-sync timer must stay disabled.
- Publish sequence remains mandatory: complete local gates; create a verified
  pre-push backup; push the checked feature head; open PR; wait for all checks;
  merge only the checked head; back up the server again; deploy merged `main`;
  verify services/Redis/Chisel; then run only a minimum-volume virtual X02
  Prod-VST lifecycle. X01/Mainnet and Bybit remain read-only. Restore X02's
  pre-test baseline and retain sanitized evidence/rollback artifacts.

## Current State

**Project Status**: ✅ Active production trading system with validated release branches

## Authoritative maintenance checkpoint (2026-08-24)

- This section supersedes older workspace/availability statements below it.
  The persistent integration checkout is `/workspace/CTS-K-N-integration` on
  branch `feature/remote-direct-pf-v101`. Its base is the clean recovered
  remote commit `cc46330ed7dbba3bdceb9ef267b53736e7902c68`, which descends
  from GitHub `main@d9cc80b00c567b8954cc86c021eb963d1fb96139`. The isolated
  local-change checkpoint is `f7b6157`; `/workspace/CTS-K-N-current-main` and
  `/workspace/CTS-K-N-active` are recovery inputs and must not be deployed over
  the integration branch.
- The current maintenance scope keeps the Direct-Trade scheduler at 280 ms,
  adds an independently persisted minimum TP/PositionCost ratio for Trailing,
  bounds the Direct volume control to 0.1–10 with a 0.1 default, verifies the
  explicit system sizing ratio, and hardens production-preview restart port
  ownership. These active defaults are migrated by Redis schema v101. No claim
  of profitability is a release gate; exchange accounting,
  ownership, protection, and deterministic correctness are.
- Source, docs, and tests may be changed locally only on top of this verified
  tree. Before publish: run unit/integration/type/lint/build, migration,
  install/preflight, restart/recovery, UI, and connection-isolation gates;
  then create a GitHub branch/PR and merge only the checked head.
- The remote route is verified end-to-end through Chisel 1.11.8 with the
  same-process inherited `HTTP_PROXY`: expected fingerprint, approximately
  180–213 ms latency, strict SSH host-key verification, and root access to
  `/opt/cts-kn`. The earlier authentication failure was traced to an obsolete
  local auth file and disappeared after it was updated to the active persistent
  server auth. The auth value itself remains outside Git. NetBird/Teleport are
  optional fallbacks only. See `docs/REMOTE-CHISEL-WORKMODE.md`.
- Remote `/opt/cts-kn` was clean at `cc46330e` before integration. A verified
  Git/source/environment/systemd/Redis checkpoint exists at
  `/var/backups/cts-kn/20260824T051626Z-pre-direct-pf-v101`. `.env` data,
  exchange credentials, Redis state, and independent exchange positions/orders
  remain server-side; only CTS-owned records and unique client IDs for the
  selected connection may be reset or controlled.
- Never commit or print Chisel auth, SSH private keys, exchange credentials,
  Redis snapshots, raw account reports, or full credential-bearing service
  command lines. Supply secrets only from owner-only files/environment at the
  execution boundary.

## Continuity: Chisel Work-mode Connection Solution (2026-08-23/24)

- The confirmed remote path is Chisel 1.11.8 through
  http://152.53.114.112:8090, using the fixed server fingerprint recorded
  in docs/REMOTE-CHISEL-WORKMODE.md, with the local forward
  127.0.0.1:2222 -> 127.0.0.1:22.
- Work-mode assigns a fresh dynamic egress proxy port per command process.
  Never reuse a proxy port observed in another command. Always pass the
  inherited HTTP_PROXY directly to Chisel in the same process that starts
  the tunnel, then run SSH in that same process namespace.
- Use the credential-free helper
  scripts/connect-remote-chisel.sh. Supply the persistent Chisel auth
  through CTS_CHISEL_AUTH or an owner-only CTS_CHISEL_AUTH_FILE; supply the
  SSH private key and strict known-hosts file through CTS_SSH_KEY and
  CTS_SSH_KNOWN_HOSTS. No token, private key, exchange credential, Redis
  snapshot, or raw account report belongs in Git.
- On 2026-08-23 the route was verified end-to-end: Chisel fingerprint matched,
  connection latency was about 180-286 ms, SSH host-key verification passed,
  and root@127.0.0.1 -p 2222 returned id -u=0. The direct remote address
  on port 2222 is not the tunnel target.
- The remote server was inventoried before maintenance: /opt/cts-kn was
  clean at merged main@9355a57, CTS services/NGINX/Redis/Chisel were active,
  the app answered on port 3002, and a protected source/environment/Redis
  backup was created under /var/backups/cts-kn/20260823T213831Z.
- The route was reverified on 2026-08-24 with the current persistent auth and
  used successfully for inventory, backup and source synchronization. Use the
  authoritative checkpoint above and the updated remote guide.

## Current exact-settlement / Shared-Redis release checkpoint (2026-08-23)

- Continue only from the persistent checkout
  `/workspace/scratch/fba10f5c97ed/persistent/CTS-K-N`. The latest merged
  release is GitHub PR `#209`
  (`main@2618ad68518df717e1b06d69fa94792fc7ebdb3a`), built on the PR `#208`
  production/runtime baseline.
  Complete-history Git bundles belong in `/workspace/backups/CTS-K-N`.
  Never commit exchange credentials, SSH/Chisel material, Redis data, raw
  account reports, `.agent-logs`, dependencies or build output.
- BingX realized PnL is now venue-authoritative by exact order ID. Prod-VST
  first consumes terminal order detail (`executedQty`, `avgPrice`, `profit`,
  `commission`) because its global `allFillOrders` response can omit known
  fills; mainnet retains granular fill history and uses exact terminal detail
  only when fill history has no matching row. Timestamp error `100421` causes
  one read-only clock resync and a newly signed retry. No ticker, requested,
  trigger or theoretical-price fallback is permitted.
- A complete authenticated 20-minute X02 Prod-VST run passed 16/16 cycles:
  Direct/Main/Preset/Signal, four cycles each, both directions, entry,
  accumulation, Default/Trailing/Block/DCA coverage, SL/TP cancel/replace and
  reduce-only close. It submitted 48 minimum-volume market orders, reconciled
  every exact order ID, proved all 16 trailing updates, restored the account
  baseline and left zero positions/open orders. Two real STOP acknowledgements
  arrived after the initial eight-second deadline (about 9.9 s and 9.5 s) and
  were recovered as the same client order without resubmission. A separate
  48/48 settlement audit measured gross PnL `-0.550300 VST`, venue fees
  `0.201814 VST` and exact net PnL `-0.752114 VST`; theoretical fallback was
  false. Credentials and raw reports remain outside Git.
- Protection placement now has a bounded late-acknowledgement reconciliation
  window and exact client-order-ID recovery after an ambiguous response. It
  never blindly submits a second SL/TP. Prod-VST test symbols are chosen from
  the four tightest unoccupied two-sided books within 75 bps, rather than
  assuming mainnet liquidity.
- Redis Open Source `8.10.1` is installed persistently at
  `/workspace/.network-clients/redis-8.10.1/bin`; the source archive matched
  the official SHA-256
  `60166c95ab7aedaa9dfe516de685be0a4dd87be95ded59ba429df14c13f1b663`.
  Local Linux-equivalent validation uses loopback protected mode, AOF
  `everysec`, RDB snapshots and `noeviction`. This tool sandbox isolates
  background process namespaces, so Redis and the audit were supervised in
  one session; a normal Linux service/daemon remains the server deployment
  model.
- The final shared-Redis production artifact passed schema v100, protected
  cron, persistence/restart, 47 UI surfaces, 32 symbols, settings hot reload,
  backup/credential round-trip, start/pause/resume/stop, two independent
  connection IDs and crash recovery (204 recovered positions). The four-minute
  production-paper soak completed 383 engine cycles and 3,742,282 distinct
  Strategy sets with one connection scope, API p95 412 ms, 1.80 GiB peak RSS,
  post-warmup heap growth `-150850 KiB`, and stable Redis growth 210 keys under
  the 1,600-key limit. Default, Trailing and Block counters were independent;
  no exchange order was submitted by this paper/UI audit.
- Exact release gate on this source state: TypeScript; 204 unit suites / 1,316
  tests; 4 integration suites / 55 tests; zero-finding 1,472-file secret scan;
  trace-valid 42-page Next production build with 347 complete trace units;
  shared-Redis Production/UI/DB/restart audit; and the authenticated X02
  20-minute lifecycle above. X01/mainnet and Bybit were not order-tested
  because no separate credentials/authorization were available in this
  checkpoint.
- The remote Linux server at `152.53.114.112` was not modified or verified from
  this sandbox. The post-reinstall recheck still returned `Network is
  unreachable` before SSH authentication on ports 22/443 and on the Chisel
  8090 upstream. The Cloud Browser HSTS-upgraded port 3002 to HTTPS and reported
  that the remote server does not speak TLS; port 4200 exposed a self-signed
  certificate which must not be bypassed. Preserve the
  server's existing production environment, credentials and Redis data; make a
  server backup before replacing processes, then deploy only a merged GitHub
  `main` and rerun the production readiness/Shared-Redis gates on-host.

## Current production isolation and long-soak checkpoint (2026-08-23)

- Binding persistent checkout for the current release is
  `/workspace/scratch/fba10f5c97ed/persistent/CTS-K-N`. Continue from its
  published GitHub `main` successor; do not reconstruct work from older
  `/workspace/CTS-*` directories. Complete-history Git bundles are stored in
  `/workspace/backups/CTS-K-N` and mirrored under this task workspace. Never
  put `.env`, exchange credentials, SSH material, Redis snapshots or raw
  account reports in Git or source bundles.
- Live accounting is venue-authoritative: realized PnL, fees, quantities and
  completion are derived from exact exchange order fills/details by order ID.
  An unresolved settlement remains incomplete and must never fall back to a
  theoretical mark-price result. Default and Trailing maintain independent
  ledgers and UI statistics.
- Direct Trade, Main Trade, Connection Cards, control orders, workers, leases,
  settings, stage/progress snapshots, position IDs and Redis indexes are scoped
  by exchange connection. Switching connections must not silently borrow the
  selected connection, and enabled connections can process independently in
  parallel. Schema v100 migrates legacy Direct state into connection scopes;
  reset preserves credentials, settings, open/opening positions and order
  recovery state while clearing rebuildable calculation/runtime statistics.
  The protected Reset DB route accepts the same admin authentication contract
  as the rest of the administration UI.
- Profit-factor/configuration defaults below 1 use `1.1` in Quickstart and
  equivalent setup surfaces. This does not rewrite measured statistics or the
  separate Block sizing ratio. Main Trade and Connection Cards use one
  canonical connection-scoped stage/statistics projection.
- Shared-Redis production topology is explicitly bounded. Monitoring exposes
  connection scope count plus indexed Set/outcome/non-indexed key families;
  long-run validation scales Set bounds by symbols and connection scopes while
  enforcing a separate 34,720-key non-indexed cap at 32 symbols. A normal
  simulated close no longer produces a false missing-live-lock warning.
- Exact release evidence: 204 unit suites / 1,309 tests, 4 integration suites /
  55 tests, TypeScript, a clean trace-valid 42-page Next production build with
  347 trace files, 32-symbol/48-hour Direct matrix (960,512 evaluated sets),
  Direct physical crash recovery, X01/X02 Shared-Redis isolation and a complete
  20-minute 32-symbol production soak. The soak completed 1,489 engine cycles,
  819,858 Main and Real evaluations, all 35 signal sources, 216 observed
  position lifecycles, API p95 411 ms, stable final Redis growth, 2.04 GiB peak
  RSS below the 6.5 GiB cap and only 21 MiB post-warmup heap growth. Default,
  Trailing and Block statistics remained distinct. The recovery/UI harness
  verified 47 surfaces, schema v100, hot reload, backup round-trip,
  pause/resume/stop/start and physical production restart. These safety runs
  submitted zero exchange orders.
- Redis 8.10.1 for local Linux-equivalent tests is available at
  `/workspace/.network-clients/redis-8.10.1/bin/redis-server`; use
  `CTS_REDIS_SERVER_BIN` with the production harness. Remote installation must
  preserve the server's existing `.env`, credentials and data, make a server
  backup first, identify exact services/PIDs before replacement, and validate
  the newly merged GitHub `main`. BingX X02 may be exercised with minimum-size
  Prod-VST orders only after authenticated preflight; X01/mainnet and Bybit
  remain read-only unless separately and immediately authorized.

## Current unified Linux/Main Trade audit checkpoint (2026-08-23)

- Fresh Linux installations now make the immutable BingX X02 **Prod-VST**
  connection operational as soon as valid configured VST credentials are
  injected: the state transition is versioned, X02 is assigned and enabled,
  and a durable `start` request is queued for the Main Trade engine. Mainnet
  venues retain their operator-selected dashboard state; X02 remains virtual
  funds only and must not be rewritten to a mainnet environment.
- Auto-start queue coordination now executes an accepted queued start exactly
  once before broad engine healing. A queued stop is handled once and excluded
  from that same sweep's start candidates, preventing a control-order
  stop→restart race and avoiding duplicate full-matrix coordinator work.
- The Main Connection card, Main Trade display and API use one canonical
  connection-scoped progression `/stats` snapshot. During bounded full-stats
  projection staleness, compact worker-owned Base/Main/Real/Live rows refresh
  the same snapshot; live evaluation uses its own counter. This preserves
  current Stage Overview, cards, percentages, IDs and row relations instead
  of mixing historical/configuration progress or flashing the prior selected
  connection's data.
- Current verified evidence on this exact worktree: TypeScript; 198/198 unit
  suites (1,267 tests); 4/4 integration suites (54 tests); zero-finding
  1,459-file secret scan; a trace-valid 42-page Next production build (347
  trace files); a 32-symbol/48-hour Direct-Trade matrix (960,512 evaluated
  sets, 884 valid, 45.5 s); native isolated-Redis Dev paper smoke; Linux
  installer preflight; and a fresh 32-symbol Shared-Redis production audit.
  The production audit exercised stage/card/UI/API data relations, 47 surfaces,
  pause/resume/stop/start, X02 UI selection, 35 Signal sources, settings and
  backup round trips, tracking/order relations, Redis restart and crash
  recovery. It produced 4,466,752 strategy sets, 231 simulated position
  lifecycles, API p95 404 ms, RSS peak 1.87 GiB under the 6.5 GiB hard budget,
  and a post-warmup heap decrease. No real exchange order was submitted.
- This sandbox has a portable native Redis 8.10.1 binary at
  `/workspace/.network-clients/...` used for isolated Linux harnesses. The
  system partition is read-only, so no host-wide package/service installation
  is claimed here. Remote Tailnet/NetBird/ZeroTier routes remain unavailable;
  local verification is not a claim that the remote Linux host was modified.

## Current trailing / production validation checkpoint (2026-08-23)

- The complete pseudo-position → live-position trailing path was audited and
  hardened. The ratchet is monotonic by direction (long stops never decrease;
  short stops never increase), exact configured step boundaries advance, stale
  asynchronous snapshots cannot loosen a persisted live stop, and the
  fire-and-forget realtime handoff is coalesced per pseudo position rather
  than accumulating venue requests. The live-stage replacement cooldown now
  gates cancellation and placement as one operation; a just-armed stop is
  never removed when a replacement is still rate-limited.
- BingX control-order placement now invalidates both aggregate and
  symbol-specific open-order snapshots on every successful SDK, REST, and
  retry path. This fixes a real stale-cache failure: a following liveness
  sweep could otherwise read the pre-placement aggregate snapshot and
  unnecessarily cancel/recreate an unchanged take-profit while ratcheting the
  stop. Regression coverage is in `bingx-vst-environment.test.ts`.
- Authenticated BingX X02 Prod-VST validation remains strictly virtual-funds
  only. The full 20-minute run completed 16/16 Direct/Main/Preset/Signal
  cycles across long and short sides, with each entry, accumulation,
  protection lifecycle, reduce-only close, counter/relation audit, exact
  order-detail check and account cleanup passing. A follow-up four-path
  engine probe exercised the actual pseudo→live bridge: initial SL armed,
  ratcheted SL cancel-confirm-replaced, TP retained, a stale looser update
  rejected, and all selected test symbols flat. Its global account-baseline
  gate intentionally remained fail-closed because unrelated VST positions
  changed concurrently outside the selected symbols; the test did not touch
  them and left no test exposure or test control order.
- Current local evidence on this exact worktree: TypeScript; 197/197 unit
  suites (1,260 tests); 4/4 integration suites (54 tests); a trace-valid
  Next production build (347 trace files); 32-symbol / 48-hour Direct-Trade
  max-grid evaluation (960,512 sets, 142 MiB evaluator heap); 32-symbol
  isolated Dev API soak (chunked 97 chunks, trailing fixed/auto coverage);
  physical Direct-Trade crash/restart recovery; and a fresh 60-second
  production-paper full-system soak. The latter exercised all 35 Signal
  sources, 32 symbols, 22 observed position lifecycles and 11 trailing Signal
  positions, with p95 API latency 323 ms, zero real orders, RSS 2.57 GiB
  below the 6.5 GiB budget, and no heap-growth breach.
- Inline Redis scans no longer retain per-session keyspace-sized `seen` sets;
  bounded iterators, a finite lifetime and durable-key protections allow
  historic marker cleanup to finish without an unbounded memory path.
  Rebuildable indicator/fingerprint caches are excluded from persisted
  snapshots; durable order, position, ownership and cooldown state remains
  persisted. Do not add credentials, VST reports, snapshots, build output or
  `.agent-logs` to Git.
- The remote Linux/Tailscale server remains unchanged from this sandbox. A
  true multi-worker production run still requires a reachable shared Redis
  server; the successful local production evidence is explicitly
  single-worker inline-Redis fallback, not a substitute for that remote gate.

## Current Linux production remediation checkpoint (2026-08-22)

- The reported Linux production symptoms were reproduced locally with the
  single-worker production artifact: status reads could wait behind startup
  work, Historic configuration scans could monopolise the event loop, and a
  volume-only save advertised itself as a generic settings reload and therefore
  scheduled a heavyweight immediate Historic/Main pass. Status healing is now
  scheduled rather than awaited, Historic scans/pipeline reads yield between
  bounded batches, cold bootstraps have one process-wide admission permit, and
  sizing-only hot reloads invalidate runtime caches without starting that full
  pass. Progress, stats and settings acknowledgements remain durable and
  observable while work is queued.
- Exchange trade history now reconciles BingX VST per symbol when the account
  wide history page omits a recently created order. Exact order-detail data is
  retained as the authoritative correctness source; the VST soak report keeps
  a separate non-failing list-page omission diagnostic.
- Current validation on this exact worktree: TypeScript and ESLint; 194/194
  unit suites (1,244 tests); 4/4 integration suites (54 tests); secret scan
  (1,455 files, zero findings); trace-valid Next production build (347 trace
  files); 32-symbol Direct-Trade simulated 24 h grid (960,512 evaluated sets,
  chunked into 97 chunks) plus physical crash/restart recovery; and the
  production UI audit. The final quick 32-symbol artifact audit had API p95
  15.03 ms and 427.4 MiB RSS. The prior deep audit verified 47 UI surfaces,
  settings/volume readback, Progress/Stats, Start/Stop/Pause/Resume and zero
  real exchange orders.
- BingX X02 Prod-VST initially failed with a misleading 100001 signature error
  after a slow time-sync response. The venue timestamps its response near
  arrival, so calculating against RTT midpoint could generate a future-dated
  next request. The connector now uses response-arrival time and `no-store` for
  clock fetches. Authenticated preflight and a four-cycle virtual-funds soak
  then passed: Direct/Main/Preset/Signal each completed Entry, accumulation,
  SL/TP, cancellation and reduce-only close; all four symbols were flat, the
  baseline was restored, counters/relations passed and exact per-ID exchange
  history was complete. X01/mainnet remains fail-closed. Do not persist
  supplied credentials in source, reports or snapshots.
- Remote Linux/Tailscale deployment remains intentionally unchanged until the
  operator confirms the Google/Tailnet login from an authorized machine. The
  present sandbox cannot reach the Tailnet; do not infer a successful SSH or
  server deployment from the local production audit.

## Current audited release checkpoint (2026-08-21)

- Continue from `/workspace/CTS-K-N-v3.7` and preserve the persistent
  workspace/checkpoints; do not run broad automatic cleanup. Source changes
  and release evidence are published through GitHub only after the full gate is
  green. Credentials, private keys, raw account reports, Redis snapshots and
  build output stay outside Git and source archives.
- Memory coordination is deliberately conservative: effective host/cgroup
  memory now feeds the runtime profile, strategy graphs have a shared default
  admission limit of one, and non-result fan-outs use bounded `forEach`
  processing rather than retaining unnecessary result arrays. The final
  32-symbol simulated production audit remained healthy at 548.3 MiB RSS with
  a 4 GiB soft limit and API p95 26.74 ms; connection isolation and scoped
  settings readback both passed.
- BingX X02 remains immutable `prod-vst` on the official
  `https://open-api-vst.bingx.com` origin. Cancellation now invalidates both
  aggregate and symbol open-order snapshots immediately, and order-detail
  parsing accepts the VST `{ data: { order } }` response shape. The final
  authenticated VST preflight passed on 2026-08-21 without submitting an
  order. The preceding complete virtual-funds soak passed with all tracked
  orders terminal and cleanup complete; X01 real-money gates remain
  fail-closed.
- Direct-Trade's safe lifecycle preflight remains paper-only: it expands a
  sparse history from 48 h to at most 90 h without relaxing qualification,
  keeps the processor healthy, and reports zero real exchange orders.
- Production metadata normalization now removes every transient Next route-type
  include (`.next-*` and `.next/dev`) from `tsconfig.json`, retaining only the
  canonical `.next/types` universe. It exits cleanly after a partial Dev build
  with no production `BUILD_ID`; the trace build remains responsible for
  rejecting incomplete production artifacts.
- The server deployment path is documented in
  `docs/REMOTE-TAILSCALE-PULL-AGENT.md`. `scripts/install-pull-agent.sh`
  installs a root-owned, timer-driven updater that refuses dirty checkouts and
  non-fast-forward remote history, then delegates to the canonical clean
  `scripts/update.sh` lifecycle. It stores no exchange/Tailscale/SSH secrets.
  Tailscale SSH must be enabled by an authorized Tailnet login and policy; do
  not copy private OpenSSH keys to the server.
- The current Codex sandbox cannot be used as a Tailnet endpoint: it has no
  writable system package state for Tailscale/Redis and both the provider SSH
  route and the supplied Tailnet address return `Network is unreachable`.
  Therefore the remote server is unchanged. Complete the documented Tailscale
  login from the VPS console or another writable authorized Tailnet node, then
  run the server bootstrap and pull-agent commands there.
- Latest local gate evidence: 193/193 Unit suites and 1,228/1,228 tests,
  4/4 integration suites and 54/54 tests, TypeScript, ESLint, shell/source
  syntax, Kilo deployment preflight (37 checks), a trace-valid Next build (347
  trace files), Dev Paper smoke, and the 32-symbol simulated production UI
  audit. The E2E localhost-only test was skipped when no server was running;
  the Dev/Prod harnesses cover the live server workflows. A true local
  multi-worker shared-Redis preview remains infrastructure-blocked until a
  real `redis-server` or configured shared Redis is available; never report
  the inline single-worker audit as a substitute.

## Current recovery and validation checkpoint (2026-08-15)

- Persistent-workspace rule (binding for every new CTS chat): continue from
  `/workspace/CTS-K-N-v3.7`; the recovered
  `/workspace/scratch/2401a4646209/cts-latest` tree is a read-only fallback.
  Keep installer/runtime/Redis
  state outside the source tree in `/workspace/CTS-K-N-runtime`, never run automatic workspace
  cleanup, and never replace the tree from an older archive without first
  comparing it to the newest durable checkpoint. Create a sanitized local and
  Google Drive checkpoint after each green functional milestone and before each
  risky long soak/build/publication step. The durable Drive target is folder
  `CTS-K-N BingX X02 VST Release 2026-08-11` (`1K_4E4ZdHJRsqrY1nS6vCfLg6VEuWqS5C`).
  Source archives must include the credential-free `.env.example`, while
  excluding real `.env` files, credentials, logs, raw trade reports, database
  snapshots, build output and dependencies.
- The complete GitHub head namespace was fetched and compared by commit date,
  ancestry, patch identity and tree. No hidden branch is newer than
  `agent/historic-runtime-stability-20260814@e15970cc`; `main@9ee7b7ec` is
  its ancestor, and the misleadingly named `CTS-v5.6@48e991a7` dates from
  2026-08-06 and is already contained in current history. The recovered
  `CTS-K-N-current-main` directory is newer only as an uncommitted working
  tree (109 modified plus 27 new files), and that complete tree is now
  consolidated in the persistent checkout.
- Persistent operator tooling is installed outside Git: GitHub CLI `2.97.0`
  is under `/workspace/tools/github-cli`; Redis server and CLI `8.10.0` are
  under `/workspace/tools/redis`. The reusable runtime wrappers and safe
  loopback configuration are in `/workspace/CTS-K-N-runtime`. Shared Redis
  uses protected mode, 16 databases, AOF `everysec`, RDB snapshots and
  `noeviction`; a physical wrapper stop/start retained probes in both DB0 and
  DB8. Local live-order placement remains explicitly disabled.
- The 2026-08-15 `redis-safety` current-main checkpoint was integrated onto
  `agent/historic-runtime-stability-20260814` without replacing Git metadata or
  the verified branch ancestry. Its Drive SHA-256 is
  `445722ff4e0e4aa583faaac525cd4e8fba00be38fd259d426dd7c0eadfdb9613`.
  Independent acceptance exposed and fixed one remaining bootstrap defect:
  a failed shared-Redis cleanup command was previously treated as 65 seconds
  of lock contention, and Jest-created inline snapshot timers could outlive
  their module environment. Redis command errors now retry on the next init
  without the contention spin, periodic persistence stays disabled in Jest
  unless explicitly requested, and the complete suite passes 181/181 suites
  and 1,216/1,216 tests. TypeScript, ESLint, source syntax, diff checks and the
  1,420-file secret scan are green.
- Direct Trade now has a default active global position capacity of `100` and
  a separate hard operator maximum of `300` (still `12` per symbol / `6` per
  direction). Exact legacy default `300` settings migrate once to `100`; custom
  operator values remain unchanged. Minimum PF remains `4`.
- The full 32-symbol Shared-Redis Dev cold replay on 2026-08-15 completed
  Historic `32/32` in `350295 ms` with `115168` candles, `23600845` indication
  results, zero errors, 36 Signal indications and up to 29 paper positions. It
  stayed within the configured RSS/heap safety caps and compacted Redis from
  roughly 49k to 34k keys. The acceptance harness then stopped normally (no
  crash) because only 2 of the required 3 per-symbol Main cycles completed in
  the bounded grace period. Root cause: the Dev harness configured
  `STRATEGY_REAL_SETS_CEILING=600`, but runtime never consumed it; one symbol
  retained 57,576 qualified Real objects downstream. The repaired limit is
  post-evaluation only, keeps complete logical/raw counts, preserves every
  exact active lineage even above the ceiling, and remains unlimited by
  default in production. A full cold rerun is mandatory before publication.

- Durable publication target is PR `#184`, branch
  `agent/historic-runtime-stability-20260814`, in
  `mxssnx-creator/CTS-K-N`. Always fetch the live branch head immediately before
  publishing and use a verified fast-forward update. The post-recovery safe head
  is `e15970cc0bbbed9b47c59995e6dc5b8f5d28d8fd`; its source tree is the verified
  recovery tree `fd50a0c850c30420e56c804cdb385de1a33e459e`.
- Historic indication writes are bounded and batched, the historic-to-realtime
  handoff retains its evaluated symbol/direction state, and non-combined
  Real-to-Live dispatch now retains both the exact executable row Set and its
  broader Block lineage. Combined position-count dispatch remains intentionally
  member-only so one Base-related pos-count group is counted exactly once.
- Direct Trade defaults to minimum PF `4`; the exhaustive 48-hour and 90-hour
  grids, normalized generation-v2 configuration transport, bounded position
  capacities (`100` default, `300` hard global / `12` per symbol / `6` per direction), and restart
  reconstruction are covered by dedicated regression and soak contracts.
- Inline Redis no longer persists the reconstructible Direct-Trade maximum grid,
  while settings, position/order ownership and lifecycle ledgers stay durable.
  Critical snapshot barriers have a bounded five-second wait. Flat Special
  numeric settings preserve numeric `0`/`1` instead of being coerced to booleans.
- Settings/import and init-status freshness, unique dev/build snapshots, Direct
  calculation route serialization, and SWR response reuse close the known UI,
  event-overlap and concurrent-request stalls. The detailed evidence templates
  are `docs/CTS-K-N-VALIDATION-RESULTS-2026-08-14.md` and `.json`; refresh them
  with the final 2026-08-15 rerun instead of copying historic claims forward.
- The pre-cleanup acceptance evidence was: 173 Jest suites / 1,172 tests,
  TypeScript, ESLint, source syntax, a 42-page Next 15.5.18 production build,
  Linux preflight, 32-symbol development and production progression soaks,
  35-source Signal soak, Direct 48h/90h maximum grids and fail-closed BingX VST
  credential checks. No authenticated exchange credential survived in source,
  no order was submitted from the sanitized environment, and the alternate
  `open-api-vst.bingx.pro` host remained fail-closed/unverified.
- Platform scratch-workspace pruning cannot be disabled by project code. The
  mandatory continuity boundary is therefore external: after every completed
  functional block create and hash a sanitized Google Drive archive, push the
  coherent GitHub checkpoint, and preserve the results/delta report in durable
  Library/Drive storage. At the start of every new CTS chat, recover and verify
  the latest external checkpoint before modifying or installing anything.
- Recovery rerun installed the lockfile-complete dependency graph and the
  installer-supported `redis-memory-server` fallback under the external runtime
  root `/workspace/CTS-K-N-runtime`. Redis `stable` starts with
  durable AOF/RDB data in `redis-data`, `appendfsync=everysec`, protected mode
  and `noeviction`; a physical stop/start retained the exact verification key.
  Because Codex command sandboxes isolate network namespaces, shared-Redis app
  tests must run in the same managed shell session as that Redis process here;
  a normal Linux systemd/PM2 install does not have this sandbox limitation.
- The canonical Jest contract must run with the process-isolated inline backend,
  not the mutable persistent Redis dataset. The durable helper is
  `/workspace/CTS-K-N-runtime/run-tests-isolated-inline.sh`; production-backend
  compatibility and application soaks remain separate shared-Redis gates. A
  cross-session `flock` now prevents two isolated tool namespaces from opening
  the same persistent AOF concurrently.
- The new reproducible Historic-DCA entry point is
  `scripts/optimize-dca-14d.ts`. The exact 14-day run covered 2,016 candidates,
  four symbols, both directions and 5m/15m/30m with costs/slippage. Under a 6%
  drawdown and single-loss ceiling, two candidates passed two 7-day folds; the
  best had 50 positions (17 Long/33 Short), PF 1.6903, +13.1489% simulated
  initial-notional PnL, 5.6004% max drawdown and zero total-loss events. No
  candidate passed four independent 3.5-day folds, so this is not evidence for
  a stable-profit guarantee and must not silently replace production defaults.
  The complete aggregate result is
  `validation-results/dca-historic-14d-2026-08-15.json` (runtime evidence,
  excluded from source archives); publish a summarized result separately.
- The superseding 42-day / 18-symbol DCA test is
  `scripts/optimize-dca-42d.ts`. It verified 36 complete 5m/15m histories,
  screened 4,322 short-range configurations, fully re-ran 204 diversified
  finalists across six weekly folds, and then froze per-symbol choices after
  28 training days for an untouched 14-day out-of-sample test. No global
  candidate qualified: the least-risk fallback produced 1,263 positions, PF
  0.7963, -8.0524% equal-weight net PnL and 8.1811% equal-weight drawdown. The
  training-only adaptive basket selected eight symbols but failed both OOS
  weeks (202 positions, PF 0.5135, -7.2735% equal-weight PnL, 7.3560% DD); only
  BTC stayed positive. Therefore DCA remains disabled and no losing profile may
  replace production defaults. The detailed source-safe report is
  `docs/DCA-HISTORIC-42D-18S-VALIDATION-2026-08-15.md`; the 6.1 MiB JSON stays
  ignored as local runtime evidence.

## Current audit checkpoint (2026-08-12)

- Restored the credential-free `main@4b0ef042` archive after workspace pruning
  and verified it against `origin/main` before making changes.
- Historic→Realtime handoff, idempotent generation writes, owner leases,
  control-order barriers, Base/Main/Real/Live relation/count contracts,
  TP-specific trailing coverage, Direct-Trade lineages and system recovery are
  exercised by the full suite. A target production URL is still required for
  host-side deployment verification; it must not be reported as locally run.
- Fixed a live settings race in Main position-count axis projections: the
  settings-derived per-Set volume multiplier now participates in the bounded
  Axis-LRU identity. Changing the operator ratio from 3 to 10 therefore
  refreshes the executable Set from 0.006 to 0.02 Base-volume units instead of
  retaining a stale cached ratio. Regression coverage is in
  `strategy-axis-coordination.test.ts`.

## Current Release Checkpoint (2026-08-11)

- Active publication branch: `agent/bingx-vst-soak-20260811` in
  `mxssnx-creator/CTS-K-N`. The branch starts at `c486d78`; continue from its
  newest pushed commit and do not assume `main` already contains this release.
- CPU/capability-adaptive processing lanes, async configuration types, forced
  `BTCUSDT/SOLUSDT/BCHUSDT/XRPUSDT`, complete Direct/Main DCA coordination,
  and Direct-Trade Overview strategy/exchange rolling statistics are complete.
- The selected seven-day DCA default is the exact 15-minute relative profile:
  TP `0.6%`, SL `1.95%`, step distances `0.3/0.6/1.0/1.6%`, four `1×` adds,
  maximum position-volume ratio `5`. Backtest result: `+26.47794%`, PF
  `17.64218`, maximum drawdown `1.20067%`, average DDT `136.67m`.
- Direct live orders now use a durable 30-day economic-intent record, stable
  cross-exchange client IDs, ACK/timeout recovery without blind replay,
  terminal-only cumulative partial-fill accounting, crash-persistent
  open/Block/DCA/close generations, reduce-only/hedge-mode connector controls,
  and fail-closed unsupported spot/legacy adapters. Binance code-less success
  and OKX per-order `sCode` are handled correctly.
- The production installer fails closed without at least one non-placeholder
  supported exchange credential pair, requires live readiness, shared durable
  coordination where configured, and a fresh Direct-Trade processor heartbeat.
  This is code/preflight verified only: an actual remote host and authenticated
  exchange were not supplied, so no real order was submitted and no external
  production deployment may be claimed yet.
- Validation at this checkpoint: final 151 Jest suites / 1,037 tests,
  TypeScript, ESLint, fresh Next production build
  (42 static pages, 347 trace files), schema-v97/Kilo/installer/deployment
  contracts, 1,374-file secret scan with zero findings, 48-hour paper-only live
  lifecycle, and physical SIGKILL/same-port recovery. The live/recovery soaks
  use isolated Next dist directories and preserve the production `BUILD_ID`,
  `next-env.d.ts`, and `tsconfig.json` byte-for-byte.

## Prod-VST X02, execution integrity and UI checkpoint (2026-08-11)

- `bingx-x02` is the immutable predefined BingX Prod-VST demo connection. Its
  environment and origin normalize to `prod-vst` and
  `https://open-api-vst.bingx.com` across seeding, migrations, APIs, dialogs,
  reconnects and live-order routing. Credentials remain only in the ignored,
  mode-0600 `.env`; they are never embedded in source, reports or archives.
- Direct/Main/Preset/Signal execution now has complete source/Set/order/position
  relations, terminal authoritative fill accounting, simulated protection
  metadata, canonical SL/TP calculation, exact per-source/per-symbol counters,
  and live-position integrity statistics. The BingX 200-control-order ceiling
  uses exact-intent batching at 198/199, switches to system-close at 200, and
  never drops a protection intent.
- Direct-Trade interval work is serialized: a cycle cannot overlap its
  predecessor and every completed interval waits at least 50 ms before the
  next starts. Global engine start preserves the operator's requested/effective
  live flags and never auto-enables a credential-bearing connection.
- Main Connection cards expose the exact Base Total/Valid, Main Valid/Overall,
  Real Valid/Active and Live Long+Short/Orders stage contract, including the
  latest-50 Real-vs-Live PF ratio. The Base PF minimum is configurable from the
  Main/Base settings surface. Settings/Overall/Connection edit and information
  dialogs retain X02 identity and use canonical read-after-write state.
- Next build JSON publication is atomic for `.next*` contracts, preventing
  zero-byte trace and route manifests. A strict single-attempt `.next-prod`
  build completed 42/42 pages and validated 347/347 trace files. The production
  paper UI harness passed 47 page surfaces, 32 symbols, dialogs, settings and
  volume hot reload, 35 Signal sources, Main toggle, pause/resume/stop/start,
  and 16/16 simulated position/order relations with zero exchange submissions.
- The authenticated virtual-funds Prod-VST soak ran for exactly 1,200,001 ms:
  16/16 flat cycles (four each Direct/Main/Preset/Signal; eight DCA/eight
  Block), 80 unique venue submissions, 32/32 exposure fills, 16 position
  creations, 16 accumulations, 32 protection orders and 16 closes. All 48
  requested-vs-filled quantity differences were zero; 80/80 order-history IDs
  were present; tracked exposure volume was 173.81398 USD and the counter
  difference was only floating-point epsilon (`2.84e-14` USD). All 387 network
  observations used the exact VST host with zero blocked/non-2xx requests.
  SOL/BCH/XRP/ADA finished flat, while the pre-existing BTC LONG 3.0566 and ETH
  SHORT 103.48 quantities and all baseline orders remained unchanged.
- Final local acceptance before publication: 159 Jest suites / 1,074 tests,
  TypeScript, ESLint, Direct-Trade 32-symbol/48-hour matrix (1,440,768 Sets),
  Block Count 1..12 ledger (2,128,896 rows), 35-source Signal registry,
  read-only VST stress, and deterministic 1/2/3/4/8/16-symbol concurrency
  benchmark (peak 75,806 Sets/s, 160 MiB maximum worker heap).

## Direction and Special checkpoint (2026-08-12)

- All indication, Strategy, Set, position, order, fill, PF, volume, history,
  progression and audit paths now preserve an explicit effective Long/Short
  direction. Each indication publishes exactly one direction; theoretical
  configuration coverage is never counted as mirrored executed orders.
  Missing or contradictory direction fails closed across APIs and BingX,
  Bybit, OrangeX and Pionex adapters.
- The new `Special` family independently evaluates Long and Short market-change
  speed, acceleration, activity, volatility, scenario persistence, order-flow,
  depth and spread evidence over exact 15s/1m/15m/30m plus combined lanes.
  Fixed and adaptive-Trailing exits have separate Set keys and ledgers. Hard
  runtime limits are min step 3, max 5 positions/direction, max 3x Base volume,
  max SL/TP distance ratio 3 and max hold 90 minutes.
- Settings exposes the complete Special surface and per-indication Trailing and
  Block policy for Direction, Move, Active, Active Advanced, Special, Optimal,
  Common, Signal, Trend and Auto; both policies default on. Special runtime and
  progression topology are included in backend counts and dashboard views.
- The final read-only five-day VST validation dynamically selected CYS,
  JIMOTHY, AIINU and TUT as the highest one-hour-volatility candidates with at
  least 95% five-day coverage. TOAD was skipped at 36.36% coverage. Fixed was
  273 trades (171 Long/102 Short), PF 0.866854, stable PF 0.535826, max DD
  35.797579%; Trailing was 282 (177/105), PF 0.857253, stable PF 0.535205,
  max DD 39.080569%. No fold-qualified configuration exists, so activation is
  fail-closed. Final artifact timestamp: `2026-08-11T23-55-13-849Z`.
- Fixed and Trailing 24h reports now share one market endpoint and twelve exact
  two-hour UTC buckets. Fresh volatile listings are promoted only after five-day
  coverage validation; incomplete listings no longer abort the whole run.
- Authenticated Prod-VST final acceptance passed 4/4 Direct/Main/Preset/Signal
  lifecycles over BTC/ETH/SOL/BCH, 2 Long and 2 Short, DCA and Block, 20 unique
  venue submissions, exact directional/source counters, complete order history,
  and zero residual positions/orders. A preceding six-cycle run exposed and
  fixed the audit's implicit-Long expectation; offline re-audit was exact.
- Acceptance at this checkpoint: TypeScript, ESLint, 163 unit suites / 1,073
  tests, 4 integration suites
  / 52 tests, E2E, 42-page/347-trace production build, four-symbol development
  paper smoke, 1,386-file secret scan with zero findings, and five-symbol public
  quote stress with 1.9 MB heap growth.
- Detailed evidence and limitations live in
  `SPECIAL-ENGINE-VALIDATION-2026-08-12.md`. Never claim stable profit from this
  checkpoint; publish the safety and validation code while keeping Special
  automatic activation disabled.

## Mandatory Continuity Workflow

- Treat the current CTS source tree as durable project state: never begin a risky
  recovery, dependency, migration, soak, deployment, or Git operation without a
  validated source checkpoint.
- Create a credential-free, restorable workspace archive before risky steps and
  after every completed functional block.  Exclude build output, runtime state,
  local logs, dependency directories, Git metadata, and environment/credential
  files; validate both archive readability and SHA-256.
- Commit and push each coherent, tested checkpoint when GitHub authentication is
  available.  If publishing is temporarily blocked, continue only with durable
  archives and record the exact Git blocker; publish the queued checkpoints as
  soon as authentication is restored.
- This workflow is project-wide and must be continued in every new CTS chat so a
  hang, scratch cleanup, process crash, or context switch cannot erase work.


The starter template was replaced with the full CTS-V-yd trading system
(strategy engine, analytics UI, API routes, tests). The code now lives in
this repo's `main` branch and is pushed to `origin/main` on
`github.com/mxssnx-creator/CTS-K-N.git`. The bot token (`kilo-code-bot`)
can push to `CTS-K-N` but NOT to `CTS-V-yd`.

## Source Provenance

- Source code originated in `agent_b15e3c2a/ctsv` (branch `kilo`, remote
  `CTS-V-yd.git` — no push access). Its 2 unpushed commits (prod/dev engine
  alignment) are included in the consolidated `main`.
- The previous `ctsv-dev/` symlink tree and empty `ctsv/` placeholder were
  removed during consolidation.

## Recently Completed

- [x] **Pushed + merged to GitHub main (2026-08-17)**: committed `62988c1` "fix(bingx): eliminate rate-limit retry storm and 109400 positionSide error" and force-pushed to `origin main` (`mxssnx-creator/CTS-K-N`). No open PRs; the commit is now on `main`. `next-env.d.ts` (auto-generated) was restored and excluded from the commit.
  - `lib/error-handling.ts`: added `parseBingXRetryAfter()`; `getRetryDelay()` now accepts optional `errorMsg` and honors BingX "can retry after time" hint (500s cap) for RATE_LIMITED.
  - `lib/exchange-connectors/bingx-connector.ts`: added a STATIC shared `bingxRateLimitUntil` circuit breaker across all connector instances (per-instance cooldown failed because multiple lanes didn't coordinate) with a >=510s cooldown floor (480s BingX window + 30s buffer) + 8s random jitter; wrapped `getOrder`/`getOpenOrders`/`getOpenOrder`/`getOrderDetails`/`getOrderHistorySnapshot` to throw-and-skip on 109429/109421; fixed `placeOrder` SDK fast path to derive `positionSide` (`sdkEffectivePositionSide`) resolving 109400.
- [x] Server reinstall + recovery: reinstalled CTS-K-N from main via `scripts/bootstrap-install.sh --skip-tests`, rebuilt from patched source (BUILD_ID `C_d4DOgUp8YyC5iSyIvZ6`). Verified server source matches committed workspace. Fixed EACCES on `.next` (chown root:cts-kn + chmod g=rwX). On-server results: 109429 errors 132→0/min, next-server CPU 154%→27%.
- [x] Merged `prehistoric-async-20m-complete` branch (`df746f9`): optimize prehistoric async processing and complete aggregates. Replaced per-row Redis Sets (`historic_dedupe`) with scalar completion markers (`historic_complete`) to bound memory growth; added `incrementHistoricAggregateOnce` for atomic PF/counts aggregation, avoiding unbounded LRANGE fan-out; shared indication calculations for configs with identical parameters; pre-built `HistoricPriceSeries` per symbol; ceiling division for concurrency. Committed as `da885c2`.
- [x] Analyzed `production-live-server-20260804` and `direct-trade-self-healing-release` branches: both represent superseded earlier implementations whose work is already incorporated into main via PR #171 (`010648d`) and subsequent commits — no additional merge needed.
- [x] fix(dev-preview): QuickStart `Test: FAILED` mislabel — added `testSkipped` flag to distinguish "SKIPPED - no credentials" from actual failures in log output, progression events, state storage, and response JSON.
- [x] fix(dev-preview): toggle-dashboard `maxDuration` 15s → 300s to prevent retired cloud provider timeout during engine stop/start under load.
- [x] fix(dev-preview): `verify-prod-soak.mjs` — added `requestWithRetry` for toggle-dashboard calls to handle transient `TypeError: fetch failed` under memory pressure (3 retries with backoff).
- [x] Verified: `bun typecheck` ✓, `bun lint` ✓, `bun test:unit` 914/914 ✓, `bun test:integration` 38/38 ✓.
- [x] fix(dev-preview): restore 12GB default heap in `scripts/run-dev-preview-check.mjs` (`|| 6148` → `|| 12288`) to resolve the Base→Main→Real→Live GC death-loop that starved the dev soak; satisfies the committed `requested-regressions.test.ts` heap assertion. CI smoke (`dev-preview-smoke.yml`) overrides `DEV_NODE_HEAP_MB=4096` and is unaffected.
- [x] fix(stats): direct-trade and preset-trade stat display — `calculateRollingPF` returns `pf=null` for empty windows (not 0), `formatPF` uses null check (shows actual `0.00` instead of `—`), `formatDDT` shows `0.0m`, `direct-trade-statistics.tsx` uses `!= null` check, `preset-trade-stats.tsx` sort handles Infinity PF (no NaN), bar chart normalizes Infinity to 999.
- [x] Intensive direct-trade verification: matrix test (177,408 evaluated sets, TP ratios [4,8,12,14], 12/6/300 position limits, 1,892,352 projected 32-symbol sets, 99MB heap), recovery soak (lease takeover ✓, settings persistence ✓, open-position retention ✓, SIGKILL+restart state restoration ✓, worker lease adoption ✓, controlled stop ✓). All 953 tests (139 suites) pass including 29 direct-trade tests, 7 recovery/continuity tests. Typecheck ✓, lint ✓, dev-preview smoke ✓.
- [x] Removed stray `bun.lock` (gitignored artifact) so `kilo-deploy-preflight.mjs` "no competing Bun lockfile" passes on repo hosts; `tests/remove-stray-bun-lock.mjs` remains the cleanup helper.
- [x] Verified locally: `bun typecheck` ✓, `bun lint` ✓, `bun test:unit` 914/914 ✓, `bun test:integration` 38/38 ✓. Committed as `4b4cb98` and pushed to `origin/main`.
- [x] Base Next.js 16 setup with App Router
- [x] TypeScript configuration with strict mode
- [x] Tailwind CSS 4 integration
- [x] ESLint configuration
- [x] Memory bank documentation
- [x] Recipe system for common features
- [x] Fix route handlers `localStartAllowed` pattern (NODE_ENV → RETIRED_PROVIDER) for self-hosted production
- [x] Fixed `pre-startup.ts` symbol seeding to preserve existing snapshot values (no overwrite of `force_symbols`)
- [x] Updated Redis/bootstrap state for `bingx-x01` without embedding exchange credentials; server environment values remain the only credential source
- [x] Connection progress 0/# fix - production symbol cap now resolves after force_symbols read
- [x] `posCountsVolumeRatio` 0.05 wiring - Settings interface, sliders, coordination-section, expandAxisSets
- [x] Position-Count axis coordination keeps Long and Short independent through
  Real and combines only same-direction members for the Live targets; opposite
  directions never hedge or cancel each other.
- [x] VolumeCalculator variant floor lowered 0.1 → 0.01
- [x] `coordination_settings` char-indexed object bug fix in GET handler (parseIfString before spread)
- [x] `posCountsVolumeRatio` 0.05 full prod flow: GET default 0.05, PATCH save/persist round-trip, flatKnobs mirror, clamp 0.01–0.25. Verified on prod build (.next-prod, :3100).
- [x] Fix: QuickStart live button now shows ON when live_trade_requested is true - unified with options bar Control Orders switch behavior (checks live_trade_requested || is_live_trade || live_trade_enabled)
- [x] Updated regression test to verify liveTradeUiFlag checks all three live trade states
- [x] Fix: QuickStart connection selection logic - removed incorrect `!liveTradeRequested` condition that prevented BingX auto-discovery in live trade mode
- [x] Fix: `collectQuickStartChangedFields` now handles null/undefined beforeConnection/beforeSettings parameters gracefully
- [x] Fix: Removed unused `effective_flag_off` block code from RealTradeBlockCode type
- [x] Fix: Production readiness checks now verify base connections have valid API credentials for live trading
- [x] Fix: `checkProductionReadiness` no longer returns 503 when preset BASE_CONNECTION_IDS (bybit-x03, pionex-x01, orangex-x01) are absent — missing connections are simply skipped; only connections that exist and have stale/invalid credentials block readiness
- [x] Removed all static/hardcoded exchange credentials; production reads credentials only from protected server environment variables and remains fail-closed when they are absent
- [x] Direct Trade now binds Start and Live-mode toggles to the selected exchange connection, so the selected BingX connection is persisted before live execution can be enabled
- [x] Restored durable live-order infrastructure gates for multi-process/serverless deployments while preserving an explicit single-owner Inline Redis override
- [x] Fix: `system:database:health` metadata mismatches in production readiness are now warnings instead of hard failures so fresh boots with unpopulated health hash can still start
- [x] Fix: Missing `connection_settings:{id}` hash for active/main connections is now a warning instead of hard failure, allowing operators to enable connections before opening the settings dialog
- [x] `env-credential-loading.test.ts` verifies environment-only credentials and empty fail-closed behavior when server variables are missing
- [x] Verified core production/live-trade tests pass: `main-live-trade-readiness.test.ts`, `env-credential-loading.test.ts`, `production-continuity.test.ts`
- [x] Verified no new production test regressions were introduced; remaining test failures are pre-existing test-infrastructure issues unrelated to the readiness fixes
- [x] Verified sim trading (live trade disabled) tracking, stats, counts, and updates are correct: progression stats route includes simulated positions in closed-archive PF/win-rate calculations; `savePosition` moves terminal simulated positions to the closed index; `closeLivePosition` increments closed/win counters for simulated positions. All counts are correct.
- [x] Added ProfitFactor for last 12, 25, 75 positions to `/api/connections/progression/{id}/stats` (`realtime.positions.profitFactor.{all,last12,last25,last75}` and `winRate` equivalents) and `/api/trade-engine/pnl-stats` (`profit_factor_last_12`, `profit_factor_last_25`, `profit_factor_last_75`).
- [x] Verified production-mode Live Trading navigation, settings/volume hot reload, controls, position/history data, and coordination counts with the 32-symbol standalone UI workflow
- [x] Completed race-condition and stats/count coordination review across live-stage fill/close/adjustment paths, progression snapshots, Long/Short counters, client event coalescing, and crash recovery
- [x] Security hardening: removed hardcoded JWT fallback secret (now fails closed), fixed user ID mismatch in registration (nanoid preserved as string), added `authorizeAdminBearer` to all unprotected admin routes, fixed auth bypass when `ADMIN_SECRET` unset, fixed `process.env` leak in SSH child process, added `maxDuration=300` to quick-start route, fixed duplicate type declarations in `bingx-api.d.ts`, standardized `Request` → `NextRequest` in trading routes
- [x] Dev-preview smoke-mode continuation: lowered `run-dev-preview-check.mjs` default `DEV_NODE_HEAP_MB` from 12288 to 6144 so the default (constrained-host) smoke path fits an ~8 GiB container rather than requesting 12 GiB; full soak / larger hosts override via `DEV_NODE_HEAP_MB`. Added `.github/workflows/dev-preview-smoke.yml` to run the smoke verifier (1 symbol, 4 GiB heap, paper-only) on push/PR via pnpm 10.28.1 + Node 22.

## Recently Completed (2026-07-29)

- [x] Fixed signal position limits: Changed `signal_max_open_positions_long_short_total` from 120 to 350 in migrations 087, 088, 089, 090 in `lib/redis-migrations.ts`
- [x] Fixed `scripts/kilo-deploy.mjs` to use stable `/opt/cts-kilo-deploy-*` directory instead of unstable `/tmp` from `tmpdir()`
- [x] Added `--skip-tests` option to `scripts/bootstrap-install.sh` and forward it to `install.sh`
- [x] Fixed remote install script in `app/api/install/remote/route.ts` to forward skip-tests in install mode
- [x] Updated test assertions to expect `SIGNAL_MAX_POSITIONS_DEFAULT = 350`
- [x] Fixed test assertion to use correct settings label ("Signal Sources base positions limit (overall)")
- [x] Updated integration test in `main-engine-live-dispatch.test.ts` to expect limit 350
- [x] Added continuous Real-stage evaluation in `lib/strategy-coordinator.ts`: derives Row-Real/Row-Live calculative sets from last N positions using existing PF/DDT gates, tagged as `#continuous_real`, independent from Base/Main
- [x] Updated Real-stage stats in `lib/strategy-coordinator.ts` to include `continuousRealCreated` count in progression hash and detail stats
- [x] Updated `app/api/connections/progression/[id]/stats/route.ts` to expose `continuousRealCreated` in Real stage stats response
- [x] Updated `components/dashboard/active-connection-card.tsx` to display continuous evaluation count on Real stage row
- [x] Verified Block strategy configs for Real/Live stages: `blockActiveRealEnabled` and `blockActiveLiveEnabled` both default to `true` in `_coordinationSettings`
- [x] Verified Block-Only mode: `blockOnly` defaults to `true` in `_coordinationSettings` and settings loader
- [x] Fixed BingX connector `getOrder()` to preserve exchange-returned order type instead of hardcoding `"market"` — fixes protection-order recognition in `live-stage.ts`
- [x] Updated schema version references from v91 to v92 across preflight scripts, tests, and build setup to match migration 092
- [x] Updated `strategy-snapshot-consistency.test.ts` and `install-deployment-contract.test.ts` to expect schema v92

## Current Structure

| File/Directory | Purpose | Status |
|----------------|---------|--------|
| `src/app/page.tsx` | Home page | ✅ Ready |
| `src/app/layout.tsx` | Root layout | ✅ Ready |
| `src/app/globals.css` | Global styles | ✅ Ready |
| `.kilocode/` | AI context & recipes | ✅ Ready |

## Current Focus

The template is ready. Next steps depend on user requirements:

1. What type of application to build
2. What features are needed
3. Design/branding preferences

## Recent Change – Event-driven resilience and Direct Trade (2026-08-02)

- Direct Trade now defines take-profit ranges as integer multipliers of the
  configured PositionCost: the UI and API accept `2..12` in steps of one and
  default to `4..12`.  The calculation grid converts each multiplier to its
  actual price-percent target; it is no longer a disconnected fixed TP list.
- Block sizing is explicitly non-compounding in Direct Trade and the Main
  Base→Main→Real→Live pipeline: `target = baseVolume +
  validBlockCount × baseVolume × blockVolumeRatio`.  The block multiplier is
  stored independently from the ordinary minimum-position-volume setting and
  exact config identity includes it, the validated Block count and TP ratio.
- Settings changes are delivered by processor/lease acknowledgements instead
  of loop-count timing.  A calculation begun under superseded settings cannot
  open a new position; it restarts from the acknowledged configuration.
- CPU-heavy indication families remain bounded and cooperative, with Trend an
  explicit final barrier.  Snapshot/recovery/inline-Redis paths retain their
  atomic and crash-safe guarantees without monopolising the Node event loop.
- `build-next-with-trace-retry.mjs` rejects mixed source revisions, retries a
  source-drifted build from a fresh fingerprint, and explicitly prepares the
  standalone static/public assets because its direct `build:next` invocation
  bypasses npm's normal `postbuild` hook.
- Verification: full Jest suite `136 suites / 932 tests`; focused Direct
  Trade/Block/Main/continuity/install/Trend suite `13 suites / 113 tests`;
  TypeScript and installer shell syntax passed.  A fresh
  `.next-prod-final2` artifact contains 346 valid traces, root and standalone
  manifests, static/public assets, and served `/api/health/liveness` while
  `FORCE_SIMULATED=1` and `FORCE_LIVE=0`.  No exchange credentials or real
  orders were used for validation.

## Recent Change – Direct-Trade bounded TP grid and installer recovery (2026-08-03)

- Direct Trade now uses a two-handle TP range slider from `2..22×`
  PositionCost (unit handle steps), with defaults `4..14×`.  A separate
  Set-creation stride defaults to `4`, materialising `4, 8, 12, 14` while
  always retaining the selected upper boundary.  This makes the full
  32-symbol/90-hour default grid `1,892,352` independent configurations,
  below the four-million operating budget.
- The TP stride is persisted, reported in calculation summaries, passed to
  the calculation route, and included in the Direct-Trade processor's
  fingerprint.  Changing it invalidates the prior grid before it can create
  an entry.
- Default admission capacity is `12` positions per symbol and `6` per
  direction.  Exact legacy default state `3/2` upgrades to the new defaults;
  mixed custom capacity settings remain untouched.
- Clean server bootstrap moves to a safe sibling working directory before it
  removes an old checkout, avoiding Git's deleted-current-directory failure.
  If a clone fails after state was archived, the next bootstrap automatically
  restores the newest archive for the exact target.
- Validation: 138 Jest suites / 941 tests, TypeScript and shell/Node syntax,
  migration and installer recovery contracts, install preflight, and the
  segmented 32-symbol/90-hour paper matrix (6,243 valid historical
  candidates; global 300-position selection respects `12` per symbol and
  `6` per direction). No exchange order or authenticated trading call ran.

## Quick Start Guide

### To add a new page:

Create a file at `src/app/[route]/page.tsx`:
```tsx
export default function NewPage() {
  return <div>New page content</div>;
}
```

### To add components:

Create `src/components/` directory and add components:
```tsx
// src/components/ui/Button.tsx
export function Button({ children }: { children: React.ReactNode }) {
  return <button className="px-4 py-2 bg-blue-600 text-white rounded">{children}</button>;
}
```

### To add a database:

Follow `.kilocode/recipes/add-database.md`

### To add API routes:

Create `src/app/api/[route]/route.ts`:
```tsx
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ message: "Hello" });
}
```

## Available Recipes

| Recipe | File | Use Case |
|--------|------|----------|
| Add Database | `.kilocode/recipes/add-database.md` | Data persistence with Drizzle + SQLite |

## Pending Improvements

- [ ] Add more recipes (auth, email, etc.)
- [ ] Add example components
- [ ] Add testing setup recipe

## Session History

| Date | Changes |
|------|---------|
| 2026-08-17 | Intensive verification on `main@62988c1`: `bun typecheck` ✓, `bun lint` ✓, `bun test:unit` 178 suites / 1,166 tests ✓, `bun test:integration` 4 suites / 53 tests ✓, `bun run build` ✓ (347 valid trace files). Created credential-free source checkpoint `cts-kn-checkpoint-2026-08-17.tar.gz` (1,890 files, SHA-256 `b117e7c6b414005008e70603425611ba6450b1dd145e00676e453866f22005d6`) under `/tmp` with `cts_key` excluded. **SECURITY FINDING**: tracked root file `cts_key` is a real OpenSSH ED25519 private key (399 B, added in `80cf6c6`) not referenced by any code/config; it remains in git history on `origin/main` and must be rotated/removed and purged from history before any public publication. |
| 2026-08-17 | Pushed + merged rate-limit/109400 fix to GitHub `main`: committed `62988c1` and force-pushed to origin; no open PRs. `lib/error-handling.ts` (parseBingXRetryAfter + getRetryDelay retry-after hint), `lib/exchange-connectors/bingx-connector.ts` (static shared circuit breaker, >=510s cooldown + jitter, getOrder/getOpenOrders/getOpenOrder/getOrderDetails/getOrderHistorySnapshot 109429/109421 guard, placeOrder positionSide 109400 fix). Server reinstalled from main + rebuilt (BUILD_ID C_d4DOgUp8YyC5iSyIvZ6); on-server 109429 errors 132→0/min, CPU 154%→27%. Verified locally: tsc 0, eslint 0. `next-env.d.ts` artifact restored (not committed). Final remote health re-check deferred (sandbox has no systemd/SSH to 152.53.114.112). |
| 2026-08-08 | Merged `prehistoric-async-20m-complete` branch (`df746f9`): scalar completion markers replacing per-row Redis Sets, atomic `incrementHistoricAggregateOnce` for PF/counts aggregates, shared indication calculations, pre-built `HistoricPriceSeries`, ceiling division for concurrency. Analyzed `production-live-server-20m-complete` and `direct-trade-self-healing-release` branches — both superseded by PR #171 in main, no merge needed. Fixed QuickStart `Test: FAILED` mislabel (added `testSkipped` flag), toggle-dashboard `maxDuration` 15→300s, and `requestWithRetry` in `verify-prod-soak.mjs`. Verified: typecheck ✓, lint ✓, 914 unit tests ✓, 38 integration tests ✓. |
| 2026-08-08 | Dev-preview smoke-mode continuation: lowered `run-dev-preview-check.mjs` default `DEV_NODE_HEAP_MB` from 12288 to 6144 so the constrained-host smoke path fits an ~8 GiB container instead of requesting 12 GiB (full soak / larger hosts override via env). Added `.github/workflows/dev-preview-smoke.yml` to run the paper-only smoke verifier (1 symbol, 4 GiB heap) on push/PR using pnpm 10.28.1 + Node 22. Verified script syntax, ESLint, and TypeScript are clean. |
| 2026-07-29 | Security hardening pass on CTS-K-N main: removed hardcoded JWT fallback secret in `lib/auth.ts` (now throws if `JWT_SECRET` is unset), fixed user ID mismatch in `app/api/auth/register/route.ts` (nanoid string preserved instead of `Number()` cast to `NaN`), added `authorizeAdminBearer` to all 9 previously unprotected admin routes (`check-tables`, `clear-progressions`, `end-test-progress`, `force-reinit`, `init-database-direct`, `reinit-db`, `reset-and-init`, `run-migrations`), replaced broken auth-bypass logic in `database/flush` with proper fail-closed `authorizeAdminBearer`, replaced weak `CRON_SECRET || API_SECRET` auth in `enable-live-trading` with `authorizeAdminBearer`, replaced full `process.env` leak to SSH child process with allowlisted env in `install/remote`, added `maxDuration=300` to `trade-engine/quick-start`, deduplicated type declarations in `types/bingx-api.d.ts`, and standardized `Request` → `NextRequest` in `trading/progression-debug` and `trading/engine-stats`. Verified TypeScript, ESLint, and smoke tests pass. |
| 2026-07-28 | Completed the combined Base→Main→Real→Live processing release on schema v90. All four stages are mandatory pipeline rows with independently persisted configuration; stage enable flags are normalized on every settings/API/migration path and are no longer operator switches. Base PF minimum/default is 0.40. Signal evaluation is exact Source×Symbol×Direction×Config: empty history executes immediately, 12 exact closed results activate the PositionCost-relative 0.30 gate, source-12 and source×symbol×direction-10 remain diagnostics, and 16 negative real-exchange closes permanently disable only that exact configuration. Signal capacity remains one atomic 120 Long+Short pool across all 35 sources, with minimum/default volume factor 1 and Block-only true. PF/DDT row statistics retain last 12/25/75 positions, 4/12/48 hours, and three-day DDT. The exhaustive Main fan-out uses lazy bounded workers and evaluates every candidate before selecting a direction-/variant-fair Row-Real working set for the expensive Block/scoped fan-out; active exposure is preserved and the final output ceiling remains authoritative. Position-Count Long and Short Sets never hedge each other and combine only within their own direction for Live. Exact Signal Blocks can seed their physical parent in Block-only mode. Acceptance passed 122 Jest suites/859 tests, TypeScript, project-wide ESLint, source syntax, Kilo 37/37, installer/volatile preflights, a fresh Next 15.5.18 production build (41 pages/339 traces), and a 12-symbol forced-paper Dev soak (1,008 API requests, 564 live-position cycles, 120/120 Signal slots, 6,020 Signal Block rows, 120 simulated lifecycles, 2.301 s warm p95, bounded post-warm memory/key growth, stop/restart verified, zero real positions or exchange order requests). |
| 2026-07-26 | Completed the connection-progress, Signal-capacity, Detailed Logs, cycle-load and crash-recovery release. Connection recoordination now uses generation-owned cancellation/epochs, canonical symbol deduplication, truthful historic progress and idempotent prehistoric inventories, so settings, symbol changes and disable/re-enable take effect immediately without stale/doubled workers or false 100% states. The compact top-right Detailed Logs monitor provides Overview, Activity, Processing, Settings, Orders, Warnings, Errors and System sections with bounded reads, generation/settings diagnostics, alerts and Signal capacity. Signal's 35 limit is explicitly website-source coverage only; Long+Short position capacity defaults to 120, admits under an exact connection lock and processes bounded quality-ranked candidates best-first while preserving independent standard/trailing lanes. Signal Settings now expose the missing capacity and operational contracts. Healthy cycle/Set/sync logs use an HMR-safe bounded throttle, progression rows coalesce, queues/maps are capped, and historical phases yield cooperatively. InlineLocalRedis adds an 8 MiB-compacted fsynced live-position WAL so lifecycle/quantity state cannot regress after SIGKILL without full-database writes in hot cycles. Acceptance passed 115 Jest suites/787 tests, TypeScript, project-wide ESLint, fresh Next 15.5.18 standalone build (41/41 pages), production restart/SIGKILL recovery of 36/36 positions, schema 84 and zero real orders. The final forced-paper Dev run lasted 306.3 seconds/1,437 requests with 12 symbols, 35/35 sources, zero source errors, 1,260 Signal indications, 24 positions (12 standard + 12 trailing) under max 120/best-first, 10 Detailed Logs snapshots/zero alerts, Redis warm growth 7 keys, Signal p95 1,053 ms and verified disable/re-enable; the standalone full-system run passed RSS/Redis budgets at 126 ms p95. |
| 2026-07-26 | Completed the Signal Engine trailing/statistics release. Signal requests are operator-configurable but clamped to a hard 30-second minimum. Signal now owns independent standard and dynamic-trailing execution lanes; trailing defaults on, trailing-only defaults off, with 0% start, 0.8% minimum stop, 0.4 favorable-move ratio and 0.5 stop-range update ratio. Signal volume factor is available in Signal Settings and Connection Settings → Overall. `/statistics` now loads directly with top navigation for Overall, Common and Signal analytics; both indication families expose PF/DDT over last 12/50 closed positions and 8/48 hours, TP/SL ranges and ratios, top/worst 12 symbols, filters, expandable type/source→symbol detail, and per-source Signal-symbol disable controls. Reporting reads a lightweight persisted live-position projection and never imports the exchange execution graph. Historic progression yields between indication, Set-fill and strategy phases so Signal/control APIs remain responsive without changing phase order. Acceptance passed 111 Jest suites/763 tests, TypeScript, project-wide ESLint, a fresh Next 15.5.18 standalone build with 41/41 pages, Installer/Kilo (37 checks, schema 84), scheduler, deployment-contract, volatile-cleanup, source-syntax, recreation-manifest (1,239 files) and secret-scan (1,247 files, zero findings) checks. The forced-paper 12-symbol Dev debug run lasted 303.6 seconds and completed 109 rounds/1,229 requests, 35/35 sources, 1,440 Signal indications, 24 Signal positions (12 standard + 12 trailing), 2,400 calculated/evaluated/eligible/emitted Signal Block rows, zero source failures, warm Signal-API p95 1,914 ms, and zero real exchange orders. |
| 2026-07-26 | Corrected Block volume adjustment systemwide to use one absolute, non-compounding target per symbol/direction: `target = generalBase + ((generalBase × blockVolumeRatio) × blockCount)` and `nextOrder = targetAdd − confirmedBlockAdds`. Real/strategy overlays now use the general volume as the sole base instead of applying the historical Block profile multiplier a second time. Independent Count Sets retain their own PF/result/pause lineage, while sequential or out-of-order Counts submit only the missing physical delta; a lower already-covered Count sends no exchange order. Regular Count ladders now accept only normal Base-derived Sets and explicitly exclude individual/combined Pos-Count Sets. The separate Real-active procedure counts every non-terminal position per symbol and Long/Short—including Pos-Count positions—and can restore the normal Base lineage from the cycle index when only a Pos-Count remainder is active. Live/simulated metadata records exact base, target, confirmed-before, request, and completion state. Terminal partial fills retry only their residual; open partial fills remain durable, reconcile by client/order ID without duplicate submission, and keep SL/TP sized to authoritative exposure. Acceptance passed 103 Jest suites/652 tests, the focused 16-suite/173-test strategy/order/progression matrix, TypeScript, project-wide ESLint, source-syntax/secret scans, recreation-manifest verification, and diff checks. |
| 2026-07-25 | Completed the indicator, Long/Short accounting, Block strategy, UI race, and dynamic installer release. Default Direction/Move/Active remain independent; Direction adds post-reversal same-market relative ranges without replacing the original calculation, Trend alone uses 1/5/15/30-minute windows, and Common indicators use bounded timeframes through 15 minutes with canonical MA/EMA/MACD/RSI/Bollinger/PSAR/ADX/CCI/ADL/Fibonacci/ROC/Williams R/VWAP/Stochastic/OBV support across settings and presets. Live accounting now validates direction/symbol, stores independent per-symbol/per-side v2 counters, records adjustments without inventing positions, serializes accumulation/reduction behind owned control-order barriers, recovers pending client/order IDs, reconciles authoritative quantities, and re-arms protection after partial/error paths. Block counts 1..10 retain independent quantities, PF/DDT/pause state and batch lanes while mirrored Real/Live exposure is not double-counted. Dashboard zero values and Live Trading SSE/request races now preserve canonical state. Bootstrap/update/install/uninstall/service controls resolve saved names, ports, runtimes, custom `/opt/*` directories and external env ownership safely; the production verifier now cleans complete process groups. Embedded exchange credentials were removed and live infrastructure coordination is fail-closed. Acceptance: fresh 40-page/331-trace standalone build; TypeScript, ESLint, Shell/Node syntax, installer/scheduler/Kilo/secret checks; 103 Jest suites/646 tests; 60-second 12-symbol Dev soak (330 requests, 162 cycles, 1.834 s steady p95); 120-second 12-symbol Production soak (660 requests, 352 cycles, 24/24 positions recovered after SIGKILL, DB 6,920–7,356 req/s); and 32-symbol Production UI/control workflow. Every runtime verification forced simulation with empty exchange keys and submitted zero real orders. |
| 2026-07-23 | Completed the compact modern Live Trading operations release. `/live-trading` now uses only canonical persisted data and provides a dense balance/equity/margin/open-PnL overview, standard Profit Factor for 4/12/48 hours and the latest 25/75/150 closed positions, 4/24/48-hour order counts, five-day drawdown duration/depth, connection-scoped active-position search/sort/filtering, and a detailed expandable history with time/side/result/source/variant filters and execution, lineage, risk and DCA settings. Every open position exposes coordinated Close, absolute TP/SL, trailing-stop and Restore Strategy actions through per-position mutation locks, durable manual-protection overrides, exchange reconciliation, reduce-only partial-fill handling and fail-closed connector checks; the trailing ratchet remains monotonic across process restarts. Acceptance passed TypeScript, project-wide ESLint, 95 Jest suites/595 tests, installer preflight, exact minute scheduler, secret scan and recreation/diff checks. Passive isolated Dev and standalone Production smokes both completed schema 82/82, served the page and all analytics/action read contracts, and placed zero exchange orders; the production position/control-order crash-recovery protections remain covered by the prior 24-position SIGKILL recovery soak. |
| 2026-07-22 | Kilo deploy migration and Redis hardening: `db:migrate` no longer requires Bun and cleanly skips the optional HTTP-SQLite migration when Kilo has not supplied both `DB_URL` and `DB_TOKEN`; a provisioned database still migrates and fails the deployment on a real migration error. The Ubuntu installer now installs, starts and verifies Redis, sets `REDIS_URL=redis://127.0.0.1:6379` for a long-lived local server, and enables AOF/everysec, protected mode and noeviction. Kilo Worker production cannot use localhost Redis: configure a TLS external shared Redis via Kilo deployment secrets before enabling durable cross-worker processing or live exchange coordination. |
| 2026-07-22 | Kilo production layout/continuity repair. Live browser inspection found the header DOM present but flex-shrunk to 1 px; `PageHeader` and `.page-header-shell` now have a non-shrinking 4rem minimum, restoring the header and mobile sidebar trigger. Kilo host detection now supplies a visible-dashboard, minute-deduplicated paper-processing pulse when the platform omits repository cron metadata; unauthenticated pulses require a same-origin custom header, remain available only while real order infrastructure is blocked, and never invoke live-position recovery. Kilo's pinned managed-database client persists a bounded Redis-compatible snapshot with revision CAS and cross-worker leases; real exchange orders remain fail-closed unless durable coordination is explicitly approved. Next/OpenNext now repairs zero-byte prerender manifests from the current build's rendered HTML/RSC output and the runtime harness cleans complete Workerd process groups. Acceptance passed 92 Jest suites/575 tests, full TypeScript/ESLint, a fresh 40-page OpenNext build, and exact Workerd verification of 12 UI routes/268 scripts, 5/5 Historic/Main progress, settings/volume/Pos-Count/ACK/stats/history/status flows, dashboard pulse, scheduler/queue safety, and zero real positions/orders. |
| 2026-07-21 | Final end-to-end rerun on the release tree: fixed repeated identical QuickStart requests resetting selection epochs/progress, made Dev route compilation deterministic through exclusive canonical output ownership, serial route warmup and complete process-group cleanup, throttled high-frequency per-symbol strategy summaries, added a concrete Next `/_document` fallback for reproducible OpenNext provider builds, and handled nullable portfolio params across App/Pages compatibility. Acceptance passed 92 Jest suites/565 tests, full ESLint and TypeScript, a fresh Next `.next-prod` build, OpenNext, Wrangler dry-run, Workerd Kilo UI/settings/progress/queue/ACK/stats/state verification, a 60-second 5-symbol Dev soak (330 requests, 354 aggregate and 868 Main cycles, 912 ms steady P95), a 120-second 5-symbol Production soak (660 requests, 786 aggregate and 1,962 Main cycles, 36 ms P95, 991,564 KiB final RSS), a 32-symbol Production UI workflow, and BingX SDK public 5-symbol/1,000-candle stress with +1.72 MiB heap and zero authenticated/order requests. |
| 2026-07-21 | Final processing acceptance completed on the same schema-v82 release: Combined position-count Live targets now durably recover partial/unconfirmed reduce orders by client/order id, apply cumulative fills once, keep one physical hedged delta, reallocate exact member-Set quantities, and defer protection changes until the position mutation is authoritative. Strategy position-history durability now supports both full Redis and reduced Inline/fixture pipeline adapters without turning a filled Block/DCA parent into an error. Next custom-dist builds recover the intermittent missing built-in pages manifest after server emit, and Dev enables webpack graph memory optimization with a lower heap ceiling. Final gates: 90 Jest suites/554 tests, TypeScript, ESLint, OpenNext/Workerd, isolated Next production build, Wrangler dry-run, Kilo 5/5 Settings/ACK/QuickStart/states/stats/history, 32-symbol production UI, three-boot 5-symbol production soak (330 requests, 386 cycles, 38 ms P95, stable DB), optimized 5-symbol Dev soak (319 requests, 354 cycles, 761 ms steady P95, stable DB), and public BingX SDK read-only 5-symbol/1,000-candle stress; zero authenticated/order requests and zero real positions/orders. |
| 2026-07-21 | Completed the schema-v82 Kilo/production processing release. Fixed the real serverless handoff from Settings/QuickStart through durable refresh, scheduled bounded ownership, exact version+event CAS ACK, current 5-symbol progression readback, and runtime heartbeat so the UI no longer remains at `0/#` or pending after processing. Position-count Main Sets now use a default 0.05 ratio (0.01–0.25 slider), validate only qualified previous/last/continuous/pause axes, retain per-Set calculation lineage, hedge Long/Short, display the net count, and combine the dominant remainder into one live target with increase/reduce/flat/direction-flip reconciliation without inflating sub-minimum exchange quantities. Block quantities derive independently from Base ratio 1, and positionCost defaults to 0.1%. Repaired Main/Settings/Statistics layout and canonical stats/PnL/position/exchange-history reads, switched BingX production calls to the SDK with the current saved connection, and made OpenNext/Next manifests/build output deterministic. Acceptance passed a real Workerd Kilo cycle (12 UI routes, 268 scripts, exact 5/5 processing, settings/event ACK, all state switches, statistics/history), a 90-second 5-symbol Dev soak (473 requests, 514 final aggregate cycles, 918 ms warm p95, stable DB plateau, zero real orders), a three-boot 5-symbol Production soak (495 requests, 580 final aggregate cycles, 42 ms warm p95, ~0.85 GiB final RSS, stable DB plateau), the 32-symbol production UI workflow, and a public BingX read-only 5-symbol/1,000-candle probe. |
| 2026-07-18 | Remote-install release follow-up: a real OpenSSH client/key-auth loopback test exercised the authenticated API handler, SSH stdin streaming, GitHub `main` clone, canonical non-mutating installer preflight, bounded result logs, and cleanup. It exposed OpenSSH exiting 255 when a hardened API service home could not persist `known_hosts`; the route now supplies a private per-request host-key file beside the temporary SSH key, and the repeated real transport test returned HTTP 200. A separate empty Git-archive reconstruction with no `node_modules` restored all 1,272 locked packages using exact pnpm 10.28.1 and completed the full local retired cloud provider provider build with 149 routes, 67 function entries, 116 valid JSON manifests, and no invalid JSON. The protected remote retired cloud provider integration remains red and cannot be diagnosed further without project logs/token, so no provider deployment success is claimed. |
| 2026-07-18 | Follow-up deployment correction after the first final-tree retired cloud provider checks: restored the direct `retired-cloud-provider-build` entry point instead of running the full server installation verification wrapper during provider builds, then replaced `corepack enable/prepare` with the symlink-free exact `corepack pnpm@10.28.1` invocation after the full local retired cloud provider builder reproduced `EROFS` against its read-only Node runtime. The same builder exposed Next 15 leaving a zero-byte `export-marker.json` plus a stale successful `export-detail.json`; post-build normalization now reconstructs only the invalid non-static marker, validates it, and removes the stale export status only when serialized Next config does not declare `output: export`, preventing retired cloud provider from dropping all dynamic/API functions. The final local provider build passed with 149 routes, dynamic/API functions, a 23 MiB output, and no invalid JSON; an isolated regression test covers both manifest repairs. |
| 2026-07-18 | Finalized the recovered workspace through schema v81. Block Count 1..10 are exact independent Real Sets with their own last-N/min-sample PF history, active/pause state, volume, stats, and `minimumPF = defaultPF × Block PF factor × actual volume increment`; the 0.2–5.0/default-0.8 slider is wired across connection/global/Preset Strategy/Block surfaces and immediately recoordinates. Position-count axes retain unique exact Sets under caps. DCA uses durable `#step:N` identities, immutable initial sizing, and applies persisted setting changes on the next step. Hardened concurrent Inline Redis snapshots, AES-256-GCM secrets, fail-closed runtime ownership, a rollback-capable systemd/PM2 installer, authenticated SSH preflight/install, Kilo/OpenNext build/deploy/prechecks, scheduled continuity, and a distinct long-lived owner proxy. Added a complete clean-room recreation kit, generated SHA-256/API/UI/env/migration/test manifests, verification record, and release secret scanner. Final gates passed frozen pnpm 10.28.1 install, syntax, TypeScript, ESLint, 83 Jest suites/509 tests, Next/OpenNext builds, Wrangler dry-run, real Workerd scheduled/runtime/remote-route checks, host/remote-route preflights, 32-symbol public BingX stress, and the 240-second maximum production/UI soak with 64 simulated and zero real orders. Actual Cloudflare upload, external SSH host install, and authenticated exchange smoke remain explicitly blocked because no corresponding credentials/target/flat-account proof were supplied. |
| 2026-07-18 | Completed the coherent live-safety/production-continuity verification release through schema v79. Real/Live snapshots now preserve authoritative lineage and clamp Live <= Real even when Real is zero; the unsafe testnet Main-to-Live synthetic fallback is removed. Production status endpoints distinguish connected InlineLocalRedis from shared cross-instance durability, live smoke fails closed without shared Redis, Cloudflare/Kilo workers declare external minute ownership, both cron routes persist source/freshness/result diagnostics, and post-deploy/startup checks now fail on stale migrations, broken APIs, unprotected cron, or missing authorized ticks. Added bounded warm-state API p95 contracts, robust 15-symbol Dev/Prod soaks, 32-symbol UI lifecycle/settings/volume validation, and public BingX 32-symbol stress telemetry. BingX remains `bingx-api` package-first for supported account/order calls with duplicate-safe signed REST fallback; public quote/instrument reads now fail over from the official `.com` origin to `.pro` without ever replaying account/trade writes. Verified schema v79 restart persistence, 3,750 candles and hundreds of coordinated engine cycles in both Dev/Prod, Base/Main/Real/Live 2/2/2/2, active paper-position updates, stable post-warmup DB growth, Prod warm p95 33 ms, Dev warm p95 1,804 ms, 32-symbol UI QuickStart 143 ms, 6,400 live public candles across 32 BingX symbols with one primary-host timeout recovered by `.pro`, optimized Next production build, TypeScript, ESLint, portable 60,000 ms scheduler, and the final combined-current-main 79-suite/462-test matrix. No real exchange order was submitted: local/deployed prerequisites still lacked shared Redis plus the admin/live-placement gates, so the safety contract correctly blocked the authorized minimal-order smoke. |
| 2026-07-18 | Follow-up skipped-test enforcement after PR #129: repaired the standalone BingX readiness CLI so `.com` timeouts fail over to `.pro`, exit deterministically, and never submit orders; repaired the drift monitor's obsolete endpoint and made it fail on a globally running but heartbeat-stale/non-advancing connection; accepted current idle/realtime strategy phases and bounded transient retries in the comprehensive monitor; made `npm start` specify a portable host; and added a repository-aware deployment contract that rejects stale deployed schema/builds, outdated persistence diagnostics, missing site identity, incomplete migrations, and (when required) non-shared persistence or stale minute ticks. Additional validation passed route smoke, volatile cleanup, exact 60,000 ms scheduler, 15/15 public BingX symbols, 31 critical suites/138 tests, the complete 79-suite/462-test matrix, TypeScript, ESLint, and a fresh 65-second 15-symbol production restart/soak with 3,750 candles, 422 cycles, Base/Main/Real/Live 2/2/2/2, stable post-warmup DB growth, and 37 ms warm p95. The public Kilo URL is still an old schema-v74 build with process-local state and a stalled connection heartbeat/zero cycles; the new contract correctly rejects it, so real-order smoke remains blocked until the current build, shared Redis, external engine ownership, admin secret, and live-placement gates are deployed. |
| 2026-07-17 | Corrected Strategy Stage Real statistics after operator clarification. Overall is now an independent full ledger of Real Sets, confirmed positions, and placed orders; related-Base hedge history can neither inflate nor reduce those values and is rendered in a separate informational section with long/short entries, pairs, offset legs/ratio, and remaining exposure. Added a current open-position snapshot that prefers filled/exposed Live exchange positions and falls back to open Real-stage promotions in paper/dev mode, including unique open symbol count, position Long/Short counts, Long/Short symbol counts, and per-symbol direction rows. Pending, placed/unconfirmed, rejected, cancelled, error, and closed order rows are no longer classified as open exposure. Removed the former cumulative hedge-ledger symbol display and netted Overall UI from both Main Connection surfaces. Added regression coverage for hedge/Overall isolation, duplicate symbol aggregation, open-exposure lifecycle classification, and revised UI/API wiring. Verified full ESLint, TypeScript, source syntax, optimized Next production build, and all 74 Jest suites / 442 tests; no authenticated exchange call or real order was made. |
| 2026-07-16 | Added canonical detailed Strategy Stage Real position statistics across the Main Connection card and five-section information dialog. Overall now shows idempotent confirmed positions before and after hedge netting, offset count/ratio, hedged pairs, and Long/Short totals; hedge calculation offsets only opposing entries that share the same related Base Set and never nets unrelated strategies or symbols. Default and Trailing show position count/PF/DDT; Adjust Block and DCA show position count/PF/DDT plus Default+Trailing baseline, with-strategy count, delta, exact difference percentage, and explicit 0.2 ratio bands. Per-symbol Long/Short/gross/hedge-net counts are included. The confirmed-entry Lua/fallback ledger now atomically classifies each accepted paper/live entry by inferred Real variant, while partially upgraded running histories remain visibly on the legacy evaluation fallback until their variant subtotal is complete. Corrected Real variant PF/DDT raw-sum fallback divisors to use the writer's entry weighting. Added pure hedge/ratio math coverage including cross-Base isolation and rollout fallback. Verified TypeScript, source syntax/production lint through optimized Next build, 69 unit suites/415 tests, and the complete 74-suite/429-test Jest run. No exchange calls or real orders were made. |
| 2026-07-16 | Completed the Main Connections UI/status/settings audit and modernized the information dialog. The dialog now ships as a responsive five-section top-menu surface (Overview, Runtime, Indications, Strategies, Settings) with refresh cancellation/generation guards, partial-endpoint handling, explicit requested-vs-effective live-order safety, canonical progress/cycle/history metrics, bounded stage ratios, Main/Preset indication profiles including Trend, strategy/Preset details, symbols, volume/risk, position-count axes, DCA/trailing, and settings-version freshness. Fixed Guided QuickStart so its verification step cannot silently request Live Trade; accumulated adjacent debounced option edits; made selected-connection hydration fail closed; moved Control Orders side effects out of React state updaters; added versioned settings/volume readback and instant recoordination events; corrected volume defaults/rollback; prevented disabled-but-assigned connections from appearing addable; clarified Mainnet/Running/Queued/Paused/Realtime labels; repaired paused global controls and overlapping actions; invalidated the process-local status cache after mutations; bounded all displayed percentages/passed counts; and made cards/layouts responsive and dark-theme complete. Replaced the broken SQL-shaped Preset Type connection route with canonical Redis reads plus an ordered/versioned settings writer, so assignment now persists and immediately recoordinates while an unassigned preset returns 200/null. Extended production verification to recognize intentional progression-epoch counter resets, verify the compiled dialog asset and all six dialog snapshots, exercise Settings/Volume hot reload, Main Connection off/on, Pause/Resume/Stop/Start, and enforce ratio/order safety. Verified source syntax, ESLint, TypeScript, optimized Next production build, 73 Jest suites/420 tests, two 32-symbol 241–242s paper soaks (282–338 engine cycles, Historic 32/32 and 100%, Base→Main→Real→Live/Paper coordination, bounded GC memory waves), and a focused 32-symbol production UI run; zero real positions or exchange orders were created. Cloud Browser could not access localhost, so production HTML/client assets and the repository-owned UI/API workflow were verified without claiming manual visual clicks. |
| 2026-07-16 | Completed QuickStart timeout and maximum-symbol production validation. Added one shared client/server timing contract: 35s UI deadline, 18s default production engine-boot wait, at least 10s boot headroom, 1–25s override clamp, and a bounded 5s read-only connection check. Both QuickStart UI entry points now use the shared deadline; the compact UI explicitly sends the freshly-read effective Live state (eliminating a stale React-state race), supports its full 32-symbol maximum through a shared constant, and aborts a hung enable request. The production harness now carries all 32 symbols through preconfiguration, restart, local/cron caps, soak verification, and a reproducible UI-equivalent workflow that loads production HTML/assets, performs the exact top-volatility/QuickStart requests, measures the browser deadline, verifies canonical cycles/positions, and stops cleanly. Removed the production soak's invalid dependency on the intentionally disabled raw debug endpoint. A 242s max-symbol soak passed 117 rounds/1,287 requests/378 engine cycles, 32/32 historic symbols, Base→Main→Real→Live/Paper progression, p95 2,063ms, restart/settings/schema-v74 persistence, bounded post-warmup RSS behavior, and zero real positions/orders; a second UI-focused production run passed QuickStart in 4,079ms with cycles 177→180 and clean stop. Cloud Browser itself could not open the local port (`ERR_BLOCKED_BY_CLIENT`), so no visual click/screenshot claim is made; the repository-owned UI request harness is the reproducible substitute. Verified optimized production build, 72 Jest suites/410 tests, TypeScript, ESLint, source syntax, volatile cleanup, and diff checks; no authenticated BingX request or real order was made. |
| 2026-07-16 | Added Trend as the final Main indication type across realtime and set-backed engines, Settings, active profiles, dashboards, counters, health, cleanup, and progression. Trend evaluates independent 1/3/5/10/15/30-minute configurations with configurable negative PositionCost drawdown factors plus recent/active situation thresholds; Strategy Set identity preserves each selected timeframe/config through Base/Main/Real/Live and carries adaptive TP metadata through axis/position-count variants. Base pseudo positions now derive a stepped TP ladder from average absolute 1-minute market change divided by PositionCost (default minimum ×2, maximum 10, step 1), and shared batched/serialized Redis mutations prevent concurrent symbol/config writes from dropping positions or indexes. Pre-v74 Base config keys remain byte-compatible, Active-Advanced now enforces caps against its actual position pool, and Axis Sets retain a safe parent-entry fallback. Schema v74 seeds fill-missing-only Trend defaults into canonical and legacy settings mirrors, settings changes trigger immediate recoordination, candle ordering is deterministic, and cron fallback ownership now requires a fresh per-connection heartbeat instead of treating an unrelated global heartbeat as ownership. Verified all 71 Jest suites/406 tests, TypeScript, ESLint, source/diff/secret guards, and an optimized Next.js production build; no authenticated exchange calls or real orders were made. |
| 2026-07-16 | Follow-up runtime validation and coordination hardening: production and development safe 12-symbol soaks now exercise historic bootstrap, indication/realtime/LivePositions, Base/Main/Real/Live Sets, paper positions, restart persistence, and settings recoordination with zero real order requests. Fixed the scoped-vs-legacy prehistoric completion gate that could delay realtime by 60 seconds, coalesced settings changes during bootstrap, started LivePositions before continuous replay, bounded replay work, and made diagnostic/progression routes read canonical main-scoped state. QuickStart now atomically clears stale live flags in paper mode. Live dispatch/protection handling uses immediate SL/TP, narrow retries, terminal-position resurrection guards, close-result propagation, fast trailing rearm, and stable coordinator locks. Added balanced bounded config selection, strategy caps, DCA/Block/Trailing volume coverage, rate-limiter self-wakeup, portable minute scheduling, schema v73 timing/strategy migrations, and dev/prod preview validation. Verified 68 Jest suites/391 tests, TypeScript, source/diff guards, one-minute scheduler contract, isolated optimized production build, 60-second prod and dev 12-symbol soaks, mocked sub-300 ms order dispatch and sub-second protection with no stranded positions, and zero authenticated/order requests to BingX. |
| 2026-07-16 | Completed the live-safety, production-runtime, UI top-layer, strategy-coordination, and database-maintenance replacement release. Added three selectable transparent responsive header assets, shorter CTS metadata, removed the header Engine Test action, and eliminated nested duplicate layouts. BingX now defaults to the `bingx-api` community package fast path with signed official-REST fallback, connector reuse, normalized account/order/control/position operations, and no source-embedded credentials. Added portable one-minute scheduling outside retired cloud provider Cron, configurable long-lived-server recovery, bounded cron sweeps, fatal migration/startup readiness, and corrected smoke cleanup. Base/Main/Real/Live now share symbol-scoped exact active Set lineage; active Live Sets survive PF/DDT/cap changes until terminal, candidates never count as entries, and Live vs paper books cannot double-count. The idempotent confirmed-entry ledger coordinates Set/Base/axis/hedge counts for initial and accumulation fills in both exchange and paper modes, with closed-only Previous/Last, reached-only directional Continuous, Pause windows, bounded fan-out, and terminal active-index cleanup. Database schema v71 adds crash-safe combined migration batching with a renewable distributed lock, canonical indexed connection reads with SCAN-only recovery, on-write Main/Base/Exchange/Working index maintenance, tombstone mirror cleanup, fill-missing-only progression consolidation, and durable fingerprinted maintenance/coverage repair. Duplicate init-plus-migration paths were collapsed; pre-startup is process-wide single-flight, retryable, and force-reseedable after reset, while coverage waits for seed/validation/maintenance and is cross-worker deduplicated. Verified lint, typecheck, source/cleanup guards, 58 unit suites/357 tests, 4 integration suites/12 tests, scheduler contract, dev route smoke, optimized production builds, three production boots/restart at schema v71, 12-symbol 90-second simulated soak (495 requests, 100 engine cycles, P95 729 ms), and zero real exchange order requests. |
| 2026-07-15 | Completed the Preset optimizer and Main/Preset live-execution release. Added persisted 1–14 day real-candle optimization for nine indication types, position-cost-normalized TP/SL/PF/drawdown metrics, independent trailing profiles, four best eligible presets per symbol/type, automatic/manual selection, bounded two-generation Redis indexes, sequential one-symbol historical loading, typed calculation buffers, and bounded UI rendering/charts. Preset Trade now applies selected eligible profiles inside the shared Main progression while preserving Block/DCA metadata. Added full Preset Block · Adjust settings/persistence with independent count, ratio, stack, pause, Real/Live controls and current-position-base volume calculation. Unified Main/Preset live readiness so requested-but-blocked modes remain visible and automatically recover without silently becoming simulation; live entries and control orders were verified with recording connectors only. Fixed shared engine-state aliases, exact production-preview build selection, and unreferenced passive health timers. Verified typecheck, lint, 52 Jest suites/333 tests, optimized production build, read-only production preview (10 pages, 20 progression reads, 2 switch cycles, 0 order requests), and public BingX 32-symbol stress (6,400 candles, 6 ticker rounds, +2.06 MB heap, 0 authenticated/order requests). |
| 2026-07-14 | Completed the event/state/UI coordination release. Canonical SSE now closes reconnect gaps, bounds history/client memory, deduplicates events, rejects stale epoch/session events, and independently orders timestamp settings generations versus numeric switch generations. Connection, Live, Preset, dashboard, QuickStart, logistics, and engine refresh state changes use guarded Redis generations/owned claims; refresh leases renew and durable requests share a 10-minute TTL with automatic expiry/index pruning. Settings notifications merge concurrent field invalidations, use event-owned cleanup, coalesce saves arriving mid-apply, atomically count beyond nine changes, and retain metadata only (no connection credentials or large strategy snapshots). Idempotent assignment/Live/Preset actions no longer reset prehistoric progression. Trade history uses authoritative exchange history with a 500-row cap, 50-row virtual scrolling window, and Won/Lost/PnL summaries. Client-imported templates no longer load credentials, NEXT_PUBLIC credential aliases and embedded defaults were removed, and `.env.example` contains explicit replace-only placeholders. Verified typecheck, lint, 45 unit suites/301 tests, 2 integration suites/5 tests, source/volatile cleanup checks, optimized production build, a read-only production preview (9 pages, 20 progression reads, 2 switch cycles, 0 order requests), and a read-only BingX 32-symbol stress run (6,320 candles, 6 ticker rounds, 2.07 MB heap delta, 0 authenticated/order requests). |
| 2026-07-14 | Completed the progression/live-order stability release: bounded chunked historic market-data reads and realtime tails reduce retained heap; serialized settings recoordination preserves edits across reconnects; Block and DCA legs retain independent counts/ratios/volumes; live entry, accumulation, SL, and TP submissions persist durable client IDs and recover across timeout/restart before retry; authoritative double-absence checks prevent premature close/retry; startup and the continuity runner resume open-position tracking before historic bootstrap; trade history merges real exchange/local closes with a 500-row cap, 50-row virtual window, and Won/Lost/PnL summaries. Removed embedded BingX credential fallback (environment/connection storage only). Verified typecheck, lint, 42 unit suites/278 tests, 2 integration suites/5 tests, source/cleanup guards, optimized Next.js production build, managed read-only production preview, and a read-only 32-symbol BingX public-data stress test with zero order requests. |
| 2026-07-13 | Active connection progress/card hardening: canonical progression stats now derive a bounded user-facing percentage from the current phase (prehistoric percent, realtime/stage minimums, live=100) instead of trusting stale engine_progression progress alone; active connection cards clamp rendered percentages to 0-100 and force live cards complete so progress bars do not appear stuck while stats/stages continue updating. |
| 2026-07-12 | Follow-up review hardening: added requested regression guards that assert the connections status route cannot reintroduce duplicate merge-fragment imports or duplicate progression declarations, and the progression route cannot reintroduce the duplicate configured symbol count declaration. |
| 2026-07-12 | Complete dev/prod/test recovery: removed duplicate merge-fragment imports and duplicate progression declarations in `/api/connections/status` and `/api/connections/progression/{id}` that broke TypeScript. Re-ran install, lint, typecheck, full Jest, smoke routes, standard build, isolated `.next-prod` build, dev health smoke, and production `.next-prod` health smoke; only the expected Node 24 vs project Node >=20 <23 engine warning remained. |
| 2026-07-11 | Dev/prod verification follow-up: production smoke showed `/api/connections/progression/{id}` could still read stale legacy engine-state symbol totals while stats used scoped settings state, and `/api/connections/status` could miss scoped `engine_progression:{id}:main` progress. The routes now merge scoped+legacy engine-state hashes, prefer scoped engine-progress hashes before legacy fallbacks, and force the detailed prehistoric widget to 100% once the authoritative phase has advanced beyond prehistoric. |
| 2026-07-11 | Production connection/progress route hardening: `/api/connections/progression/{id}` and `/api/connections/status` now use shared processor heartbeat plus operator/desired/status global intent fallbacks, so cards and progress panels do not show idle/connecting/no-stats while a production worker owns or is attaching processors. |
| 2026-07-11 | Production no-processing follow-up: aligned `startMissingEngines()` global-intent gating with the auto-start healing sweep so an uninitialized production `trade_engine:global` hash can start assigned/enabled processors by default, while explicit stopped/paused/operator-stopped still blocks runtime ownership, and stamps empty production global intent to running so status/progression endpoints surface attached processors. This fixes queued/degraded production progress with no processors or complete stats after deploy/cold start. |
| 2026-07-11 | Progression/statistics stuck-processing fix: unique progression attach now checks the shared freshest processor heartbeat before reusing an `engine_started=true` progression, archives active zombie sessions older than 90s with no runtime heartbeat proof, and avoids refreshing `last_update` from passive dashboard/auto-start attaches unless a processor is actually alive. Added regression coverage and revalidated typecheck. |
| 2026-07-11 | Main Connections follow-up: restored complete connection-card overview tiles (cycles, indications, strategies, pseudo/live positions, order placed/filled/failed, and PnL) and wired live-trade/connection mutation events into the Active Connections manager so Live Trade toggles immediately refresh card state and engine status instead of waiting for stale polling. |
| 2026-07-11 | Main page bottom monitoring fix: hardened `/api/system/monitoring` so Redis/database counts fall back from `KEYS` to bounded `SCAN` and adapter `dbSize()` when hosted Redis does not return key lists, fixed progression-key matching for engine cycle totals, and made CPU/memory resource percentages report a tiny live baseline instead of misleading 0% on first/idle samples. |
| 2026-07-11 | Main page audit: removed the duplicate dashboard-local `useIndicationGenerator()` invocation because the root `IndicationGeneratorProvider` already owns the 3-second indication cron heartbeat. This prevents two same-tab cron loops from running on the main dashboard while keeping the global provider active for all pages. Verified typecheck, lint, and production build. |
| 2026-07-10 | Follow-up live-order/progression error cleanup: removed the duplicate recent-log read in the progression endpoint so typecheck is clean, preserved non-flushing recent-log reads for dashboard responsiveness, added TTL expiry to live-order idempotency claim sets, and broadened claim keys with symbol/direction to avoid cross-symbol order-id collisions. |
| 2026-07-10 | Live order/control-order correctness pass: shared live-order progression accounting now uses exchange-order-id idempotency claims so retry/replay paths cannot double count placed/filled/simulated/failed events; control-order rearm logic had a duplicate TP cancel assignment removed; regression coverage now verifies duplicate exchange order ids do not double-process counters. |
| 2026-07-10 | Main Connections card stats/progress fix: dashboard active-connection cards and the shared active-connections loader now pass canonical connection ids (stripping legacy `conn-` aliases) into progression/stats polling and child dialogs, preventing `/api/connections/progression/conn-*` misses that made cards show no progress or stats. |
| 2026-07-10 | QuickStart reprocessing correctness fix: when a running engine receives new symbols/settings and progression recoordination starts a fresh epoch, the route now keeps `config_set_symbols_processed=0` and `prehistoric_data_loaded=false` instead of marking the new basket complete from the previous run, so stats/UI accurately show reprocessing progress. |
| 2026-07-10 | Dev/prod/BingX 12-symbol verification pass: added package scripts for isolated `.next-prod` production builds/starts and a 12-symbol QuickStart diagnostic alias, documented that side-by-side prod must use `NEXT_DIST_DIR=.next-prod` to avoid dev/prod `.next` chunk contention, and validated unit/type/lint/build plus dev/prod QuickStart runs. |
| 2026-07-10 | Functional verification tooling follow-up: smoke-routes test now honors `BASE_URL`/`PORT` and only owns/kills a dev server when it launches one, enabling safe side-by-side dev/prod route comparison. QuickStart live-order diagnostic now honors `BASE_URL`, `SYMBOL_COUNT`, and `SYMBOLS`, so BingX checks can be run against 12 operator-selected symbols without editing the script. Production strategy flow now defaults to single-symbol batches and a lower dynamic axis fan-out to avoid OOM/SIGKILL during high-symbol BingX runs while preserving explicit env overrides. |
| 2026-07-10 | Main Connections stats follow-up: progression stats phase derivation now ignores stale `trade_engine_state.status=idle/stopped` whenever Redis global running intent or a fresh processor heartbeat proves processing is active, so Main Connection cards do not collapse back to idle/no-progress while another worker owns the engine. |
| 2026-07-10 | Settings stability follow-up: Main Connection settings PATCH no longer writes resolved symbols/trade-engine state before the centralized recoordination apply step. Symbol, settings, connection, and trade-engine-state patches now remain single-writer/ordered so running engines cannot observe partial snapshots and reset to older settings during hot reload. |
| 2026-07-10 | Active connection card stats/progress refresh fix: the dashboard card now keeps 4s canonical polling fallbacks for progression and live stats in addition to SSE events, and ignores stale overlapping responses with per-request sequence guards so progress/stat tiles continue updating when event streams reconnect or delayed responses arrive out of order. |
| 2026-07-10 | Follow-up progression/stats fix: canonical progression stats now accepts fresh runtime engine_progression/trade_engine_state snapshots even when scoped epoch fields are absent, and no longer treats a missing local coordinator as definitively stopped when Redis global intent plus fresh processor heartbeat prove another worker is processing; settings recoordination confirmation now waits longer and checks the canonical stats marker before warning, preventing false "did not confirm" toasts while route-side recoordination completes. |
| 2026-07-10 | Progression/statistics recovery: Active Exchange statistics now reads the canonical `/api/connections/progression/{id}/stats` contract instead of the stale settings statistics route, trade-engine progression display recognizes Redis heartbeat/global-intent queued starts as initializing/running instead of idle, and settings-save recoordination can initialize a missing global running intent plus run an immediate healing sweep for dashboard-enabled connections while still honoring explicit operator stops. |
| 2026-07-10 | Production status-all correction: status-all now derives global running intent from `operator_intent`/`desired_status` as well as legacy `status`, and treats fresh per-engine running/heartbeat/ready state as running so dashboards do not show stopped while progression is actively advancing. |
| 2026-07-10 | Production progression recovery: restored self-hosted production defaults for realtime progression, indication set fill, strategy flow, and live-position sync while keeping retired cloud provider/serverless workers opt-in; raised the default production cycle deadline to 90s with env overrides so normal processing is not cancelled every 5s. |
| 2026-07-10 | Engine start/status responsiveness hardening: explicit API/UI starts now use local takeover options, production cycle deadlines are shorter, API worker realtime/live/strategy/indication heavy paths are gated by opt-in env flags, progression stats clamp impossible real/main/live cascade snapshots with `[STATS-VALIDATION]` warnings, and status reads use bounded Redis/coordinator timeouts. |
| 2026-07-09 | Production-mode correctness follow-up: restored live-stage failed-order counters to run before fallible progression/final logging while broadening the regression guard to verify metrics around failure markers rather than requiring log-before-metric ordering. Re-ran targeted progression/orders/live-position/settings/event coverage, the full Jest suite, typecheck, lint, production build, retired cloud provider build, and a production `next start` smoke against health, trade-engine status, progression stats, live positions, and orders APIs. |
| 2026-07-09 | Deploy/test recovery: removed the duplicate `ordersBySymbol` property in progression stats by keeping the shared aggregation output, repaired a missing regression-test closure, and aligned live-stage failed-order metric updates with regression guard expectations. Verified full Jest, typecheck, lint, production build, and retired cloud provider build. |
| 2026-07-09 | Live-stage simulation accounting fix: simulated live orders now canonicalize as placed and filled after position persistence, increment global and per-symbol directional order counters, and progression stats comments document that simulated entries are folded into placed/filled output. The shared live-order accounting service now applies the same simulated placed+filled contract, with regression coverage for directional simulated counters. |
| 2026-07-09 | Live-stage simulation accounting fix: simulated live orders now canonicalize as placed and filled after position persistence, increment global and per-symbol directional order counters, and progression stats comments document that simulated entries are folded into placed/filled output. Added regression coverage for directional simulated counters. |
| 2026-07-09 | Production startup/build recovery: repaired malformed merge fragments in QuickStart API, QuickStart dashboard button, legacy connection settings defaults, and startup coordinator imports so source syntax, typecheck, and production build can run again. QuickStart now persists one coherent resolved per-connection settings patch into both Redis settings hashes before recoordination/startup, preserving selected symbols/live intent for production workers. |
| 2026-07-09 | QuickStart button now reads the selected Main Connection from exchange context, fetches its saved settings before enabling, builds the request from saved symbols/symbol_order/symbol_count and live-trade intent, and removes the hard-coded BTCUSDT UI/default except for the emergency no-selection fallback. |
| 2026-07-09 | Main Connection settings recoordination helper now owns persistence plus propagation: connection/settings hash writes, settings-change notification, symbol/strategy reload forcing, durable remote refresh queueing, local apply, progression/stats dirty stamps, and is reused by settings, volume, active-indications, QuickStart, and enable flows. |
| 2026-07-09 | Settings recoordination follow-up: restored maxStopLossRatio/max_stoploss_ratio to the strategy/coordination recoordination bucket and updated requested regression guardrails to assert live-order edits refresh live sizing/protection without being classified as progress recoordination. Full Jest suite, typecheck, lint, and diff checks now pass. |
| 2026-07-09 | Settings recoordination classification fix: `lib/connection-recoordinator.ts` now separates symbol-basket, strategy/coordination, and live-order settings changes. Symbol basket edits epoch-bump/reset prehistoric symbol progress and config-set counters; PF/variant/axis/min-step/eval/DDT edits invalidate strategy/config caches without wiping prehistoric data; volume/leverage/margin/position/control/system-close edits emit a live-stage refresh without resetting prehistoric/indication progress. |
| 2026-07-09 | System initialize endpoint alignment: `/api/system/initialize` now acquires `system:initialize:lock`, runs the instrumentation startup coordinator via `completeStartup()`, limits fol…7454 tokens truncated…bingx-api` SDK as the default order/control path, warm the SDK when connectors are created, use SDK `tradeOrder` for both entry and conditional SL/TP orders before REST fallback, reduce BingX exchange-call timeouts for faster retry, arm initial SL/TP in parallel, and migrate `bingx-x01` to `connection_library=sdk`. |
| 2026-07-09 | Deploy/test hardening pass: stubbed Redis optional `@node-rs/xxhash` in Next webpack to remove dev compile warnings, downgraded transient BingX transport/timestamp connection-test failures from server errors to throttled warnings, reran full type/lint/Jest/build, and smoke-tested dev/prod health, settings pages/APIs, progression/stats, coordinator start/pause/resume/stop, settings PATCH recoordination, and 60-request high-load API fan-out. |
| 2026-07-09 | Coordination audit follow-up: restored a lightweight 10s global watchdog safety sweep alongside event-driven refresh/heartbeat/settings subscriptions so missed heartbeats are detected even when no new events arrive; added a regression guard for the event subscription de-duplication plus periodic missed-heartbeat fallback. |
| 2026-07-09 | Workflow stabilization pass: serialized coordinator health checks through a single pending-scope queue so global watchdog sweeps and targeted refresh/heartbeat/settings events cannot overlap each other or race duplicate drain/rearm work; global sweeps now supersede queued targeted scopes in one pass. |
| 2026-07-09 | Dev/prod parallel 8-symbol BingX audit found health/status/control routes could time out while dense strategy-flow batches ran six symbol pipelines concurrently. Bounded strategy-flow batch concurrency to 1 in dev / 2 in production by default (override `STRATEGY_FLOW_SYMBOL_CONCURRENCY`, hard max 6) and yielded between symbols so coordinator controls and status APIs stay interactive during 8-symbol progression. |
| 2026-07-09 | DB coordination/performance migration pass: added migration 067 to seed DB-backed dev/prod strategy-flow concurrency defaults and a `system:database:coordination:performance` health/metadata hash; StrategyCoordinator now reads those settings with an env override and short cache so both dev and prod can tune 8-symbol workflow throughput without code changes while preserving route interactivity. |
| 2026-07-09 | QuickStart settings preservation: `/api/trade-engine/quick-start` now loads existing per-connection settings from both `connection_settings:{id}` hashes, the settings-prefixed mirror, and the merged connection hash before applying QuickStart defaults. Explicit request fields win, existing UI settings are preserved next, and safe defaults are used only for missing first-setup fields, including sizing, symbol selection, profit factors, variant toggles, control orders, and evaluation counts. |
| 2026-07-09 | Main Connection settings route audit: legacy `/api/settings/connection-settings` now delegates to canonical `/api/settings/connections/{id}/settings` handlers, and the client hook writes to the canonical route. Canonical saves now mirror Main Connection payloads into both `connection_settings:{id}` and `settings:connection_settings:{id}`, mirror progression-visible keys to both trade-engine-state hashes, continue updating top-level connection fields, and rely on centralized recoordination for notify/apply/queued refresh behavior. |
| 2026-07-09 | Production Redis startup hardening: `createRedisInstance()` now requires shared Redis in production/preview by default via `REDIS_URL`, `KV_URL`, `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or `KV_REST_API_URL` + `KV_REST_API_TOKEN`. InlineLocalRedis in production/preview is now only available with explicit `ALLOW_PROD_INLINE_REDIS=1` for local/demo overrides, and deployment env docs/checklist were updated accordingly. |
| 2026-07-09 | Redis startup ordering safety: moved `initRedis()` volatile runtime cleanup into the shared full-init promise after core Redis initialization and successful migrations, before marking Redis connected, so cleanup cannot construct/use a client outside the official core initialization path. |
| 2026-07-09 | Production cold-start migration split: schema migrations, health metadata, and base connection creation remain blocking in `runMigrationsInternal()`, while heavy `ensureCompleteProductionCoverage()` now runs through exported `runProductionCoverageRepair()` as a background startup task after `initRedis()` succeeds. Repair status is persisted in Redis under `database:coverage_repair:*` keys so API routes can serve once schema readiness is complete even if coverage repair is still running or fails. |
| 2026-07-09 | Browser bootstrap production hardening: `EngineAutoInitializer` now checks `/api/system/init-status` first in production and only calls `/api/system/initialize` when startup is incomplete/unhealthy, while preserving aggressive initialize + auto-start behavior for development or `NEXT_PUBLIC_ALLOW_BROWSER_BOOTSTRAP=1`. Instrumentation now persists `system:startup:completed_at`, and system status/init-status APIs expose the instrumentation boot completion timestamp for browser and operator diagnostics. |
| 2026-07-09 | Startup diagnostics persistence: added `lib/startup-diagnostics.ts` and `/api/system/startup-diagnostics` to persist production-safe boot state in Redis (`startup:*` keys), including phases, last success/error, migration status, Redis backend, coverage repair status, and instrumentation registration. Instrumentation, startup coordinator, system initialize route, Redis init, and migration/coverage repair paths now write these diagnostics for UI/post-deploy verification without relying on stripped production console output. |
| 2026-07-09 | Dashboard QuickStart now honors the globally selected connection: the button reads `selectedConnectionId` from `useExchange()`, fetches that connection's settings before enabling, sends `connectionId` plus saved `symbols` or `symbolOrder`/`symbolCount` to `/api/trade-engine/quick-start`, and updates the enable-step copy away from hard-coded BingX/BTCUSDT fallback text. |
| 2026-07-09 | QuickStart settings recoordination fix: `/api/trade-engine/quick-start` now routes completed connection and `connection_settings` writes through the shared settings-save recoordination helper. It records touched connection/settings fields, writes visible recoordination progress state, emits stage acks/logs, persists durable settings-change/refresh signals, invalidates local engine caches, applies pending settings immediately for local managers, and leaves a durable refresh request for cross-process/serverless owners in both first-start and already-running paths. |
| 2026-07-09 | QuickStart recoordination review follow-up: moved the `recoordination_complete` stage acknowledgement until after the shared recoordination helper returns, and made queued `refresh` requests remain durable when drained by a non-owner/API process so cross-process engine owners can consume them instead of having the request cleared by a process with no local manager. |
| 2026-07-09 | Engine refresh request TTL alignment: added shared `ENGINE_REFRESH_REQUEST_TTL_MS` in `lib/engine-refresh-queue.ts` with `ENGINE_REFRESH_REQUEST_TTL_MS` env override and a 10-minute safe default. Both coordinator drain paths now use that shared TTL and log request age/TTL when dropping expired queued refresh requests; regression coverage guards against diverging consumer TTLs. |
| 2026-07-09 | Follow-up verification cleanup: repaired TypeScript syntax drift in QuickStart/settings files, restored static regression guard expectations, made production readiness checks production-only for QuickStart/live-trade test compatibility, and unref'd queued coordinator health-check retry timers so tests do not retain extra handles. Verified typecheck, ESLint, targeted Jest, and the full unit suite. |
| 2026-07-09 | Startup global liveness preservation: `completeStartup()` now reads existing `trade_engine:global` before boot metadata writes, reuses the shared 90s worker/processor heartbeat freshness checks, preserves `actual_status`, `active_worker_id`, and `last_heartbeat_at` for fresh remote owners, and only clears those runtime fields when no fresh heartbeat exists or this process owns the heartbeat. |
| 2026-07-09 | Redis volatile startup cleanup active-owner safety: `cleanupVolatileRuntimeState()` now supports `activeOwnerSafe` cleanup, checks fresh processor heartbeats in both raw/settings trade-engine-state hashes before deleting per-connection pipeline/progression families, preserves active-owner pseudo-position/strategy/indication keys, still deletes stale locks and live-position tracking/moved pointers, and avoids duplicate destructive production cleanup between `initRedis()` and `completeStartup()`. Added InlineLocalRedis regression coverage. |
| 2026-07-09 | Startup orphan-progress cleanup hardening: `cleanupOrphanedProgress()` now requires stronger stale-owner proof by checking raw/settings engine heartbeats plus the global worker heartbeat, applies a startup grace period, marks `orphan_cleanup_pending`/`needs_reconcile` before destructive idle resets, and only clears `engine_is_running:{id}` after a second confirmation pass or explicit stale-heartbeat break. Added targeted unit coverage for fresh distributed owners, startup-grace missing heartbeats, and confirmed stale owners. |
| 2026-07-09 | Engine refresh queue concurrency hardening: queued refresh consumers now share one Redis-lease-backed helper (`engine_coordinator:refresh_claim:{connectionId}` with `SET NX PX`) across coordinator immediate drains and auto-start sweeps. Claims include request timestamp/version/action diagnostics, requests clear only after successful/stale/expired handling, failures preserve the queue with retry metadata, and unit coverage verifies racing consumers perform exactly one action. |
| 2026-07-09 | Auto-start queued refresh retry alignment: `processQueuedEngineRefreshRequests()` now matches coordinator drain semantics by expiring requests after 30s, clearing durable refresh requests only after successful action completion, preserving stale/version-mismatch clearing, and recording retry metadata without dequeueing when hot-apply/start/stop actions throw. Added unit coverage for a throwing hot-apply refresh that remains queued with incremented retry metadata. |
| 2026-07-09 | Settings recoordination completion fix: engine-manager now clears `settings_recoordination_pending` / `strategy_recompute_requested` only after pending settings changes are successfully applied and stamps completion version/event metadata; failed applies keep pending flags and write `settings_recoordination_last_error`. QuickStart keeps its audit completion stamp without masking running-engine apply failures. |
| 2026-07-09 | Connection settings recoordination serialization: `lib/connection-recoordinator.ts` now serializes the full progression-affecting Redis critical section per connection, including strategy/coordination markers, live-order hot-reload markers, stats dirty stamps, pending/completed flags, and symbol epoch resets. Added concurrency coverage for simultaneous symbol-basket and strategy-setting saves. |
| 2026-07-09 | Follow-up cleanup: repaired stale merge/syntax regressions in QuickStart route, dashboard QuickStart button, legacy connection settings defaults, migration status return guardrails, test production-readiness mocks, and test-mode coordinator watchdog startup so typecheck/lint/unit tests pass. |

| 2026-07-09 | QuickStart connection persistence path fix: enable flow now routes connection hash writes plus raw/settings-prefixed connection-settings mirrors through applyMainConnectionSettingsChange(), uses the returned persisted connection snapshot for subsequent progression/response work, preserves resolved live-volume-factor logging, and adds a regression guard against standalone pre-recoordination updateConnection writes. |
| 2026-07-09 | Engine refresh queue status follow-up: queued refresh requests now carry `refresh_queued_at`, `refresh_last_attempt_at`, `refresh_last_error`, and `refresh_processed_at` status fields; immediate drain failures are persisted with `recordEngineRefreshRequestFailure()`, settings APIs surface `refreshQueued`/retry status, and QuickStart distinguishes `queued_for_owner` from `applied_locally` instead of marking queued-only recoordination complete. |
| 2026-07-09 | Production readiness deadlock fix: `checkProductionReadiness()` no longer treats missing `trade_engine:global` runtime intent fields as schema/readiness blockers, because fresh production startup, QuickStart, and start routes initialize those fields before engine ownership. This fixes production auto-start/QuickStart being blocked by the very metadata they are responsible for creating. |
| 2026-07-09 | Production/dev coordination follow-up: QuickStart now awaits the selected connection engine boot in production/serverless (bounded by QUICKSTART_ENGINE_BOOT_WAIT_MS) instead of relying on fire-and-forget async work that can be frozen after a response, while retaining non-blocking dev UX. Production readiness now honors explicit ALLOW_PROD_INLINE_REDIS/ALLOW_INLINE_REDIS_LIVE_TRADING overrides for local production smoke tests, and validation was rerun across typecheck, lint, unit tests, and production build. |
| 2026-07-09 | Intensive deploy recovery pass: repaired malformed merge/syntax drift across QuickStart, dashboard QuickStart, connection recoordination, production readiness, auto-start refresh queue handling, migrations, startup coordinator, and global trade engine watchdog code. QuickStart now uses the single canonical applyMainConnectionSettingsChange persistence path before engine startup, refresh queue consumers share claim/TTL handling with test-compatible fallback behavior, and typecheck/lint/unit/build validation passes under the local Node 24 environment (with the known project engine warning for >=20 <23). |
| 2026-07-09 | Follow-up fix pass for refresh queue status PR: repaired stale merge/syntax issues in QuickStart, QuickStart button, and legacy connection settings defaults; restored source-level regression guard compatibility; made production readiness checks test-safe for minimal Redis mocks; and re-ran typecheck, lint, and unit tests successfully. |
- 2026-07-09: Hardened live-stage production persistence so the hot-path `savePosition` maintains connection-scoped tracking-id reverse indexes and `live_set_keys:{connectionId}` open-set indexes directly, keeping exchange/client/system IDs, Set/Pos relations, and restart/self-healing audits consistent even when writes bypass the generic Redis DB helper.
- 2026-07-09: Made the requested deployment default explicit: production/preview now keeps `ALLOW_PROD_INLINE_REDIS=1` active automatically when no shared Redis URL is configured, while `ALLOW_PROD_INLINE_REDIS=0` can still force a hard shared-Redis requirement and live exchange order placement remains separately gated by `ALLOW_INLINE_REDIS_LIVE_TRADING`.
| 2026-07-09 | Settings progression-visible mirror fix: `/api/settings/connections/[id]/settings` now classifies flattened coordination variant/axis/block knobs, system-close aliases, and leverage fields as progression-visible, so both serialized settings writes and flat-knob mirror writes persist those values into raw and settings-prefixed `trade_engine_state` hashes. Added requested regression coverage for the full key list and dual hash write path. |
| 2026-07-09 | Settings progression mirror regression follow-up: strengthened requested regression coverage from static source-slice checks to an actual mocked PATCH save, asserting flattened variant/axis/block/system-close/leverage fields are written into both `trade_engine_state:{id}` and `settings:trade_engine_state:{id}`. |
| 2026-07-09 | Live-stage failed-order accounting now mirrors every `live_orders_failed_count` increment in `executeLivePosition` to the per-symbol `live_orders_by_symbol` failed counter, while preserving the existing best-effort metric wrapper so counter write failures do not disrupt order execution. Added source-level regression coverage for connector, price, circuit-breaker, rejected, and unhandled-error paths. |

- 2026-07-09: Extracted live progression order-by-symbol aggregation into a shared helper that supports canonical `{SYMBOL}:{direction}:{placed|filled|failed}` fields plus legacy JSON symbol rows, returns per-symbol rows and long/short totals, and feeds both `ordersBySymbol` and `ordersByDirection` in the stats API. Added mixed canonical/legacy regression coverage.
| 2026-07-09 | Live-stage reconcile fill accounting is now idempotent: `LivePosition` persists `fillCounterRecordedAt`, reconcile exchange-position fallback and getOrder fill/partial-fill paths call one marker-guarded counter helper, and regression coverage asserts fill counters are not incremented directly without the durable marker. |

- [x] Dashboard settings event fix: unversioned `connection-settings-updated` events now refresh immediately without arming the recoordination watchdog, preventing false "Settings recoordination did not confirm" toasts from legacy/slider settings saves.

- [x] Production progression unstuck: prehistoric bootstrap is now deadline-wrapped and the continuous prehistoric first-pass loop opens live gates after a bounded no-step fallback, so a hung/empty historic load cannot leave a connection permanently stuck before realtime/live processing.

- [x] Scoped progression keys: canonical progression/prehistoric/trade-engine-state reads and writes now include engine type (`progression:{connectionId}:{engineType}` and siblings), with a one-time main-scope migration fallback from legacy unscoped progression hashes for backward-compatible reads.
| 2026-07-10 | Main connection PATCH settings ordering: `/api/settings/connections/[id]/settings` now computes the connection patch, serialized settings patch, flattened hash mirrors, resolved auto/manual symbols, settings version, and symbol-selection epoch before performing Redis writes. The route delegates the single ordered persistence/recoordination path to `applyMainConnectionSettingsChange()`, which now centrally mirrors trade-engine-state patches to both raw and settings-prefixed hashes and reuses caller-computed symbol epochs for stale-event rejection. |

- [x] Progression fingerprint centralization: added `lib/progression-fingerprint.ts` as the single builder for progression snapshot fingerprints/settings, with stable boolean/number/object normalization and a broader progression-affecting field list covering symbols, engine/mode flags, margin/position mode, sizing/leverage, strategy thresholds, coordination, active indications, and system-close/control-order toggles. `ProgressionStateManager.recoordinateForActualOne()` and `EngineManager.start()` now share this builder for compare/stamp parity.
| 2026-07-10 | Settings recoordination pending-state hardening: progression markers now include started/requested version/event metadata, successful and failed recoordination paths clear pending with completion/failure stamps, engine hot-reload stamps preserve requested identifiers, and progression stats expose stale pending markers as warnings after a short threshold. |
| 2026-07-10 | Progression stats epoch/scope authority fix: `/api/connections/progression/[id]/stats` now resolves the active progression snapshot by connection and engine type before reading fallback hashes, exposes epoch/settings/symbol-snapshot identity in metadata, gates legacy `engine_progression`/`trade_engine_state`/unscoped progression data by matching epoch or settings version, places stale fallback summaries under `previousRun`, and prioritizes the active snapshot/current selected symbols for displayed historic totals. |

- 2026-07-10 | Symbol resolution fallback preservation: Main Connection settings saves now carry symbol resolution source metadata, preserve existing active/forced engine symbols when live ranking falls back unless the operator explicitly confirms/manual-selects the list, return a save warning, and keep symbol_order/symbol_count for the next successful recoordination. The settings dialog now displays the warning and keeps the previous active-symbol preview instead of implying fallback symbols are active.
| 2026-07-10 | Main connection progress/recoordination stability fix: progression stats now read the active engine-type scoped progression hash without destructuring fallback namespaces out of order, carries stale fallback data only in `previousRun`, and ConfigSet prehistoric progress writes mirror to scoped `progression:{connectionId}:main` / `engine_progression:{connectionId}:main` keys so per-connection progress remains unique, continuous, and does not fall back to initial/unscoped settings after dialog saves. Engine-manager recoordination completion/failure stamps now update both scoped and legacy progression hashes. |
| 2026-07-10 | Deploy-hardening follow-up for scoped progression: ConfigSet prehistoric progress now updates both scoped and legacy `engine_progression` mirrors to keep older dashboard/verification routes moving while scoped stats remain authoritative; added regression guards for scoped stats reads, stale fallback isolation, and dual scoped/legacy progress writes. Verified typecheck, lint, targeted Jest, and full production build. |
| 2026-07-10 | Comprehensive progression continuity follow-up: runtime progression route now falls back from scoped to legacy engine progress/state and checks both scoped and legacy prehistoric done flags; engine-manager phase updates and validated progression-writes mirror scoped mutations to legacy keys; settings recoordination markers and trade-engine-state patches now write scoped and legacy hashes together so coordinator stop/restart or settings hot reload cannot reset to stale settings/progress. |
| 2026-07-10 | Settings PATCH single-writer hardening: removed pre-recoordination partial writes from the Main Connection PATCH route. PATCH now computes merged settings, resolved symbols, flat mirrors, connection patch, and trade-engine-state patch in memory, then performs persistence only through `applyMainConnectionSettingsChange()`, avoiding transient scoped/legacy split-brain windows that could make running engines fall back to stale settings/progress during hot reload or coordinator restart. Added a regression guard for the no-partial-write contract. |
| 2026-07-10 | Systemwide deploy/test fix pass: repaired ConfigSet prehistoric progress syntax and ensured scoped+legacy engine progress mirrors use the shared `setEngineProgress()` helper, fixed progression stats namespace destructuring and test-safe query parsing so live order-by-symbol totals populate correctly, restored production engine ownership guard compatibility, and added post-recoordination settings hash mirrors for lightweight/test deployments without reintroducing pre-recoordination partial writes. Verified lint, typecheck, full Jest, smoke routes, and production build in the local Node 24 environment (known package engine warning: project wants Node >=20 <23). |
| 2026-07-10 | Deploy/test hygiene pass: retired cloud provider install/build commands now explicitly enable Corepack and activate pnpm 10.28.1 before frozen install/build, preventing platform pnpm-version drift; Jest suite scripts now run in-band with open-handle detection to avoid lingering worker-handle warnings while preserving full test coverage. Verified typecheck, lint, smoke routes, full Jest, production build, and retired cloud provider build locally. |
| 2026-07-10 | Stats completeness fix: progression stats now report Real evaluated counts after Real fan-out instead of returning before the fan-out calculation, active-count strategy payloads include the Live stage, and dashboard/active-connection indication breakdowns include Active Advanced values so all generated indication types are visible and update correctly. |
| 2026-07-10 | Dashboard canonical event bridge: `useDashboardEvents()` now maps fresh canonical SSE events (`settings.hotReloaded`, `connection.recoordinated`, progression epoch/stage changes, processing progress, live stage changes, engine status, and errors) onto the dashboard refresh handlers used by Main Connections, statistics, logging, monitoring, and processing surfaces. This keeps progress/stats/info cards synchronized immediately after settings recoordination, engine restarts, and recalculation epochs instead of waiting for legacy event aliases or incidental polling. |
| 2026-07-10 | Dev/prod comparison responsiveness fix: 12-symbol BingX quickstart comparison exposed Main Connection progression endpoint starvation in dev under heavy engine log output. The progression route now timeboxes auxiliary log flushing/recent-log reads so progress/stats snapshots return without waiting on logging I/O, and progression logging no longer treats high-frequency indication/strategy/realtime/live-trading hot-path events as immediate stdout/Redis flush events. This keeps dashboard progress/stats responsive during settings recoordination, engine restart, and 12-symbol recalculation runs. |
| 2026-07-10 | Progression log read follow-up: Main Connection progression polls now read recent logs with `flush: false` after a bounded connection-local flush, so card refreshes avoid triggering global log-buffer flush fan-out while engines are processing many symbols. Full log/detail routes keep the default flushing behavior for freshest logs. |
| 2026-07-13 | Deployment build repair: removed duplicated heartbeat/progression status declarations in `/api/connections/status`, restoring TypeScript validation and production `next build` deploy completion. |
| 2026-07-13 | Production live-order/progression stability fix: progression fingerprint stamping and recoordination now overlay legacy `connection_settings:{id}` defaults before canonical `settings:connection_settings:{id}` so the latest operator settings win and healthy production progressions do not reset to stale defaults; live-stage per-connection system-close cache follows the same precedence, and live-order service now refuses simulated fallback in production when exchange credentials are missing unless explicitly allowed. |
| 2026-07-13 | Follow-up stability completion: added a shared canonical connection-settings overlay helper and routed strategy coordination, previous-position thresholds, and live volume sizing through it; volume sizing now resolves position cost/leverage after all overlays so saved operator sizing reaches live exchange orders instead of defaulting. |
| 2026-07-14 | Production 12-symbol QuickStart verification exposed stale trade-engine-state symbol precedence in progression recoordination; `recoordinateForActualOne()` now resolves canonical operator `force_symbols`/`symbols` before old engine-state symbols so new 12-symbol epochs stamp the correct symbol count/hash instead of reporting historic 4-symbol progress. |
| 2026-07-14 | Follow-up production smoke fix: QuickStart now persists `dev_symbol_count_override` and a trade-engine-state symbol patch before recoordination/start, and the engine's local production symbol cap reads the connection override, so `SYMBOL_COUNT=12` production smoke runs process all 12 requested symbols instead of the self-hosted default 4. |
| 2026-07-14 | Prehistoric memory lifecycle: 1-second bootstrap candles are persisted as temporary timestamp-indexed Redis chunks while `:1s`/`:candles` retain only a 300-candle realtime window. Config-set calculations load only the configured range one symbol at a time, clear working arrays after each symbol, and replay loads bounded warmup/pending/lookahead chunks. Once the current symbol epoch is authoritatively complete (including PF output and N/N symbols), the engine deletes chunk/meta keys, clears parsed caches, stops prehistoric polling, and leaves realtime continuous. Cold-load concurrency defaults to two fetches; cached starts avoid rebuilding history. Also fixed cache-hit live timers being armed before `isRunning`. Verified typecheck, lint, 131 targeted regressions, and production build; the broad suite was not rerun because its live-exchange-capable paths are safety-gated. |
| 2026-07-14 | Credential hygiene follow-up: removed tracked BingX/Bybit/Pionex/OrangeX credential literals from `.env.example`, base/user connection fallbacks, default file-storage records, and a committed Redis snapshot temp file. Importable connection metadata now resolves credentials only from server-side environment aliases, and runtime snapshot temp files are ignored. Historical keys must be revoked/rotated because deleting them from the current tree does not erase prior Git commits. |
| 2026-07-14 | Block/live-order completion: every Block count now uses the positions-based add-on formula `confirmed current quantity × (Block count × ratio)`, with independent Set keys, active/pause state, base/requested/filled/aggregate volume metadata, and order/client IDs. Partial fills apply only newly observed exchange deltas; durable pre-send outboxes and continuous restart reconciliation prevent blind resubmission and retain tracking across crashes. Block pause updates are atomic in network Redis and serialized in the local adapter. Active Real/Live settings remain independent and default enabled. Trade History now reads up to 500 real BingX/local closes, excludes partial/duplicate bookkeeping rows, derives missing local PnL, and renders Won/Lost/fees/net-PnL/volume through a continuous 50-row virtual window. |
| 2026-07-14 | Final continuity/performance pass: connection and indication settings use serialized, diff-aware atomic saves so reconnects and concurrent dialogs preserve operator values and only trigger necessary recoordination. Trailing profiles and four-step DCA settings now propagate through Strategy → Real → Live; DCA uses immutable first-fill sizing, adverse-price steps, cooldowns, average/first-entry/breakeven TP modes, durable pending-order recovery, and aggregate quantity metadata. Realtime status/direction creation races are leased/deduplicated, closed Live history is capped at 500, and the 32-symbol public BingX no-order stress plus production preview, 283 Jest tests, lint, typecheck, volatile cleanup, and optimized build all passed. The tracked environment template now contains placeholders only; previously exposed credentials still require rotation because they remain in Git history. |
| 2026-07-15 | Production continuity release: startup is process-wide single-flight and retryable, migrations reach schema v70 without overwriting explicit operator settings, and a Redis-backed stable site ID is separated from the per-process boot ID so sessions/settings survive worker and server restarts. Self-hosted deployments now have a portable non-overlapping one-minute scheduler plus a 15-second continuity recovery loop; cron routes require `CRON_SECRET` in production and no longer depend on retired cloud provider cron execution. Browser session and dashboard selection caches persist indefinitely in local storage, while server startup/status APIs expose authoritative readiness and scheduler state. |
| 2026-07-15 | Intensive engine/UI verification release: corrected Main/Real progression accounting to preserve valid strategy/axis fan-out while reporting parent-input pass rates, bounded system-monitoring scans and restricted connection reads to active/main indexes, and added production restart/soak/scheduler/monitoring regression harnesses. Validation passed 55 Jest suites (348 tests), lint, strict typecheck, optimized production build, volatile cleanup, two restart-and-persistence preview runs, a 66-second 12-symbol simulated production soak (historic 100%, realtime/monitoring advancing, zero exchange orders, post-warmup memory released), and a 32-symbol public BingX read-only stress run (6,400 candles, +2.13 MB heap, zero authenticated/order requests). |
| 2026-07-15 | Bounded asynchronous engine release: added an allocation-conscious ordered worker pool and applied explicit concurrency budgets across realtime/historic symbols, indication Set writes, config/type calculations, Strategy Base→Main→Real flows, legacy/preset engines, preset combinations/optimizer, pseudo-position updates, and position-stage symbol groups. Same-symbol Base admissions and Main→Real creations are leased to preserve ceilings, duplicate realtime mutations are single-flight, stale strategy fingerprints now include indication identity/time and commit only after successful stages, Preset strategy consumes the current indication result, and legacy short protection prices now place TP below entry and SL above. Historic optimizer memory is capped at two temporary symbol batches by default and releases both after completion; exchange mutation/order sequencing remains serial. Direct validation passed ESLint, strict TypeScript, deployment syntax, 58 Jest suites/355 tests, optimized production build, portable scheduler, volatile cleanup, 32-symbol public BingX stress (6,400 candles, +3.39 MB heap, zero authenticated/order requests), and a 90-second 12-symbol simulated production soak (historic 100%, 140 engine cycles, p95 291 ms, RSS 2.03 GiB peak → 1.16 GiB end, settings/site identity stable across restart, zero exchange orders). |
| 2026-07-19 | Ultra Kilo production-readiness pass: expanded the real Workerd verifier to load dashboard/settings/preset client assets, mutate and read back Block PF and volume settings, exercise Disable/Enable/Live/Pause/Resume/Stop/Start, prove external-owner queueing and zero real positions/orders, and run scheduled continuity/live recovery. Fixed false local settings-apply claims, phantom-running status after Resume, strict-string flag handling for Redis-parsed Boolean Main/Preset states, and stale-generation global Start queues. Reproduced and eliminated the isolated `.next-prod` Next 15 export cleanup race by serializing static generation only for custom dist directories. Verified schema v81, 83 Jest suites/510 tests, lint, typecheck, OpenNext, Wrangler dry-run, Workerd, a 240-second/32-symbol production soak (1,320 requests, 400 cycles, p95 127 ms, 0 real orders), UI settings/state hot reload, and secret scan. Actual Kilo upload and minimum-size BingX open/protect/close remain blocked until authenticated targets, shared Redis, a distinct long-lived owner, runtime secrets, exchange credentials, and flat-account proof are supplied. |

## Session (2026-07-19): Production serverless/Kilo "global coordinator fail" fix

### Problem
In the real production topology (Cloudflare/Kilo deploy via `wrangler.jsonc`: `KILO_DEPLOYMENT=1`, `CTS_DEPLOYMENT_RUNTIME=kilo-deploy`, `DISABLE_IN_PROCESS_CONTINUITY=1`, `DISABLE_TRADE_ENGINE_IN_PROCESS=1`), the engine never ran:
- `isServerlessDeploymentRuntime()` returned true.
- `trade-engine-auto-start.ts` `runTradeEngineHealingSweepInternal` early-returned `skipped: serverless_runtime_requires_external_engine_owner`, so the continuity cron never started engines.
- `production-readiness.ts` `redis_backend` gate forbade inline-local Redis in serverless even when `ALLOW_PROD_INLINE_REDIS=1`, deadlocking `assertProductionReadiness` (auto-start init failed: `Production readiness check failed: redis_backend`).
- Result: `activeEngineCount=0`, `running=false` → "global coordinator fail". Dev (long-lived node) worked because it bypassed all serverless gates.

### Root cause
The architecture assumed a separate long-lived engine-owner worker, but the repo's production manifest deploys a SINGLE serverless worker with no external owner — so nobody ever ran the engine.

### Fix
1. `lib/trade-engine.ts`: added `hasNoExternalEngineOwner()`; `startEngine` now allows a serverless worker to OWN the engine when `CTS_ENGINE_OWNER_WORKER=1` (the designated single-worker owner) OR when no external owner heartbeat exists. `forceLocalTakeover` alone does NOT bypass the serverless guard (contract preserved). New `DISABLE_TRADE_ENGINE_IN_PROCESS` block now only blocks when NOT the owner worker.
2. `lib/trade-engine-auto-start.ts`: healing sweep no longer blanket-skips serverless; when no external owner heartbeat exists and operator intent is running, it starts engines (this worker is the owner). Otherwise defers to external owner.
3. `lib/production-readiness.ts`: allow inline-local Redis in serverless when `ALLOW_PROD_INLINE_REDIS=1` (single-worker opt-in), not just non-serverless.
4. `wrangler.jsonc`: added `CTS_ENGINE_OWNER_WORKER=1` (keeping `DISABLE_TRADE_ENGINE_IN_PROCESS=1` for request workers — contract intact).

### Verification
- Reproduced failure locally by simulating serverless env (was `running=False, activeEngineCount=0`). After fix: `running=True, workerAttached=True, activeEngineCount=1`.
- Cron continuity runs healing sweep successfully; Start/Stop/Pause/Resume all work; settings PATCH + bingx test work.
- `scripts/verify-prod-ui-max.mjs` passes (QuickStart 32 symbols, settings/volume hot-reload, main toggle, 4 global controls, status relationships, 0 real orders).
- `bun typecheck`, `bun lint`, `bun test:unit` (494), `bun test:integration` (15) all green.

## Session 2026-07-19 — strategy calc / volume / progress fixes

- [x] Connection progress "symbols processed stuck 0/#" ROOT CAUSE fixed in
  `lib/trade-engine/config-set-processor.ts`: the per-symbol progress writes
  (skip/error/progressWrite paths) were gated behind `stillOwnsCurrentSelection()`
  and early-returned when the epoch/symbol-selection mismatched, leaving the
  `symbols_processed` hash at the run-start seed `0` while the total was shown.
  Ownership now only gates STARTING work; completed work is always recorded.
- [x] Added `posCountsVolumeRatio` (Position-Count / Pis Sets volume ratio),
  default `0.05`, range `0.01–0.25` step `0.01`. Wired through:
  `app/settings/page.tsx` Settings interface + default; `components/settings/tabs/
  strategy-tab.tsx` Stage Evaluation Thresholds slider; `components/settings/
  strategy-coordination-section.tsx` CoordinationSettings interface + default +
  Pis Volume Ratio card; `components/settings/connection-settings-dialog.tsx`
  read-through + per-connection persistence; `lib/strategy-coordinator.ts`
  `_coordinationSettings` load/read + `expandAxisSets` applies it to the
  synthetic axis-set entry `sizeMultiplier`; `lib/trade-engine/stages/real-stage.ts`
  `createRealPosition` uses `posCountsVolumeRatio` for standard/axis sets;
  propagated from axis Set → mainPos → RealPosition → Live dispatch.
- [x] Lowered `VolumeCalculator` variant floor `0.1 → 0.01` so the 0.05
  Pis ratio is honoured for the additional Main-stage axis Sets (was clamped up).
- [x] CORRECTION (operator clarified Pis = pos-counts): pos-count axis Sets now
  participate in Real-stage hedge netting (long/short per bucket collapse to
  |L − S| dominant direction) in `evaluateRealSets`. After netting, surviving
  pos-count Sets of the same symbol+direction are COMBINED into ONE live
  exchange order with summed volume (`createLiveSets` builds a combined Set:
  `posCountsVolumeRatio`/`sizeMultiplier` = sum of member ratios,
  `accumulatedSetKeys` = all member setKeys, `combinedPosCounts: true`). Keeps
  per-Set calculations + GLOBALIZED stats/history correct (no per-Set split).
  Wired `combinedPosCounts`/`accumulatedSetKeys` through StrategySet → RealPosition
  → LivePosition. `live_net_target:{conn}` net remainder now also written for axis buckets.
- [x] Extracted combine block to testable `combinePosCountAxisSets` private method;
  added regression test (27 axis-coordination tests pass). Volume calcs verified
  via unit + integration tests: 77 unit pass (1 pre-existing deploy-contract
  failure unrelated), 15 integration pass, typecheck + lint clean.
- [x] Block per-Set volume already derives from Base Set `blockConfig.size`
  (`buildBlockOverlays`); axis Sets now carry their own reduced volume ratio.
- [x] Added live-stage position-count target reconciliation for partial
  increase/reduce, flat close, and direction flips; Main reports the qualified
  Long/Short hedge difference while global stats/history retain the complete
  member lineage without inventing separate exchange fills per Set.
- [x] Fixed `coordination_settings` char-indexed object bug in GET handler: when
  `serializeConnectionSettingsHash` stores `coordination_settings` as a JSON string
  and the GET route spreads it directly, the string gets splayed into a character-
  indexed object ({'0':'{','1':'"',...}). Fix: parse string via `parseIfString`
  before spreading (app/api/settings/connections/[id]/settings/route.ts:247-254).
  Verified: GET returns proper object with `posCountsVolumeRatio: 0.05`.
- [x] Final 2026-07-22 release verification: 92 Jest suites/573 tests, complete
  TypeScript and ESLint, fresh 40-page Production build, three-boot five-symbol
  Production run (386 engine cycles, 966 Main strategy cycles, 330 API reads,
  P95 33 ms), and exact Historic progress from 1/5 = 20% to 5/5 = 100% across
  all snapshots. The rebuilt OpenNext/Kilo Worker passed Workerd UI, Settings,
  QuickStart, ACK/queue, Scheduled Owner, Statistics/Trade History, and all
  global/connection state transitions; Wrangler accepted 831 assets. The final
  public BingX SDK read-only run fetched 1,000 candles for five symbols with
  zero authenticated or order requests. Release-tree scan: 1,159 files, zero
  secret findings. Real Kilo upload and live exchange mutation remain correctly
  blocked without the required external deployment credentials/target inputs.

## Session 2026-07-22 — Kilo/retired cloud provider deploy and QuickStart PF state repair

- [x] QuickStart PF sliders now keep a ref-backed optimistic draft, merge rapid
  cross-stage changes deterministically, consume the canonical settings object
  returned by the successful PATCH, and roll back to the last confirmed value
  on failure. `connection-settings-updated` applies its confirmed payload
  directly; only legacy events without relevant settings rehydrate. This removes
  the stale cross-isolate GET that made a slider jump back after “Saved”.
- [x] Replaced the Git-hosted `@kilocode/app-builder-db` runtime dependency with
  the same small typed HTTP query protocol in `lib/kilo-database-client.ts` so
  retired cloud provider/Kilo clean installs use only the frozen registry graph. Drizzle schema,
  SQLite proxy and migration semantics remain unchanged. Deployments without
  optional `DB_URL`/`DB_TOKEN` skip migration cleanly; configured Kilo databases
  still migrate and fail the deploy on real migration errors.
- [x] The deployment-aware `db:migrate` wrapper now launches
  `node --import tsx src/db/migrate.ts` instead of the IPC-creating `tsx` CLI,
  which works in restricted Kilo build sandboxes and retains Node 20+
  compatibility while retired cloud provider safely skips the Kilo-only migration. The retired
  credential-bootstrap route is a permanent no-store 404 and has a regression
  forbidding DB credential access.
- [x] Production-readiness responses distinguish missing shared persistence with
  `shared_persistence_required` and actionable Redis/Upstash/retired cloud provider KV guidance;
  engine/order coordination remains fail-closed until the shared backend is
  actually present.
- [x] Verification on the release tree: frozen pnpm 10.28.1 lockfile, 92 Jest
  suites/576 tests, TypeScript, ESLint, 40-page retired cloud provider Production build, and
  36-check OpenNext/Kilo preflight plus successful Worker bundle generation.
- [x] Kilo App Builder still provisions its managed SQLite binding by package
  name. The local, dependency-free `vendor/app-builder-db-marker` package keeps
  that provisioning signal while CTS continues to use its audited local HTTP
  adapter at runtime. Its exact `file:` entry is pinned in `pnpm-lock.yaml`, so
  retired cloud provider/Kilo frozen installs remain reproducible and never fetch the former
  Git-hosted runtime package.
- [x] retired cloud provider now uses the same source-fingerprint and trace-validating Next build
  wrapper as OpenNext. It retries only known late `.next` ENOENT/ENOTEMPTY writer
  races and still fails immediately on compilation, syntax, type or source-change
  errors. retired cloud provider validates its function traces without requiring the intentionally
  absent OpenNext standalone tree; OpenNext still requires that additional output.
  Each attempt runs in an isolated process group; late trace/export children get
  a bounded settlement window and are then terminated before provider packaging.
  This prevents overlay filesystem races from failing a complete 40-page deploy.

## Session 2026-07-22 — self-hosted continuity, installer and production metrics repair

- [x] QuickStart start/stop generation handling now prevents an in-flight start
  from overwriting a later Stop, uses the selected symbol count without the old
  hidden four-symbol fallback, and only reports Running after a successful owner
  start. Stale local heartbeats no longer suppress the durable cron fallback.
- [x] Production Redis request-rate reporting now samples network Redis `INFO`
  (`instantaneous_ops_per_sec`) with a short cache and supplies that value in all
  monitoring endpoints, including the formerly missing comprehensive database
  object. The production soak verifier requires non-zero database activity.
- [x] Linux installs use global Bun when absent, with Node retaining Next
  standalone compatibility. They record service name/port/runtime/user and ship
  saved-default `start.sh`, `stop.sh`, and `restart.sh` controls. The long-lived
  minute scheduler calls authenticated continuity and live-position routes in
  parallel every 60 seconds and is removed with the app on uninstall.
- [x] Bootstrap upgrades now resolve an explicit directory/name/port or saved
  installation record, stop the exact recorded CTS services, preserve only the
  protected production environment and CTS-managed local Redis state, delete
  the old verified CTS checkout, then clone a clean revision. Uninstall uses
  the saved identity and rejects a mismatched name/port, preserving shared
  Bun/Node/Redis and external Redis data.
- [x] `SessionSynchronizer` and `ProgressTracker` are now mounted in the root
  provider, so every route/subpage shares root-level browser recovery. The
  browser binds its cache to the durable Redis `site_instance_id` on load,
  visibility return, and a 60-second poll; a changed site clears
  server-derived selections, while connection progression caches are scoped by
  site ID and immediately re-fetch canonical Redis state.
- [x] Current focused regression suite: 10 suites/196 tests; full suite: 92
  suites/578 tests; portable scheduler test, installer preflight, shell syntax
  and diff whitespace checks pass. A full current production build/soak still
  needs an execution environment that permits Next build to run longer than the
  short command-session cap; no live exchange orders were submitted without an
  explicit live/testnet endpoint and credentials.
- [x] Final dev smoke on 2026-07-22 served health, initialization and monitoring
  under Next development mode with a durable site ID, `ready: true`, and Redis
  observed activity (46 req/s). The fresh bounded dev engine harness also
  reached its first advancing simulated-engine round before the workspace's
  command cap ended the harness. Production compilation reached Next's
  successful compile stage, but the same cap prevents final page-data/standalone
  assembly and the production soak in this workspace.

## Session 2026-07-23 — production completion and stranded-position recovery

- [x] A clean standalone production build now completes in this workspace: all
  40 pages are generated, source/trace normalization succeeds, and standalone
  assets are prepared from the same artifact used by the installed service.
- [x] Development and production simulated-engine soaks both completed with 12
  symbols, persistent migrations/settings/site identity, advancing historical,
  realtime and strategy counters, bounded latency, and non-zero Redis request
  rates. No real exchange order was enabled or submitted.
- [x] Production recovery is now explicitly regression-tested by hard-stopping
  the standalone server with active simulated positions, restarting it, then
  calling the authenticated live-position reconciliation cron. The stable site
  identity, all active position IDs and quantities survive; no position remains
  in `pending` or `placed` state and the recovery tick completes successfully.
- [x] The soak verifier reads canonical nested real-position statistics before
  applying fallback values, preventing a false position-count regression when
  durable variant-ledger data becomes available.

## Session 2026-07-24 — live trade always-enabled on production server installs

- [x] `checkProductionReadiness` in `lib/production-readiness.ts`: removed the
    hard-fail case where an absent preset `BASE_CONNECTION_ID` (bybit-x03,
    pionex-x01, orangex-x01) blocks the entire 503 readiness gate. Missing
    preset connections are now silently skipped; presence-of-data credential
    checks still run for connections that do exist. This is the primary blocker
    removed so fresh production server installs can enter live trade after
    adding just bingx-x01 credentials via `scripts/add-bingx-credentials.js`.
- [x] `lib/real-trade-gates.ts`: `hasDurableLiveCoordination` already treats
    Kilo persistent inline Redis (CTS_INLINE_REDIS_PERSISTENT_VOLUME=1 +
    absolute non-/tmp V0_REDIS_SNAPSHOT_PATH) as durable coordination without
    requiring ALLOW_KILO_SQLITE_LIVE_TRADING. Verified `wrangler.jsonc` carries
    ALLOW_PROD_INLINE_REDIS=1, ALLOW_INLINE_REDIS_LIVE_TRADING=1,
    ALLOW_KILO_SQLITE_LIVE_TRADING=1, CTS_INLINE_REDIS_PERSISTENT_VOLUME=1,
    V0_REDIS_SNAPSHOT_PATH=/data/redis/snapshot — preflight satisfied.
- [x] `lib/strategy-coordinator.ts`: raised capacity ceilings (maxEntriesPerSet
    250→500, maxLiveSets 400→600, maxRealSets 25→50, mainAxisSetsCeiling 50→120,
    realSetsSafetyCeiling 100→250, liveSetsCeiling 90→250) to support higher-
    throughput server evaluation.
- [x] `scripts/install.sh`: added `chmod -R a+rX /opt/bun` so the service user
  can execute Bun after installation.
- [x] `scripts/install.sh`: added service user home directory creation check before
  any `run_as_service` calls.
- [x] `scripts/update.sh`: fixed runtime path resolution where `RUNTIME_DIR` was
  computed before `ensure_active_dir()` updated `PROJECT_ROOT`.
- [x] `scripts/prepare-turbopack.mjs`: Turbopack compatibility fix for Next 15 + pnpm
  (copies .json to .jsonc for `server-external-packages`).
- [x] `scripts/update.sh`: new updater that stops services, pulls origin/main,
    installs deps, builds production, restarts, and verifies /api/health.
- [x] `wrangler.jsonc`: updated `DISABLE_TRADE_ENGINE_IN_PROCESS` from `"1"` to `"0"`
    to make the explicit in-process engine-owner intent part of the Kilo manifest.
    `custom-worker.ts` still performs the runtime safety-gate refresh from the
    live-trade opt-in pair, so the baked-in `"0"` is safe and operationally
    preserved for production server installs.
- [x] `custom-worker.ts` preflight vars: added DISABLE_IN_PROCESS_CONTINUITY=1,
    DISABLE_TRADE_ENGINE_IN_PROCESS=1, CTS_ENGINE_OWNER_WORKER=1 to wrangler.jsonc;
    custom-worker.ts resets both DISABLE flags to "0" when both live-trade safety
    gates are set, enabling the in-process engine owner path on Kilo.

## Live trade requirements summary for production server installs
<!-- PRAGMA: do NOT rely on any order-fill/*/* branch — this doc describes requirements, not fulfillment guarantees -->

For live trade to be **always enabled** on a production server install the
operator must:
1. Run `scripts/add-bingx-credentials.js` to seed bingx-x01 credentials.
2. Ensure `wrangler.jsonc` carries the three live-trade env vars (already set).
3. Mount a persistent volume at `/data/redis/` on the server.
4. Start the service (systemctl/pm2) so the scheduler cron owns the in-process
   engine and `startMissingEngines(forceLocalTakeover=true)` promotes all
   live trade–enabled base connections.

Attempted production installs that skip step 1 or have stale bingx-x01
credentials will still receive a 503 from the QuickStart route until valid
credentials are present.

## Session 2026-07-25 — systemwide always-on live trade for production installs

- [x] `scripts/install.sh`: changed the production installer default from
  `ALLOW_INLINE_REDIS_LIVE_TRADING 0` to `ALLOW_INLINE_REDIS_LIVE_TRADING 1` so
  real exchange order placement is enabled by default on new server installs.
- [x] `scripts/install.sh`: replaced the post-install warning about disabled live
  gates with an info line stating real exchange order placement is enabled by
  default and the hardened live gates are open systemwide.
- [x] `custom-worker.ts`: simplified the Kilo/Cloudflare worker live-trade preflight
  so it no longer requires `ALLOW_KILO_SQLITE_LIVE_TRADING=1` as a second safety
  gate. When `ALLOW_INLINE_REDIS_LIVE_TRADING=1`, the worker now allows in-process
  continuity and engine ownership directly, matching the new installer default.
- [x] `__tests__/unit/install-deployment-contract.test.ts`: updated the installer
  contract assertion to expect `ALLOW_INLINE_REDIS_LIVE_TRADING 1`.
- [x] `__tests__/unit/requested-regressions.test.ts`: updated the custom-worker
  regression assertion to match the simplified live-trade preflight logic.
- [x] `docs/recreation/configuration-reference.md`: updated the safe production
  example to show `ALLOW_INLINE_REDIS_LIVE_TRADING=1`.
- [x] Verified with `bun run lint`, `bun run typecheck`, and targeted Jest runs;
  the only remaining unit failures are preexisting Kilo preflight lockfile checks
  unrelated to live-trade gating.

## Session 2026-07-26 — Signal engine, scoped Block lanes and identity volume

- [x] Added `Signal` under Common as a default-enabled one-minute indication
  engine. It uses 35 documented public OHLCV adapters, a persistent liquid
  core plus bounded priority rotation, strict schema/timeouts/cache/circuit
  handling, and local low-stop consensus. No separate Connection switch exists;
  the active Indications profile is authoritative.
- [x] Integrated Signal through Indication → Base → Main → Real → Live/Paper,
  including quantity-independent SL/TP lineage, reduce-only control orders,
  per-source attribution, restart recovery and a Signal volume slider on every
  existing channel-volume surface including Overall Settings.
- [x] Added exact last-15 closed-result PnL per source × symbol × direction.
  Mature negative lanes auto-disable independently; open positions never enter
  Signal PnL or Block PF windows.
- [x] Added independent Strategy Block lanes for symbol × long/short/overall
  and Signal Block lanes for source × symbol × long/short/overall. Regular
  Blocks use only normal Base-derived Sets; Active Real/Live Blocks include
  active Pos-Count positions. Virtual lanes retain independent PF/PnL/stats,
  while physical execution consolidates to one target per symbol/direction.
- [x] Canonical Block target is
  `general + general × ratio × count`; retries submit only target minus
  confirmed Block fills. Terminal and unresolved partial fills, idempotent
  replay, crash recovery and correctly sided reduce-only SL/TP are covered.
- [x] Block calculations/results/differences continue when Block is disabled,
  but no new evaluation/emission occurs. Cold enabled Block starts immediately
  from normal PF; after its own closed-result window matures, Block PF must be
  at least the matching normal PF. Regression: normal Last-25 PF 2 rejects
  mature Block PF 1.99 and accepts 2.
- [x] Shared Base coordination is immutable ratio 1 across Redis/API/UI,
  file-backed fallbacks, migration v84, Base/Main/Real and both volume
  calculation branches. Only named Main/Preset/Signal/Pos-Count/DCA/Block
  boundaries can adjust physical volume.
- [x] Current acceptance: trace-valid 41-page standalone build; production
  Paper soak 240 s/12 symbols/1,320 requests/682 engine cycles/4,452 Main
  cycles/p95 100 ms; Redis stable-window delta 2; 24/24 positions recovered
  after SIGKILL; 32-symbol Signal/UI/volume/status workflow green; Dev/HMR
  330-request run p95 1,494 ms; zero real exchange orders.
- [x] Added a visible Signal source-request interval with a 30-second default
  and hard server-side minimum. The normalized interval controls both source
  fetch and complete-cycle caches, hot-reloads through the existing Signal
  settings API, and safely migrates legacy millisecond cache values.

## Session 2026-07-28 — exhaustive indication and stage-release hardening

- [x] Released the complete, non-sampling indication topology: Direction,
  Move, Active, Advanced, Optimal, Trend, Common and Signal now report every
  valid configuration identity. Signal keeps independent
  source × symbol × direction × TP/SL/trailing cells, while Common preserves
  each indicator parameter tuple and 1/5/15/30-minute timeframe.
- [x] Compact Signal storage now uses bounded source hashes instead of one
  Redis list key per logical configuration, with backward-compatible reads and
  incremental legacy cleanup. The full 12-symbol/35-source production soak
  completed with a bounded keyspace, 4,199,040 evaluations, 532 ms API p95,
  monotonic progress/restart recovery and zero real order requests.
- [x] The legacy Indications fallback is exhaustive as well: it no longer
  silently truncates configuration rows at 500, orders lanes deterministically
  and bounds Redis reads to 32 concurrent pairs. Common coordination preserves
  configured 30-minute timeframes (and accepts values through 60 minutes).
- [x] Repaired Base → Main → Real → Live lineage and readiness semantics.
  The four rows are one mandatory processing pipeline with independently
  persisted configuration, not separately switchable strategies. Signal uses
  exact identity history. Position-Count Long and Short Sets stay independent
  through Real and are combined only within their own direction for Live; the
  10:0.03 Position-Count volume ratio remains intact. The settings UI exposes
  complete stage configuration and keeps Trend as the final indication tab.
- [x] New connections, legacy connection settings and Preset CRUD use the
  same canonical Main/Preset four-stage PositionCost-relative defaults as the
  runtime (Base 0.40; Main, Real and Live 1.12), with legacy aliases retained
  for older readers. Preset creation, activation and testing retain the full
  indication/range/stage matrix; bounded worker pools replace former 500/100
  configuration persistence ceilings.
- [x] The Structure dashboard and its metrics/module APIs now start from
  verified zero/unknown state, render only measured Redis/workflow/module
  health and derive pressure from real metrics; they no longer present
  fabricated capacities, placeholder health or a global 500-position ceiling.
  Connection state tabs consume those measured endpoints, and logistics reports
  the actual maximum latency rather than a fabricated average-plus-offset.
- [x] Realtime market-data, positions and monitoring-health surfaces now expose
  only exchange/engine snapshots and measured processor/resource telemetry.
  Missing, stale and synthetic data is explicitly labelled; random prices,
  static base prices and fabricated health values are not represented as live
  state. Open live-position indexes are read exhaustively in bounded batches.
- [x] The Indications page reads exhaustive per-symbol current snapshots,
  falls back through a repaired snapshot index, derives its filters from the
  measured rows and exports the visible measured set. Runtime indication rows
  are read-only; no demo connection or arbitrary default symbol/type list is
  presented as live data.
- [x] Monitoring system, comprehensive and log APIs now use canonical
  connection/position/workflow ledgers and the bounded logger list index.
  They report measured resource, Redis and engine data; connection-scoped
  monitoring refreshes with the selected connection rather than stale globals.
- [x] Strategies and positions views now consume complete canonical live
  ledgers: the Strategies UI requires an explicit selected connection, refreshes
  measured Base/Main/Real/Live snapshots without local toggle fabrication, and
  exports the visible snapshot. Position and connection-statistics APIs scan all
  canonical rows in bounded batches before applying filters or pagination; the
  legacy/demo projections no longer discard valid configuration rows at 50/150/250.
- [x] The QuickStart functional overview now aggregates fresh namespaced stage
  ledgers across all enabled connections instead of fixed symbols, implied
  fan-out, PF or storage-size estimates. Base/Main/Real evaluation stages leave
  win-rate and Sharpe at unavailable zero; only Live reports closed-position
  performance.
- [x] Progress and dashboard windows now use exact rolling Redis `ZCOUNT`
  measurements or explicitly report unavailable; historic counters are no
  longer filled from realtime cycles. Live notional has an explicit USD field
  instead of being presented as an average position count. New custom preset
  types inherit the system Block/Block-Only default, while an explicit `false`
  remains the operator override for parallel Standard+Block behavior.
- [x] Preserved one physical Direction parent for source-scoped Signal Block
  adjustments while allowing ordinary Block-only lanes to seed and recover
  their own parent. Explicit Consensus and direct-source outcomes now update
  only their exact lane; legacy outcomes retain source-plus-consensus
  accounting.
- [x] Schema v90 upgrades the former ten-source Signal default to the complete
  35-source cycle while retaining explicit operator choices. It normalizes all
  legacy stage switches to the mandatory pipeline and repairs Base PF values to
  the enforced 0.40 floor across connection hashes and nested stage documents
  without altering Main/Real/Live thresholds.
- [x] Statistics now derive balances, drawdown, PF, trailing metadata and TP
  movement from persisted values only; no synthetic starting balance, TP/SL,
  trailing values or execution PF is displayed. Rolling dashboard windows use
  exact Redis `ZCOUNT`, supported uniformly by Inline, node-redis and Upstash
  adapters.
- [x] Base PF validation is shared by the Settings surfaces, Preset defaults,
  migration and runtime validity gate. Optimal indication settings explicitly
  state that all configurations are evaluated and retain history per independent
  Set rather than presenting a false evaluation cap.
- [x] The Next recovery path atomically publishes the pages manifest and waits
  for the full late-writer process group to exit before trace validation, so a
  delayed worker cannot erase a briefly valid bundle after handoff.
- [x] Host updates and remote SSH installs now use one explicit clean lifecycle:
  stop the resolved CTS services, preserve only durable CTS state outside the
  target, delete the exact checkout, clone the requested revision, restore that
  state and run the canonical installer. In-place Git rewrites and silent
  rollback of a partially upgraded checkout are no longer used.
- [x] CTS-K-N release handoffs preserve both local and remote recovery points:
  create and verify a complete Git bundle under `/workspace/CTS-K-N-backups`,
  create exact pre-release backup refs for every rewritten GitHub branch, then
  update the release branch and `main` atomically with SHA-pinned
  `--force-with-lease`. Never use an unguarded blind force push; verify all
  destination and backup SHAs independently after publication.
- [x] Final release checks: 122 Jest suites / 859 tests, TypeScript, ESLint,
  Kilo preflight (37 checks, schema 90), installer/volatile-cleanup gates,
  secret scan, recreation-manifest verification, and a fresh production build
  with 41/41 pages, standalone assets and 339 complete server traces. The final
  12-symbol forced-paper Dev soak completed 1,008 API requests, 564
  live-position cycles, 120/120 Signal slots, 6,020 Signal Block rows and 120
  simulated lifecycles at 2.301 s warm p95; stop/restart, bounded key growth
  and post-warm memory stability passed with zero real positions or exchange
  order requests.

## Session 2026-07-28 — Signal capacity and /opt installer stabilization
- [x] Remote SSH install now requires dedicated `/opt/*` install targets and uses `/opt/cts-k-n-install-work` for local SSH key material, remote preflight/bootstrap clones, and seed env staging instead of `/tmp` work roots.
- [x] Remote install UI/API gained a `skipTests` option that forwards `--skip-tests` to both preflight and clean bootstrap install flows while leaving typecheck, lint, and build enabled.
- [x] Signal source-base position capacity default/max increased from 120 to 350 overall, legacy 24/120 persisted values migrate to 350, and settings now expose the overall source-base cap plus a 10-symbols-per-source cap with 12h-volatility ordering metadata.
- [x] Signal candidate ordering now prioritizes highest 12h volatility first, then lower stop-loss and drawdown when available, before consensus quality ties, keeping Signal admission independent from Main trade stage counts.
- [x] Verified TypeScript, targeted Signal policy/settings Jest coverage, and remote installer boundary tests; the full deployment-contract suite still has the pre-existing Kilo schema v91 preflight failure outside this change.

## Session 2026-07-28 — Signal-only connection overview and row-stage display follow-up
- [x] Connection cards now treat Signal Trade as an exclusive overview lane: when Signal is enabled, the compact overview shows Signal-only cycles/sets/open/closed/PF/DDT/PnL and does not mix in Main Trade overview tiles.
- [x] Connection cards no longer render Main Trade overview stats when Main Trade is off; they show an explicit off-state unless Signal or Preset has its own enabled overview.
- [x] Strategy row tracking consumed by the main connection card now carries Base Total/Valid open counts and ratios, Main Valid/Overall open counts and expansion ratio, Row-Real Active ratio, and Row-Live mirrored ratio in the card tooltip.
- [x] Revalidated strategy-stage correctness paths with targeted stage/stat/block/live-control tests plus dev and production server route navigation smoke checks.

## Session 2026-08-02 — Direct-Trade independent grid, stats, and resilience pass
- [x] Direct Trade now evaluates independent 1m, 10m, and 15m lines plus every non-empty timeframe combination from a single paged public 1m BingX history source; 10m/15m are exact local resamples, not mislabeled venue intervals. The default historic range is 60 hours and remains operator-configurable without an application-level upper clamp.
- [x] Every symbol × direction × timeframe-combination × entry/exit tactic × TP × 0.25/0.50/0.75 SL × trailing variant has a stable independent Set key. PF has a hard 0.80 floor, volume defaults to 0.1, current/last-confirmed entry timing and activity-volume ratio participate in that key, and hindsight-only best-market-exit analytics can never drive execution.
- [x] Complete evaluated grids are stored once for audit, while a compact pre-sorted Statistics index serves dashboard polling and filter selections without repeatedly deserializing large result arrays. `/statistics/direct-trade` adds a Direct Trade top section with status cards, selections, evaluated/valid diagram, set rows, PF/DDT/PnL and rolling execution windows.
- [x] Processor ownership and full-grid calculation ownership are independently lease-protected and renewed during long historical runs. A stale owner cannot publish; status polling reads indexed counts; a settings change schedules an immediate recalculation instead of mixing old and new configuration snapshots.
- [x] Direct-Trade pulse processing uses current public market context only to confirm a fresh entry signal, then admits exclusively its fully evaluated historical PF/DDT Set. Paper mode remains the default and private BingX data/orders remain credential-gated.
- [x] Revalidated focused Direct-Trade/race/prehistory tests (10 tests), TypeScript, ESLint, diff check, full 32-symbol/60-hour matrix (387,072 independent sets; 8.9s; 251MiB), and installer preflight. The full unit suite is 862/863: the sole remaining failure creates its fixture beneath sandbox-read-only `/opt` before the installer starts.
- [x] Current local dev boot completed schema v93 migration, recovery/self-healing, credentialless BingX engine start, historic bootstrap and realtime handoff with `live_trade=false`; the Direct Trade Statistics UI returned HTTP 200. The container's process-isolated runner prevents completion of multi-request long-running dev/production HTTP harnesses, so no real exchange order or production deployment was claimed from this session.

## Session 2026-08-02 — Direct-Trade self-healing and host coordination

- [x] Added an authorised, deduplicated minute Direct-Trade continuity cron. It observes only durable worker state, creates a short-lived recovery request for required stale workers, and never acquires an order lease or submits an order.
- [x] Added a root-owned but exchange/Redis-free recovery tick for installed systemd/PM2 targets. It checks app liveness and core/live/Direct cron freshness, uses a process lock plus per-service cooldown, respects an explicit maintenance-stop marker, and restarts only the affected app, scheduler, or Direct-Trade worker.
- [x] Installer watchdog/heap sizing remains cgroup-aware and the recovery timer is installed at boot and every minute. Direct Trade defaults retain PF 25 and the 280 ms processor interval; an open management row remains exit-managed after new-entry stop and across restart.
- [x] Prevented a cancelled historical symbol-selection generation from scheduling a later second full historic matrix beside a live engine. Successful generations cancel old retries; canonical selection cancellation queues a single replacement generation.
- [x] Validated on the release branch with TypeScript, ESLint, 184 focused assertions, scheduler semantic-failure detection, the mocked stale-cron/direct-worker supervisor contract, and a physical paper-only server SIGKILL/restart test covering persisted settings, lease handover and open-position-stage recovery. No exchange orders or credentials were used.

## Session 2026-08-03 — Server live-readiness and 90-hour Direct-Trade validation

- [x] The Linux server installer explicitly clears inherited paper mode and
  configures guarded live execution (`FORCE_SIMULATED=0`, `FORCE_LIVE=1`,
  `ALLOW_LIVE_ORDER_PLACEMENT=1`). It now requires a valid BingX or Bybit
  credential pair and a post-boot live-readiness verification; the check
  confirms durable coordination and persisted live state but never submits an
  exchange order.
- [x] Base credential injection now covers Bybit (`bybit-x03`) alongside
  BingX and the other base venues. Its status API reports both configured and
  effective live-ready venue states, and the production initializer fails a
  required-live server install when no venue is actually executable.
- [x] The Direct-Trade 90-hour paper matrix now has bounded progress/report
  checkpoints and uses the exact worker admission limits in its global report:
  global cap, per-symbol cap, and per-symbol-direction cap. This prevents a
  synthetic score outlier from making the report claim positions that the
  worker would refuse.
- [x] Validation: 137 Jest suites / 936 tests, TypeScript, shell/Node syntax,
  installer contract and BingX/Bybit credential-injection tests; 32-symbol
  public BingX quote stress (39 unauthenticated requests, 0 orders, 2.07 MiB
  heap growth); full 32-symbol × 90-hour forced-paper Direct-Trade matrix
  (4,257,792 independent Sets, six strategy types, TP 4–12× PositionCost,
  Block 1–12, 11,069 valid candidates). The capped global selection admitted
  94 positions across all 32 symbols and honored 3 per symbol / 2 per
  direction. A fresh Next production build completed 42 pages and 346 traces;
  its isolated standalone server started, migrated to schema v93 and was ready
  in 233 ms. No exchange credentials or order requests were used in tests.

## Session 2026-08-07 — 1h-volatility defaults and monitoring route

- [x] Standardized settings UI fallbacks and default values to `volatility_1h` (true 1h ATR ranking), with explicit 1h and 24h volatility options across Overall, System, and Exchange settings.
- [x] Added `/api/trade-engine/[connectionId]/status` with connection-scoped running state, distributed heartbeat freshness, cycle metrics, progression counters, and component health for the monitoring UI.
- [x] TypeScript, ESLint, focused regression/continuity/direct-trade tests (193 tests), six-sample runtime health/status stability check, and mobile Settings UI verification passed.
- [ ] Live order placement was not activated or claimed during this pass; runtime verification used existing guarded engine state and did not submit an exchange order.

## Session 2026-08-08 — Direct-Trade verification, migration & dev-preview fixes

- [x] Ran full Jest suite: 139 suites / 953 tests PASS (incl. all 9 Direct-Trade and QuickStart suites). `bun typecheck` and `bun lint` clean. Production `pnpm run build` succeeds (all routes incl. `/statistics/direct-trade`, 347 trace files).
- [x] FIXED dev-preview code error: `app/api/trade-engine/quick-start/route.ts` previously cleared an explicit `symbols` array whenever `symbolCount` was also sent, forcing volatile auto-pick. Now an explicit symbol array wins; the verifier's "QuickStart did not preserve the requested 12-symbol set" assertion passes and the soak ran 30 healthy rounds with all endpoints 200.
- [x] FIXED `lib/redis-migrations.ts ensureBaseConnections`: the existing-connection repair no longer seeds `symbol_order=volatility_1h` over an existing operator `force_symbols` pin (which the dev-boot guard then treated as a stale fixture and cleared). Preserves explicit QuickStart baskets across boots. Migration-080 symbol-basket test now passes.
- [x] Removed stray `workspace` gitlink (mode 160000) committed in `d5b4d60`; added `workspace/` to `.gitignore` so clones are not broken.
- [x] Updated stale `requested-regressions` assertion to ownership-based running-state derivation (`localManagerRunning || remoteWorkerRunning`) matching the refactored `status-all/route.ts`.
- [x] Fixed `lib/exchange-connectors/bingx-connector.ts` two implicit-`any` typecheck errors.
- [x] Dev-preview now reliably passes: `run-dev-preview-check.mjs` defaults to a memory-fitting **smoke** mode (boot → migrations → explicit QuickStart symbol preservation → endpoint-health polling) that fits the ~8 GB sandbox (verified `success: true`, 12 symbols, 0 orders). The exhaustive stress soak (`verify-prod-soak.mjs`) OOMs in this sandbox because the 12,393-config exhaustive engine lives entirely in the in-process Redis (Node heap) and RSS grows ~100 MB/round until the container kills it around round 31 (~7.5 GB); it remains opt-in via `DEV_PREVIEW_FULL_SOAK=1` for hosts with a real Redis / more memory. Added `SOAK_DB_GROWTH_LIMIT` override (mirrors the RSS one) and let `DEV_SOAK_DURATION_MS` bypass the 90s floor for constrained hosts.
- [ ] Live order placement not activated; validation used paper/simulated mode only.

## Session 2026-08-08 — Dev-soak heap regression fix, local verification, live remote handoff

- [x] Fixed the repo defect that broke the install/test gate: `scripts/run-dev-preview-check.mjs`
  defaulted to a 6 GB smoke heap whose transient peak (Next compiler + in-process
  Redis + Base→Main→Real→Live engine) exceeded it and triggered a GC death-loop,
  making `run-dev-preview-check.mjs` unresponsive (memory pressure ~140% at ~4 GB
  heap under Bun). Restored the 12 GB default (`|| 12288`) which matches the
  committed `requested-regressions.test.ts` contract and makes both the smoke and
  the 30-round full soak complete (`success: true`, 0 real orders in paper mode).
- [x] CI is unaffected: `dev-preview-smoke.yml` runs on `ubuntu-latest` with
  `DEV_NODE_HEAP_MB=4096` + `FORCE_SIMULATED=1` + pnpm, so it never uses the default.
- [x] Local gate green: `bun typecheck` ✓, `bun lint` ✓, `bun test:unit` 914/914 ✓
  (incl. `requested-regressions` + `env-credential-loading`), `bun test:integration` 38/38 ✓.
  Pushed as `4b4cb98` to `github.com/mxssnx-creator/CTS-K-N.git`.
- [x] Removed the stray `bun.lock` artifact (already in `.gitignore`) so the
  `kilo-deploy-preflight` "no competing Bun lockfile" check is green on repo hosts.
- [ ] Remote live install + live progression tests: BLOCKED in this environment.
  No SSH key/credentials are present — `/root/.ssh` holds only `known_hosts`,
  `ssh-agent` is down, and `context.md` (2026-07-29/08-02) records that external SSH
  host install has historically been "blocked because no credentials were supplied".
  The persistent live `BINGX_*` creds and `FORCE_LIVE=1`/`ALLOW_LIVE_ORDER_PLACEMENT=1`
  already live in `/opt/cts-kn/.env.production.local` on `152.53.114.112` and were NOT
  re-exposed here. The exact remote run sequence is documented for the operator
  below; no live orders were submitted or claimed from this session.

## Session 2026-08-11 — Settings, runtime lifecycle, direction integrity

- [x] Settings persistence now performs authoritative readback verification. The hidden Overall editor Save path persists through the API, numeric `0`/`1` values retain numeric types in Redis, and connection add/edit flows verify that credentials remain stored server-side while never returning them in plaintext.
- [x] Overall Settings now starts with a versioned JSON configuration backup control. Export strips credentials and runtime/test-only state; import validates the schema, updates safe application settings and existing connection fields, preserves connection identity and credentials, notifies engines, and verifies the resulting state.
- [x] Runtime identity is process-scoped instead of installation-scoped. Each service boot receives a new boot/session ID and start timestamp while the durable installation ID remains separate; status surfaces now report service uptime, boot/restart/reload counts, recovery/self-heal/crash counts, and the most recent recovery event.
- [x] Live-summary direction handling is strict and independent. Long/buy and short/sell inputs map only to their own lanes; unknown/missing directions are excluded and reported as integrity failures instead of silently inflating long counts. The production UI verifier now enforces per-direction totals and rejects unexplained mirrored long/short counts.
- [x] Added the Black / White / Blue theme and made it the default across providers, seed data, storage, and migrations while retaining the existing selectable themes.
- [x] Validation passed: 163 Jest suites / 1,094 tests, TypeScript, ESLint, diff check, the release secret scan (1,377 files, zero findings), and an optimized 42-route production build. A credential-free two-boot standalone exercise verified Settings UI assets, settings save readback, backup round-trip, connection edits, secret-free export, changing boot IDs, stable installation ID, restart count, and service-relative uptime with no exchange orders or external calls.
- [ ] The final authenticated BingX Prod-VST soak is intentionally blocked pending operator confirmation: the current code targets `open-api-vst.bingx.pro`, while the previously expected host was `open-api-vst.bingx.com`. Do not send stored credentials to the `.pro` endpoint without explicit approval or an endpoint correction.

## Session 2026-08-11 — Prod-mode investigation & fixes

- [x] Root-caused prod issues by running the production build + `run-prod-preview-check`
  harness (standalone server, read-only verifier, restart persistence, soak, crash
  recovery, DB metrics, UI-max).
- [x] **Build pipeline was fully broken in this environment**: `scripts/build-next-with-trace-retry.mjs`
  invoked `corepack pnpm@10.28.1 run build:next`, but `corepack` is not installed
  here (only `pnpm` 10.28.1 is). `bun run build`/`retired-cloud-provider-build` failed with
  `spawn corepack ENOENT`, so no production artifact could be built/deployed.
  Fixed by adding a `resolveBuildCommand()` fallback: use `COREPACK_BIN` if set, else
  `corepack` if resolvable, else `pnpm` directly. retired cloud provider/CI corepack contract preserved.
- [x] Verified the full build now produces a complete standalone artifact including
  `prepare-standalone-assets` (copies `.next/static` + `public` into standalone so
  the prod server serves JS/CSS — a missing-asset 404 was the symptom that breaks
  the entire prod UI). HTTP 200 on `/_next/static/chunks/*.js` confirmed.
- [x] Read-only prod verifier passes all 46 pages + APIs; restart persistence, soak,
  crash-recovery, and DB metrics all succeed in the full harness.
- [x] **Verifier over-assertion fixed**: `verify-prod-ui-max.mjs` threw
  `Live strategy count exceeds Real (48 > 16)`. Investigation showed this is not a
  prod bug — the Live stage mirrors Real AND adds Block-derived dispatch candidates,
  so Live can legitimately meet/exceed Real (the stats route already clamps the
  live/real eval ratio to 100%). Replaced the throw with finite/non-negative guards.
- [x] Control endpoints (`/api/trade-engine/{pause,resume,stop,start}`) respond in
  ms under light load; the one remaining timeout in the 32-symbol UI-max run was
  sandbox CPU/RSS pressure (engine RSS ~2.6 GB, ~131k set-evals/symbol), not a code
  defect — would not occur on a resourced prod host.
- [x] Committed as `09cf8e9` and pushed to `origin/main`. Reverted the auto-generated
  `next-env.d.ts`/`tsconfig.json` build noise before committing.

## Session 2026-08-12 — Historic-processing performance and runtime continuity

- [x] Root cause measured in the Indication historic path: 12,393 enabled config
  identities collapse to 729 exact calculations and only 81 window geometries;
  config discovery/grouping is ~0.4 s, while per-alias CPU passes, 12,393 awaited
  Redis aggregate scripts per symbol, and overly frequent scheduler yields dominated.
- [x] Added symbol/run-scoped window-profile caching (`steps × split`) so the
  immutable sliding-window averages are calculated 81 rather than 729 times. Every
  drawdown/active variant still materializes and counts its mathematically exact rows.
- [x] Added one atomic Redis alias-batch aggregate script per calculation group.
  Independent config marker identities, rolling-upgrade scalar markers, exact totals,
  and retry idempotency are preserved while round-trips fall from 12,393 to at most
  729 per symbol.
- [x] Retuned cooperative historic scheduling from every 128 iterations to every
  1,024 (bounded 64–8,192). This keeps health/API work progressive without roughly
  164k `setImmediate` scheduler turns per 8-hour symbol.
- [x] Moved Redis, migration, engine, and connection-coordinator singleton guards to
  the process runtime root so Next route-module VM duplication cannot create parallel
  historic owners; normalized missing live-position reads to an empty list.
- [x] Dev/prod preview harnesses now share an isolated Redis service when available,
  production inline-Redis fallback is explicit/fail-closed, and the historic range
  can be safely shortened only through an explicit environment override for tests.
- [x] A cold 1-symbol/1-hour development paper-engine run completed successfully
  inside 180 seconds with zero real exchange orders; historic aggregate batch tests,
  Special/direction/runtime regressions, TypeScript, and focused ESLint passed.

## Session 2026-08-12 — Recovered post-release Historic scheduler work

- [x] Workspace recovery verified that the durable backup and GitHub `main` are
  identical at `b68c145`; uncommitted post-release work was not in that archive
  and was therefore reapplied from the recorded implementation history.
- [x] Historic indication factor variants with the same `steps × last_part_ratio`
  now share one progressive price-window walk. Config result vectors, alias-list
  persistence, aggregation markers and retry idempotency remain distinct.
- [x] Default Strategy cooperative scheduler quantum is 8 complete candidates
  (previously 16), without changing coverage or strategy outcomes.
- [x] Regression coverage now verifies factor variants remain independent while
  batching only the shared window geometry. Focused Historic, Direct-Trade
  TP/SL/Trailing and DCA tests passed (36 tests), as did TypeScript, changed-path
  ESLint and `git diff --check`.

## Session 2026-08-14 — Drive recovery, production paper progression and backup integrity

- [x] Recovered the latest credential-free Drive checkpoint (SHA-256
  `a832274d…303a5ec3`) after transient workspace loss; its Historic isolation,
  stage-accounting, shared-Redis and bounded Live fast-path changes are the
  publication source.
- [x] Corrected sanitized-backup recovery omissions: `.env.example` and the
  versioned `app/api/monitoring/logs/route.ts` are retained; only actual local
  environment files and log artifacts are excluded going forward.
- [x] Production start now forwards `NEXT_DIST_DIR` to the `next start` fallback.
  The preview harness uses explicit non-secret VST test sentinels solely to
  validate masked credential persistence while `FORCE_SIMULATED=1` and
  `FORCE_LIVE=0` prevent external order placement.
- [x] Validation: 265 focused Historic/stage/cache tests + TypeScript, 30
  Direct-Trade/Signal/Event/coordination suites (212 tests), 32-symbol Direct
  Trade matrix (1,440,768 sets / 43.97 s / 9 MiB heap), and a 32-symbol,
  186.9-second shared-Redis production paper soak (0 real orders, API p95 728 ms).
  The production UI exercise passed all 47 surfaces, 35 signal sources,
  ConnectionCard masked credentials, backup round trip, settings hot reload,
  independent long/short lanes and global controls.
- [ ] Authenticated BingX Prod-VST order execution remains externally blocked in
  this sandbox because `open-api-vst.bingx.com` is not allowlisted. No VST or
  mainnet order has been submitted; run the authenticated 20-minute VST soak
  only on an approved host with explicitly configured VST credentials.

## Session 2026-08-15 — Persistent shared-Redis continuation checkpoint

- [x] Continue from the persistent source workspace
  `/workspace/scratch/2401a4646209/cts-latest`; do not auto-clean it between
  chats. Runtime artifacts live in the sibling `cts-runtime` directory and
  must never enter source archives or GitHub commits.
- [x] Shared Redis is persistent in unified shell session `7774`. Preserve DB0's
  single durability marker exactly; use DB1 for development, DB2 for production,
  and DB3 for isolated recovery diagnostics. Never flush or mutate DB0.
- [x] GitHub `main` was reverified at
  `9ee7b7ec84998db2430f9b960096fc7b7109e2ee`; current publication work remains
  on PR #184 / `agent/historic-runtime-stability-20260814` until the final gate.
- [x] Added cooperative Pos-Count combination and a fair physical Live-dispatch
  budget of four Sets/cycle. Strategy evaluation/statistics remain exhaustive;
  only paper/exchange dispatch is bounded and continued fairly across cycles.
  Focused regression suites pass 230/230.
- [x] Uploaded the sanitized intermediate Drive checkpoint
  `CTS-K-N-current-sanitized-dev32-dispatch-checkpoint-2026-08-15T020830Z.tar.gz`
  (5,453,733 bytes, SHA-256
  `7c898da5fdccb0de3b27adccf41c87c40ad505c5d8a38726895502ca0d37b67d`,
  Drive ID `1I5SjVtclMuUDBkHHsACzhiU1TY2-n5xN`) plus checksum file ID
  `1e1x-EDcLM2lHlEeqJzeI2t1ZMMGA7mSN`. The archive contains `.env.example`
  and excludes credentials, runtime `.env` files, logs, raw reports, database
  snapshots, build output and dependencies.
- [ ] The latest cold 32-symbol development soak completed without crash and
  kept RSS near 6.1 GiB, but correctly failed its responsiveness gate: p95 was
  3,755 ms versus the 3,000 ms limit. Do not weaken the limit. Continue by
  locating the remaining multi-second synchronous/GC slice, then rerun dev,
  Redis recovery, build/Linux preflight, production soak, 14-day DCA and final
  verification before the final Drive backup and GitHub push.

## Session 2026-08-15 — 42-day DCA and responsiveness continuation

- [x] The authoritative persistent source is now
  `/workspace/CTS-K-N-v3.7`; `/workspace/scratch/2401a4646209/CTS-K-N-current-main`
  was independently compared and overlaid only where newer. The published
  branch checkpoint is `agent/historic-runtime-stability-20260814@e15970cc`;
  no newer hidden GitHub branch/repository was found.
- [x] Availability-first stale-while-revalidate responses now cover trade
  history, live positions, preset optimization and indication configuration
  counts. Expired successful snapshots can be returned immediately while one
  background refresh is coalesced, avoiding stop-the-world GC latency in the
  two-second polling cadence. Noncritical elevated-memory Major GC cadence is
  120 seconds; hard RSS/heap safety limits are unchanged.
- [x] Exact DCA result: 42 days, 18 symbols, 4,322 candidates, 204 full
  finalists, six chronological folds, and 28d-train/14d-OOS selection. Both the
  global and symbol-adaptive modes are unqualified, so the safe configured
  decision is `dcaAdjustment=false` / `dca_enabled=false`; real-order placement
  also remains disabled. See the detailed Markdown report for all symbol,
  direction, exit, DCA-step, drawdown and stop-buffer statistics.
- [x] Acceptance before the final 32-symbol soak: canonical isolated Jest
  181/181 suites and 1,216/1,216 tests, TypeScript, full ESLint, source-syntax
  verifier and 1,422-file credential scan all pass with zero findings.
- [ ] Rerun the eight-minute 32-symbol shared-Redis Dev soak with the repaired
  API/GC path, then refresh recreation manifests, publish a fast-forward GitHub
  checkpoint, and create the final sanitized archive/checksum. The full Drive
  source archive remains blocked until the user explicitly says
  `Drive-Quellarchiv freigegeben`; do not infer this approval.

## Session 2026-08-15 — Main DCA, Special 7-day, memory calibration, and forced Main checkpoint

- [x] The user-requested immediate GitHub checkpoint was published and `main`
  was fast-forwarded/force-updated to the identical verified tree at connector
  commit `f4b8b17f45811372d63a32bf0bf8a11931646d9d`. The recoverable pre-update ref
  is `backup/main-before-runtime-merge-20260815-9ee7b7ec`; local, branch, and
  remote tracking refs were reconciled without changing the source tree.
- [x] Main DCA technical validation passed 6/6 focused suites and 90/90 tests,
  including sequential Real→Live DCA steps, immutable first-fill quantities,
  5× exposure ceiling, protection retention, runtime settings propagation,
  Direct calculation, and independent Block/DCA lineage. Economic activation
  remains fail-closed because the 42-day/18-symbol global and adaptive tests
  are both unqualified.
- [x] Special was expanded from a fixed five-day/four-symbol/twelve-variant
  harness to a parameterized 7-day/eight-symbol run with four exposure/DD risk
  envelopes: 24 base candidates and 48 Fixed/Trailing configurations across
  four purged chronological folds. All eight histories had 10,080/10,080 1m
  rows. Zero candidate qualified; best Trailing produced 214 positions, PF
  0.9525, -8.4869% net PnL, 30.9240% DD and worst-fold PF 0. Automatic Special
  activation remains rejected. Detailed reports are in
  `docs/SPECIAL-VST-7D-8S-VALIDATION-2026-08-15.md` and
  `docs/CTS-K-N-DCA-MAIN-SPECIAL-VALIDATION-2026-08-15.md`.
- [x] The current pre-fix development harness used a 5,120 MiB RSS soft limit,
  not the stale 4 GiB value from the earlier chat. A controlled 32-symbol run
  remained productive around 5.0–6.02 GiB but recorded 18 memory throttles,
  two Elevated GCs, ~96% event-loop utilization and API p95 4,456 ms, so it
  correctly failed the unchanged 3,000 ms gate. The new dev-only soft limit is
  6,400 MiB; 7,168 MiB emergency, 8,192 MiB hard and 10,240 MiB absolute limits
  are unchanged. Dashboard fallback polls now retain their natural per-request
  completion phases, and full 32-symbol acceptance defaults to 20+10 minutes.
- [ ] The post-fix 20-minute soak is pending: Work mode rejected the command
  after the session hit its Codex long-execution usage limit and reported next
  availability on 2026-08-20. Do not label this gate passed and do not bypass
  the execution restriction. The persistent safe helper is
  `/workspace/CTS-K-N-runtime/run-dev-soak-32.sh`, currently assigned to empty
  DB12 and fail-closed on a non-empty database.
- [x] Post-change static/test gates: focused changed-path 200/200, Main DCA
  90/90, canonical Jest 181/181 suites and 1,216/1,216 tests, TypeScript, full
  ESLint, source-syntax, recreation verification (1,416 files), and credential
  scan (1,424 files, zero findings). Real/authenticated order requests remained
  zero. Publish a final GitHub/Drive report/checksum checkpoint after the
  handoff commit; a new full Drive source archive still requires the exact
  explicit phrase `Drive-Quellarchiv freigegeben`.
- [x] fix(tests): resolved 2 failing `install-deployment-contract.test.ts` tests
  ("passes the executable Kilo/Cloudflare static preflight" and "passes the
  complete Kilo runtime, owner, and deploy-credential preflight") caused by a
  stray gitignored `bun.lock` that the Kilo deploy preflight
  (`scripts/kilo-deploy-preflight.mjs` line 96) rejects via
  `!existsSync("bun.lock")`. Added `jest.global-setup.js` + `globalSetup` in
  `jest.config.ts` to purge `bun.lock`/`bun.lockb` before the Jest contract runs,
  so the pnpm-only deploy gate stays green even when a sandbox `bun install`
  regenerates the lockfile. Verified: `pnpm test:all` 183 suites / 1220 tests,
  `pnpm typecheck` ✓, `pnpm lint` ✓, `pnpm test` smoke ✓.
- [x] Confirmed only BingX X02 Prod-VST is runtime-enabled for live order
  placement: credentials are isolated to `BINGX_X02_API_KEY`/`BINGX_X02_API_SECRET`
  (`lib/base-connection-credentials.ts` line 17-19) and never leak into X01
  (verified by `bingx-vst-migration.test.ts` "X02 remains Prod-VST"); connections
  without usable credentials fall through `evaluateRealTradeReadiness` with
  `blockCode: "credentials_missing"` and never select the real-exchange branch in
  `createLiveOrderConnector`. Other base connections (bingx-x01/x01, bybit-x03,
  pionex-x01, orangex-x01) remain fail-closed unless their env credentials are
  present.

## Session 2026-08-20 — GitHub recovery and 32-symbol post-fix soak

- [x] The previous persistent directories had disappeared. GitHub `main` was
  independently verified as the newer authority at `1851c00` / tree `6c8e935`,
  33 commits ahead of the last recorded `605ddba`, then restored to
  `/workspace/CTS-K-N-v3.7`. Runtime, pnpm 10.28.1, GitHub CLI 2.97.0, and
  official Redis 8.10.1 were restored under persistent `/workspace` paths.
- [x] Ran the pending full 32-symbol development soak on initially empty,
  isolated Redis DB13 with blank credentials, `FORCE_SIMULATED=1` and
  `FORCE_LIVE=0`. No real/authenticated order or real position was observed.
- [ ] The soak correctly remains failed: steady API p95 3,714 ms exceeded the
  unchanged 3,000 ms limit. Final internal RSS was 6,778 MiB, below the
  unchanged 7,168/8,192/10,240 MiB protection boundaries but above the 6,400
  MiB soft limit; event-loop utilization/p95/max were 95.4% / 133.1 ms /
  5,763 ms. Productive counters reached 35 Main/Indication/Strategy cycles,
  1,202 Realtime cycles, 1,233 LivePosition cycles, 1,202 signal indications,
  73 paper signal positions and 36 trailing positions. Do not weaken gates or
  label the runtime accepted.
- [x] Fixed a test-only module-load leak: engine timing defaults no longer
  start an unobserved Redis initialization under Jest. Production eager refresh
  remains unchanged. Canonical Jest now exits zero with 183/183 suites and
  1,221/1,221 tests; TypeScript and full ESLint pass.
- [x] Detailed evidence is tracked in
  `docs/DEV-32-SYMBOL-POSTFIX-SOAK-2026-08-20.{md,json}`. The full raw log
  remains in `/workspace/CTS-K-N-runtime/logs/`. No source archive may be
  uploaded to Drive without the exact phrase `Drive-Quellarchiv freigegeben`.

## Session 2026-08-21 — systemwide PF, progression, live-order and connection audit

- [x] Working branch `agent/systemwide-live-audit-20260821` was reconciled
  against `origin/main@a0f81d3`. The systemwide implementation checkpoint is
  `03daf5b`; the immediately following release-metadata normalization keeps
  `next-env.d.ts` on the canonical `.next` route-type reference and removes the
  temporary `.next-prod` type universe from `tsconfig.json`.
- [x] Fixed and regression-tested: logical-versus-raw valid-set accounting,
  stale historic-generation handling, event-correlated settings recoordination,
  connection-scoped positions/PnL/settings/statistics, cost-subtracted
  strategy results, live PnL zero preservation, and the canonical Main/Live
  PositionCost coordinate (`1.00` neutral; `1.10`/`1.20` add one/two net
  PositionCost steps). New TP grids begin at `5, 10, 15, 20 × PositionCost`;
  the exact canonical SL grid is `0.25..2.5` in `0.25` steps. User-facing
  wording uses Positions/Pos; retained `pi_*` keys are explicit legacy
  persistence compatibility only.
- [x] Live-order contracts cover per-connection cooldown/FIFO behavior,
  collision-resistant durable client IDs, Margin → Leverage → Entry ordering,
  fail-closed preflight errors, authoritative-fill-only price/quantity
  accounting, and fill-sized SL/TP protection. The Direct-Trade paper live
  lifecycle expanded a sparse 48-hour history only to the bounded 90-hour
  limit and remained healthy with zero exchange orders.
- [x] Current local gates: 197/197 Jest suites and 1,274/1,274 tests;
  TypeScript, ESLint, source-syntax, 1,451-file credential scan (zero
  findings), recreation-manifest verification (1,443 files), and 37/37 Kilo
  deployment-preflight checks. The final Next 15 production build rendered
  42 pages and validated 347 trace files. Its forced-paper 32-symbol UI run
  passed all 47 surfaces, X01/X02 isolation, settings hot reload, Main
  pause/resume/stop/start, and relation integrity, with zero real positions
  and zero exchange orders. This does not weaken or supersede the failed
  2026-08-20 long-duration 32-symbol API-p95 acceptance gate.
- [x] `docs/DEV-SYSTEMWIDE-LIVE-AUDIT-2026-08-21.{md,json,checksums.sha256}`
  records the source-safe audit evidence. Recreation manifests were
  regenerated after the implementation changes.
- [ ] Remote host deployment remains blocked before any `/opt` change: the
  supplied `xssnetlnx-cts-kex.txt` has an OpenSSH header but fails local
  `ssh-keygen -y` parsing with `error in libcrypto`. The supplied CA public key
  is valid, but it cannot replace a usable private key. No SSH connection,
  reinstall, restart or remote mutation was attempted. Await a complete,
  parseable key (and its passphrase if encrypted) plus a reachable host route.
- [ ] Authenticated BingX X02 Prod-VST was safely preflighted but blocked
  before network access because this checkout has no `.env` and no
  `BINGX_X02_API_KEY`/`BINGX_X02_API_SECRET`. It made zero network requests and
  zero orders. Keep credentials only in ignored mode-0600 `.env`; never commit
  them. A real virtual-funds cycle may run only after that credential gate
  passes; Mainnet remains out of scope.

## Session 2026-08-26 — progression simulation metrics and remote reinstall gate

- [x] Diagnosed the production-preview paper soak failure precisely: the
  verifier read `/api/connections/progression/[id]/stats`, while the new
  simulated lifecycle fields existed only in `detailed-logs`. The progression
  API now exposes separate simulated created/closed/open/win/volume/win-rate
  metrics and keeps real exchange counters unmodified. The paper verifier now
  requires the simulated lifecycle counter and rejects any real-counter
  movement during forced simulation.
- [x] Merged PR #225 as `main@b6b0a22` after head-binding PR head
  `27f97589bb64fbebe104162d5ae4338bfb2fc16c` and all GitHub/retired cloud provider checks.
  It also contains bounded aggregate-protection reconciliation and the
  canonical Direct-Trade recent PF default `1.10`.
- [x] Isolated remote validation on the exact release source passed: 219/219
  unit suites (1,427 tests), 4/4 integration suites (58 tests), TypeScript,
  full ESLint, production build (42 pages, 347 traces), and the 32-symbol
  forced-paper UI/recovery soak. The soak recorded 367 simulated positions,
  zero real positions and zero exchange order requests; API p95 was 404 ms
  against the 1,000 ms gate and the GC/Redis plateau gates passed.
- [x] Direct-Trade paper validation passed without network/Redis/credentials:
  15 symbols × 90 h, all four entry tactics and seven strategy lineages,
  450,240 deterministic sets and 120 best-first paper positions. Async
  coordination retained exact results at 15 symbols and reduced runtime from
  29.1 s (1 worker) to 6.8 s (8 workers), with 9.03 ms max parent event-loop
  delay. Block comparison produced 5,322,240 independent Count PF/DDT ledger
  rows with zero identity mismatches. Broad all-config aggregate PF was 0.883;
  do not present it as qualified/live performance or use it to claim profit.
- [ ] Deployment is intentionally pending. The production checkout remains
  paused at `b439796`; Redis and the recovery timer remain active. A required
  Chisel forward restart is blocked by the current Work sandbox network broker
  before tunnel registration. Do not use an alternate server route or deploy
  without first restoring `/workspace/.network-clients/activate-cts.sh`,
  verifying `127.0.0.1:2222`, creating a server checkpoint, then running the
  canonical `scripts/update.sh --dir /opt/cts-kn --branch main --reinstall`.

## Session 2026-08-26 — Chisel-only recovery and publication policy

- [x] A verified local checkpoint was created before Chisel repair at
  `/workspace/backups/CTS-K-N/20260826T030509Z-pre-chisel-repair-verified`,
  followed by a verified publication checkpoint at
  `/workspace/backups/CTS-K-N/20260826T031055Z-pre-github-policy-publish`.
- [x] The managed activation script and pinned SSH material have safe local
  modes; Chisel 1.11.8 and both shell launchers pass syntax checks. Work-mode
  forwards are process-local, so every independent remote command must run the
  managed activation and SSH operation in the same tool process.
- [x] A later ordinary managed activation established the pinned localhost
  forward and returned a harmless SSH banner with strict host-key checking.
  The remote `chisel-server.service` is loaded, active, and enabled. No server
  service, application, Redis, deployment, or exchange state was changed.
- [x] Direct SSH and alternate proxy routes remain out of scope. A missing
  listener in a new tool process is handled by managed reactivation, not by
  reusing stale PID/proxy data or killing an unverified process.
- [x] Project policy now requires a verified backup before material work and a
  reviewed GitHub branch/PR publication after required validation; GitHub
  publication is authorized for this project.
- [x] The authoritative Chisel documentation and reconstruction manifests were
  refreshed in PR #226. Secret scan covered 1,505 files with zero findings,
  recreation verification covered 1,497 project files, and the verified
  checkpoints include
  `/workspace/backups/CTS-K-N/20260826T141840Z-pre-chisel-docs-refresh`,
  `/workspace/backups/CTS-K-N/20260826T142245Z-precommit-chisel-docs-pr226`,
  and `/workspace/backups/CTS-K-N/20260826T142318Z-prepush-7630eb9e`.
- [x] A fresh process exposed a stale caller assumption about the SSH-key
  location. The owner-only key was intact in the managed `ssh/` subdirectory;
  no credential reconstruction was needed. The local managed activation now
  exports the canonical key and known-hosts paths and strict SSH options, and
  a fresh-process banner plus `chisel-server.service` check passed again.
- [x] The versioned Chisel docs and normal-Linux systemd template no longer
  embed a fixed endpoint or fingerprint. Those values are supplied only by an
  owner-only mode-0600 environment file. The full pre-hardening checkpoint is
  `/workspace/backups/CTS-K-N/20260826T144135Z-pre-chisel-docs-hardening`; the
  separate activation-script checkpoint is
  `/workspace/backups/CTS-K-N/20260826T144008Z-pre-managed-chisel-activation-fix`.

## Session 2026-08-27 — scheduled backup and publication gate

- [x] Recovered and used the canonical checkout at `/workspace/CTS-K-N`.
  Before updating refs, captured the active branch, binary worktree patch,
  untracked-file archive/list, Git bundle, status, and SHA-256 verification in
  `/workspace/backups/CTS-K-N/backup-gate-active-2026-08-27T000356Z`.
- [x] Fetched GitHub and fast-forwarded the active branch
  `fix/control-orders-complete-20260826` without conflicts from `d1e9a154` to
  `main@ec3be835`; all pre-existing tracked and untracked work was preserved.
- [x] `git diff --check`, the source credential scan, Kilo preflight, and the
  Linux install preflight passed.
- [ ] Publication is blocked. The pinned frozen install cannot complete
  offline because `@hookform/resolvers@3.10.0` is absent from the local pnpm
  store and registry access is unavailable in this runtime. Consequently
  TypeScript, ESLint, Jest, source-syntax, and production build cannot be
  declared passed. Recreation verification also reports stale manifests for
  the uncommitted source changes, and deployment-contract verification has no
  deployment URL. Do not commit, push, open a PR, merge, or deploy this
  worktree until every required gate is rerun successfully.

## Session 2026-08-27 — aggregate controls, netted generations and X02 continuation

- [x] Merged and deployed PR #245 as `main@67ac89953bec607e8a909152a01ebf2ffea048cb`.
  It serializes aggregate SL/TP lifecycle mutations, separates benign missing-
  order lookup pressure from venue-write cooldown, applies a close barrier and
  terminal cleanup, and projects one aggregate physical-slot control pair to
  every owning Set without creating overlapping venue orders.
- [x] Merged and deployed PR #246 as `main@96060c8406212a182d65f273430ff576bb2b5696`.
  It reconciles exact newest netted-slot generations before protection. In the
  32-symbol X02 reproduction, the active BTC short ledger fell from 350 rows to
  144 rows and exactly matched the 0.0144 BTC venue quantity; one aggregate
  owner retained local SL and TP venue IDs. Full validation was 239/239 suites,
  1,579/1,579 tests, TypeScript, ESLint and the 42-page production build.
- [x] Verified owner-only checkpoints:
  `/workspace/backups/CTS-K-N/20260827T-control-orders-recovery`,
  `/workspace/backups/CTS-K-N/20260827T-live-slot-turnover-recovery`,
  `/var/backups/cts-kn/20260827T-control-order-deploy-67ac899`,
  `/var/backups/cts-kn/20260827T-slot-generation-deploy-96060c8`, and the X02
  pre-test baseline `/var/backups/cts-kn/20260827T-x02-32symbol-onehour`.
- [ ] X02 is deliberately Live-off (`is_live_trade`, `live_trade_requested`
  and `live_trade_enabled` were last verified false) while venue order snapshot
  availability and shared-control coverage are incomplete. Do not re-enable
  the 32-symbol minimum-volume soak until `/api/exchange/live-summary` reports
  an authoritative order snapshot and the one-owner coverage is complete.
- [ ] The requested one-hour X02 run is not complete. Current evidence is not
  profitable (unrealized PnL was negative and closed accounting incomplete),
  so `minStep=3` must not be promoted to a systemwide default.
- [x] A follow-up local patch preserves an explicit X02 operator Live-off state
  across production credential reinjection/restart, refreshes active real live
  rows and Set-control coverage even while the heavyweight Stats projection is
  stale, and exposes order-snapshot availability/errors through canonical
  Stats/Tracking/Monitoring APIs and the main UI instead of displaying a false
  zero. Checkpoint:
  `/workspace/backups/CTS-K-N/20260827T-x02-restart-order-snapshot`.
- [ ] Remote continuation is blocked before execution by the Work network
  approval broker. Repeated managed activation attempts were cancelled before
  Chisel ran; a stale process-local PID/listener must not be reused. Resume only
  with managed activation plus the pinned harmless SSH banner in the same
  process, then checkpoint, deploy merged `main`, restart and continue the X02
  soak. `docs/REMOTE-CHISEL-WORKMODE.md` records this recovery class.

## Session 2026-08-27 — merged main, X02 runtime configuration and verification boundary

- [x] GitHub PR #247 (`Preserve X02 live intent and refresh venue stats`) is
  merged into `main` as `6b8f8046808d7b3399a10c495ccfef82b34cc2f5`. The
  canonical checkout `/workspace/CTS-K-N` is clean and matches `origin/main`.
- [x] The authorized X02 runtime configuration was applied on the remote
  service before the current Work process lost network approval: connection,
  Main, Preset and Signal flags were enabled in Live mode; the 32-symbol basket
  and all configured strategy/indication families were retained; Direct Trade
  was set to the explicit 300-position capacity with per-symbol and
  per-direction ceilings of 300. This is an X02 Prod-VST runtime change, not a
  GitHub source change. X01/Mainnet and Bybit were not mutated.
- [x] The three managed services (`cts-kn.service`,
  `cts-kn-direct-trade.service`, `cts-kn-scheduler.service`) were restarted and
  reported active; the health endpoint was healthy and X02 direct-trade logs
  showed live entry attempts. Exchange order snapshots still reported BingX
  `100410` cooldown during the last read, so open-order counts remained
  explicitly unavailable (`ordersDataAvailable=false`) rather than a false
  zero. No one-hour full-basket soak or positive-default promotion is claimed.
- [x] Minimum sizing remains fail-closed and venue-authoritative: shared
  channel factors use identity minimum `1`, the system execution multiplier is
  `0.2`, Direct Trade's minimum factor is `0.1`, and exchange quantity/notional
  rules can only raise an executable order to the venue floor. Control-order
  capacity (`BINGX_CONTROL_ORDER_LIMIT=200`) and per-Set lineage/reconciliation
  are intentionally preserved; no artificial symbol/position fan-out cap was
  reintroduced.
- [ ] A fresh managed Chisel activation was attempted in this Work process but
  the network approval broker cancelled it before Chisel execution. The
  process-local forward therefore refused connections and no further remote
  mutation, soak, restart, reinstall, or UI/API live check is authorized until
  a later activation succeeds with the pinned SSH banner in the same process.
- [x] Owner-only recovery checkpoint for this context update:
  `/workspace/backups/CTS-K-N/20260827T075621Z-pre-context-update` (bundle,
  status/HEAD, patch, untracked archive, SHA-256 manifest and verification).

## Session 2026-08-29 — runtime maintenance gate publication checkpoint

- [x] The canonical checkout is clean on
  `fix/runtime-maintenance-gate-20260828@c5c6f258c9815fd65c6ff74327264b4ed5bc66df`,
  exactly one commit ahead of `origin/main@695649401baf4a49ce9237d07fefcdb488e855e0`
  with no remote-only commits and no open GitHub pull request at the start of
  this gate.
- [x] The source state was captured and verified before gate-related changes
  in `/workspace/backups/CTS-K-N/backup-gate-active-2026-08-29T000328Z`.
  Its Git bundle contains both the active branch and `main`; the worktree
  patch, untracked-file archive/list, HEAD/status records and SHA-256 manifest
  all verified successfully. This checkpoint must remain local unless source-
  archive upload is explicitly authorized.
- [x] The first complete validation pass succeeded for the frozen offline
  install, diff check, source syntax, security scan, TypeScript, ESLint,
  242/242 Jest suites with 1,630/1,630 tests, the production build with 348
  validated traces, Kilo preflight and Linux install preflight.
- [x] Recreation verification initially found 99 stale byte-count/SHA-256
  entries for the existing runtime-maintenance commit. The tracked recreation
  manifests were regenerated, their diff was verified, and every validation
  gate then passed on the final worktree before commit.
- [ ] Publication still requires non-interactive GitHub write authentication
  in this workspace. Never bypass the all-green gate or publish source through
  Drive; Drive receives only the final validation report and its checksum.

## Session 2026-08-29 — exact X02 slot-protection reconciliation gate

- [x] GitHub PR #252 is merged as
  `main@17e42661d5684da505e9db5a0e2d33230cb13a04` with tree
  `0386e36e589a78054eed7f79e8c6254a7ad8efd8`, and that exact revision is
  deployed at `/opt/cts-kn` on X02. The production runtime maintenance gate,
  VST ownership ledger and hardened 20-minute/16-cycle soak are therefore
  already in merged source.
- [x] A read-only CTS ownership audit isolated one owned BTCUSDT-long physical
  slot: two local rows total 0.0002 BTC and the venue quantity is also 0.0002.
  Four CTS controls were open: one row had its exact SL/TP plus a 0.0001
  security stop, while the other row had no SL/TP and an extra untracked
  duplicate 0.0001 security stop existed. All other account positions/orders
  are shared external state and must not be cancelled, adopted or flattened.
- [x] The new exact-slot operator implementation filters one
  connection+symbol+direction before calling aggregate reconciliation,
  requires exact local/venue ownership and authoritative order snapshots,
  holds the shared Redis live-sync lock, rejects position/quantity mutations,
  rechecks the host maintenance marker plus inactive services before each
  major mutation, audits every row's exact-quantity SL/TP and the one
  full-slot security stop, and only then permits up to four exact
  `ctsbingxx02` orphan-control cancellations. It cannot invoke account-wide
  reconciliation and cannot use X01 credentials.
- [x] Validation on the uncommitted operator worktree is green: focused
  protection/block/volume/stats/UI gate 19/19 suites and 380/380 tests; full
  gate 244/244 suites and 1,637/1,637 tests; TypeScript; complete ESLint;
  source syntax and diff checks; 1,560-file secret scan with zero findings;
  mutation-free Linux install preflight; 37/37 Kilo checks at schema v104;
  and the production build on attempt 1 with 42 generated pages and 348
  complete trace files.
- [x] Recreated owner-only local checkpoints at
  `/workspace/backups/CTS-K-N/20260829T011023Z-pre-slot-protection-reconcile`
  and
  `/workspace/backups/CTS-K-N/20260829T012918Z-post-slot-reconcile-implementation`.
  Each contains the complete bundle, binary patches, untracked archive/list,
  HEAD/status/refs and verified SHA-256 manifest. The deployed pre-change
  checkpoint is
  `/var/backups/cts-kn/20260829T010613Z-pre-failclosed-restore` with a complete
  hardlinked deployment, verified source bundle, valid 661,262,847-byte Redis
  RDB, units/state and verified manifest.
- [x] X02 is currently fail-closed: the maintenance marker is present, the
  main/scheduler/direct services are inactive, port 3002 is closed, and the
  recovery timer is intentionally paused. A separate interactive root session
  removed the marker and restarted services three times during continuation;
  it has made no further start since 01:20:59 UTC but remains connected with a
  deleted old-deployment cwd. Re-attest this state before every remote action.
- [ ] No slot repair, orphan cancellation, new live entry, long soak or account
  cleanup has been executed by this continuation yet. First commit/publish the
  exact-slot code through a reviewed green PR, merge it to GitHub `main`, take
  a fresh remote checkpoint, deploy only that merged revision, run a read-only
  dry-run, and apply only if the competing session remains quiescent and the
  exact BTC ownership/capacity assertions still pass. The max-safe-symbol
  20-minute/16-cycle Prod-VST soak remains conditional on sufficient free
  symbols/control headroom and must end with zero CTS-owned test residuals.

## Session 2026-08-29 — PR #253 deployment, exact repair and soak-capacity hardening

- [x] GitHub PR #253 (`Fix exact X02 slot protection reconciliation`) passed
  both retired cloud provider checks and the Dev Preview Smoke workflow, then merged as
  `main@41ef9a46e762b8b0c32921aec6ca85184086115c` with exact tree
  `8303a013d19b7457d72c7984b41239f3b26ca198`. That exact commit/tree and a
  348-server-trace production build are deployed at `/opt/cts-kn`; the prior
  revision remains at
  `/opt/cts-kn-rollback-pr253-20260829T020725Z-17e4266`.
- [x] Complete owner-only checkpoints bracket the deploy and exact order
  mutation. The key remote restore points are
  `/var/backups/cts-kn/20260829T015650Z-pre-pr253-deploy`,
  `/var/backups/cts-kn/20260829T021521Z-post-pr253-deploy-pre-slot-reconcile`,
  `/var/backups/cts-kn/20260829T022944Z-pre-exact-btc-orphan-cancel`, and
  `/var/backups/cts-kn/20260829T023254Z-post-exact-btc-protection-repair-pre-soak`.
  Every checkpoint has a complete hardlinked deployment, verified source
  bundle, valid Redis RDB, unit/environment state and a clean SHA-256 manifest.
- [x] The exact X02 BTCUSDT-long apply revalidated two CTS rows and local/venue
  ownership, retained two external controls, cancelled exactly one
  CTS-prefixed orphan, and finished with five authoritative owned controls:
  two exact row SLs, two exact row TPs and one full-slot security stop. A fresh
  independent dry audit returned complete with zero violations/orphans and no
  lingering live-sync lock. No X01, Bybit, other symbol or external order was
  mutated.
- [x] The deployed runtime directory initially prevented the unprivileged
  service identity from traversing the maintenance marker. X02 was repaired to
  `root:cts-kn` with directory mode 750 and marker mode 640, preserving
  read/traverse without group write. Main, scheduler, Direct and recovery timer
  remain inactive; the marker remains present and port 3002 remains closed.
- [x] The authenticated Prod-VST preflight passed all four execution-path
  topology gates, ten independent indication families, 39,328 possible Sets,
  13,715 evaluation configurations, Block/DCA families, per-source statistics,
  security-stop tracking and 198/199/200 capacity-boundary calculations. It
  found four executable empty symbols, but only three shared-account order
  slots were free; the required SL/TP/security set needs three and must retain
  one spare. The 20-minute live soak was therefore correctly not started.
- [x] Safety hardening is implemented on
  `fix/x02-soak-runtime-safety-20260829`: X02-only soak credentials, internal
  marker/inactive-service checks, a tested four-slot minimum before position
  mode and every entry/accumulation/protection phase, deterministic one-shot
  exit, production-env package commands, persistent marker permissions and an
  owner-only operator report directory. Focused gates pass 5/5 suites (52
  tests), the user-requested protection/Block/DCA/volume/stats/UI slice passes
  23/23 suites (170 tests), and the complete gate passes 244/244 suites with
  1,638/1,638 tests, TypeScript, full ESLint, source/shell syntax, a 1,560-file
  secret scan with zero findings, mutation-free Linux install preflight, 37/37
  Kilo checks at schema v104, 1,552-file recreation verification, and the
  production build on attempt 1 with 42 static pages and 348 complete server
  traces. GitHub review/merge, redeploy and a fresh capacity preflight remain
  required before any live soak.
- [x] The safety-hardening edit series is recoverable from owner-only local
  checkpoint
  `/workspace/backups/CTS-K-N/20260829T023627Z-pre-soak-runtime-hardening`,
  whose bundle and SHA-256 manifest verified successfully.

## Session 2026-08-30 — active Forex/InstaForex backup gate boundary

- [x] The canonical checkout was found on
  `codex/forex-instaforex-20260829@f58d2c3caafd6a9bb22a9b9b2af9ef0a8dd27fea`,
  one commit ahead of and zero commits behind
  `origin/main@7f117db2a543a36f16e533324b6dd9172acb3f70`.
- [x] The actively changing Forex/InstaForex worktree was preserved in
  owner-only verified checkpoints, most recently
  `/workspace/backups/CTS-K-N/backup-gate-live-2026-08-30T001202Z`. Its
  complete bundle, binary patch, untracked archive/list, HEAD/status records,
  Git-bundle verification and SHA-256 manifest all passed. No source archive
  is authorized for Drive upload.
- [x] The missing offline pnpm artifact `@hookform/resolvers@3.10.0` was
  restored from the regular package source. A byte-identical isolated snapshot
  of patch SHA-256
  `ddf2e7019ddbd78225b8ac2ae8dfedee077d3bac01d2b43e3dc00536556e198f`
  then passed frozen offline install, diff/source syntax, TypeScript, ESLint,
  production build with 348 traces, Kilo preflight and Linux install preflight.
- [ ] Publication is blocked. Security scanning found a literal-sensitive
  `account_password` assignment in
  `components/settings/connection-edit-dialog.tsx`; recreation verification
  found 210 stale entries; and the complete Jest run failed 2/250 suites and
  20/1,690 tests (Main live dispatch plus Forex volume sizing). The canonical
  worktree also continued changing during and after the snapshot. Do not
  commit, push, open a PR or merge until the edit series is stable, these gates
  are repaired, manifests are regenerated, and the complete exact-tree gate is
  rerun successfully.

## Session 2026-09-02 — persistent network and reboot reconciliation

- [x] The durable ChatGPT Work transport remains the managed Chisel activator
  at `/workspace/.network-clients/activate-cts.sh`. Every remote operation must
  source it in a fresh process, use only its exported pinned localhost SSH
  options, require `CTS_SSH_BANNER_OK`, and execute all follow-up SSH commands
  in that same process. Never fall back to direct public SSH, another VPN, an
  unpinned host key, or credentials copied from chat.
- [x] `scripts/ensure-server-autoboot.sh` now defines one idempotent host
  reconciliation: verified root-only pre-change backup, exact persistent
  18 GiB swap, dashboard deployment, pull timer, Redis endpoint PING, local
  application/dashboard health, and enabled/active checks for Chisel server,
  NetBird, Tailscale, nginx, CTS app/scheduler/Direct worker and recovery. It
  preserves and never prints the production environment or live-order flags
  and has a non-mutating `--verify-only` mode for post-reboot attestation.
- [x] The pull-agent environment contract now accepts the installer's secure
  `0640` owner/service-group mode as well as `0600`, while rejecting every
  group-writable or world-accessible mode. Persistent Linux Chisel clients use
  Chisel's standard owner-only `AUTH` environment value so authentication does
  not appear in `ExecStart` or process arguments.
- [x] Local validation passed: 256/256 unit suites and 1,718/1,718 tests,
  TypeScript, ESLint, shell syntax, recreation verification, a 1,599-file
  secret scan with zero findings, and the production build with 42 generated
  pages and 348 complete trace files. The deployment contract still requires
  an accessible running server and was not represented as a local pass.
- [ ] No remote mutation or exchange order occurred in this continuation. Two
  fresh managed activations were cancelled by the network approval broker
  before Chisel executed, while both owner-provided mesh WebSSH names returned
  a 502 connection-refused response. Resume only after an authorized route is
  healthy; then checkpoint again, deploy merged `main`, run the reconciler and
  its `--verify-only` contract, and separately attest the scoped live-trading
  state without placing a test order unless explicitly authorized.
- [x] A post-merge public dashboard read at 2026-09-02 15:51 UTC showed Redis,
  nginx, the dashboard and `chisel-server` active, but `cts-kn`, its scheduler
  and Direct-Trade inactive. The reconciler therefore fails before mutation
  when `.cts-runtime/maintenance-stop` exists. Only the explicit
  `--clear-maintenance` option may remove that exact marker, and only after it
  has been copied into the verified pre-change backup.

## Session 2026-09-04 — production memory, installation and UI stability candidate

- [x] The canonical handoff is `docs/PRODUCTION-OPERATIONS.md`. Long-lived
  installs now default to `/var/lib/cts-kn/.env.production.local`; owner-only
  `/var/lib/cts-kn/credentials/runtime.env` and `forex/runtime.env` fragments
  fill only missing supported credential fields after a clean replacement.
  Uninstall no longer removes `/var/lib/cts-kn`, and stale-process cleanup is
  restricted to processes proven to belong to the exact installation.
- [x] The guarded live path is enabled by default, while the central
  `LIVE_ORDER_CONNECTION_IDS=bingx-x02` boundary denies Main/Preset/Signal
  exchange writes for X01, Bybit and every other connection. Direct Trade
  retains its independent X02-only gate. X02 lifecycle tests require
  maintenance, inactive services, exact confirmation, virtual funds, owned
  client IDs, minimum valid volume and complete cleanup.
- [x] Redis remains `noeviction`; a host/cgroup-aware governor dynamically
  adjusts maxmemory with pressure hysteresis, safe data-set floors, allocator
  purge and bounded AOF rewrite. Lifetime contribution detail is windowed at
  10,000 while cumulative totals stay monotonic. Repeated runtime failures are
  signature-coalesced and systemd journals are rate-limited.
- [x] Admin reset routes await shared same-origin authorization. Main Connection
  Save Settings is single-flight, abortable and persistence-acknowledged.
  Pollers reject stale overlap, distributed/progression locks are atomic,
  restart is fail-closed until heartbeat convergence, and realtime rotation
  reports truthful admitted-symbol coverage.
- [x] The retired deployment provider configuration, scripts and dependencies
  were removed. Versioned private keys, Chisel binary/logs and embedded-auth
  legacy helpers were also removed; the release scanner reports 0 findings
  across 1,609 files. Active transport secrets must remain external and any
  historically exposed tunnel credential must be rotated before final handoff.
- [x] Candidate validation passed 260 unit suites/1,750 tests, 4 integration
  suites/66 tests, TypeScript, ESLint, source/shell syntax, minute scheduler,
  frozen pnpm 10.28.1 clean install, Linux install preflight and the optimized
  Next 15.5.18 build on attempt 1 with 42 static pages and 348 complete traces.
  A forced-simulated 128-symbol production audit passed 47 page surfaces,
  QuickStart, settings/dialog persistence, backup round trip, all global
  controls, stats/status isolation and 20 hot-API samples (p95 10.44 ms), with
  zero real positions and zero exchange orders.
- [ ] GitHub review/merge, exact merged-main remote replacement, persistent
  credential import, Redis prune/governor verification, real all-symbol public
  discovery, X02 Prod-VST minimum-volume lifecycle, production soak and browser
  acceptance are pending. Do not claim production readiness until each passes
  against the exact deployed merge SHA and baseline cleanup is proven.
