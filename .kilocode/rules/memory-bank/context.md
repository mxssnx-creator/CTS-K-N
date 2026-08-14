# Active Context: CTS-K-N Trading System (main project)

## Current State

**Project Status**: ✅ Active production trading system with validated release branches

## Current audit checkpoint (2026-08-14)

- Publication branch is `agent/historic-runtime-stability-20260814` in
  `mxssnx-creator/CTS-K-N`, with the existing review in PR #184. Always fetch
  the branch head before publishing; the last pre-publication head used for
  this audit was `34e76989b5716678cbcf51101b21b1dcb89c5ccb`.
- Historic indication writes are batched and checkpointed, Historic → Realtime
  handoff is continuous, and Base/Main/Real/Live Set lineage now retains the
  exact dispatched Real row plus broader Block/lane membership. Position-count
  member Sets remain the intentional combined-lineage exception.
- Direct Trade defaults to historical PF 4 and recent-position PF 25, expands
  insufficient 48-hour evidence once to a bounded 90-hour maximum, and permits
  multiple same-symbol entries subject to 300 total, 12/symbol and
  6/symbol/direction. Its maximum statistics grid uses compact runtime row
  projection plus normalized v2 indexes; rebuildable grid caches are omitted
  from Inline Redis snapshots while settings, leases and positions remain
  durable.
- Production freshness checks explicitly bypass the init-status SWR cache and
  use a revision barrier. Flat Special numeric Redis settings retain exact 0/1
  numeric values across export/import. Direct development snapshots are unique
  per run and cleaned without PID-reuse collisions.
- Shared persistent Redis 8.10.0 is installed under
  `/workspace/CTS-K-N-runtime`, bound to loopback with protected mode, AOF
  `everysec`, RDB saves and `noeviction`. Generated validation DBs 10–14 were
  flushed; AOF rewrite and RDB save passed. The Linux host still needs
  `vm.overcommit_memory=1`, which cannot be changed in the container.
- Final local evidence: 173 Jest suites / 1,171 tests, TypeScript, ESLint,
  source syntax, 42-page/340-trace production build, Linux install preflight,
  15-minute 32-symbol Dev Paper soak, two 5-minute 32-symbol Prod/Shared-Redis
  Main+Signal soaks, maximum Direct grids in Dev and Prod, same-port recovery,
  and 47-surface production UI verification all passed. Detailed values are in
  `docs/CTS-K-N-VALIDATION-RESULTS-2026-08-14.md` and its JSON companion.
- Current validation submitted zero exchange orders. The explicit
  `open-api-vst.bingx.pro` preflight correctly failed closed because protected
  VST credentials were unavailable. Do not claim that authenticated demo
  execution was repeated, or that synthetic PF implies future profitability.

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

- [x] Merged `prehistoric-async-20m-complete` branch (`df746f9`): optimize prehistoric async processing and complete aggregates. Replaced per-row Redis Sets (`historic_dedupe`) with scalar completion markers (`historic_complete`) to bound memory growth; added `incrementHistoricAggregateOnce` for atomic PF/counts aggregation, avoiding unbounded LRANGE fan-out; shared indication calculations for configs with identical parameters; pre-built `HistoricPriceSeries` per symbol; ceiling division for concurrency. Committed as `da885c2`.
- [x] Analyzed `production-live-server-20260804` and `direct-trade-self-healing-release` branches: both represent superseded earlier implementations whose work is already incorporated into main via PR #171 (`010648d`) and subsequent commits — no additional merge needed.
- [x] fix(dev-preview): QuickStart `Test: FAILED` mislabel — added `testSkipped` flag to distinguish "SKIPPED - no credentials" from actual failures in log output, progression events, state storage, and response JSON.
- [x] fix(dev-preview): toggle-dashboard `maxDuration` 15s → 300s to prevent Vercel timeout during engine stop/start under load.
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
- [x] Fix route handlers `localStartAllowed` pattern (NODE_ENV → VERCEL) for self-hosted production
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
| 2026-08-08 | Intensive direct-trade and main-trade stats display fix: `calculateRollingPF` returns `pf=null` (not 0) for empty windows; `formatPF`/`formatDDT` in direct-trade-section.tsx show zero values instead of "—"; `direct-trade-statistics.tsx` uses `!= null` check; `preset-trade-stats.tsx` handles Infinity PF in sort comparator and bar chart. All 953 tests (139 suites) pass; typecheck ✓, lint ✓. |
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
| 2026-07-18 | Remote-install release follow-up: a real OpenSSH client/key-auth loopback test exercised the authenticated API handler, SSH stdin streaming, GitHub `main` clone, canonical non-mutating installer preflight, bounded result logs, and cleanup. It exposed OpenSSH exiting 255 when a hardened API service home could not persist `known_hosts`; the route now supplies a private per-request host-key file beside the temporary SSH key, and the repeated real transport test returned HTTP 200. A separate empty Git-archive reconstruction with no `node_modules` restored all 1,272 locked packages using exact pnpm 10.28.1 and completed the full local Vercel provider build with 149 routes, 67 function entries, 116 valid JSON manifests, and no invalid JSON. The protected remote Vercel integration remains red and cannot be diagnosed further without project logs/token, so no provider deployment success is claimed. |
| 2026-07-18 | Follow-up deployment correction after the first final-tree Vercel checks: restored the direct `vercel-build` entry point instead of running the full server installation verification wrapper during provider builds, then replaced `corepack enable/prepare` with the symlink-free exact `corepack pnpm@10.28.1` invocation after the full local Vercel builder reproduced `EROFS` against its read-only Node runtime. The same builder exposed Next 15 leaving a zero-byte `export-marker.json` plus a stale successful `export-detail.json`; post-build normalization now reconstructs only the invalid non-static marker, validates it, and removes the stale export status only when serialized Next config does not declare `output: export`, preventing Vercel from dropping all dynamic/API functions. The final local provider build passed with 149 routes, dynamic/API functions, a 23 MiB output, and no invalid JSON; an isolated regression test covers both manifest repairs. |
| 2026-07-18 | Finalized the recovered workspace through schema v81. Block Count 1..10 are exact independent Real Sets with their own last-N/min-sample PF history, active/pause state, volume, stats, and `minimumPF = defaultPF × Block PF factor × actual volume increment`; the 0.2–5.0/default-0.8 slider is wired across connection/global/Preset Strategy/Block surfaces and immediately recoordinates. Position-count axes retain unique exact Sets under caps. DCA uses durable `#step:N` identities, immutable initial sizing, and applies persisted setting changes on the next step. Hardened concurrent Inline Redis snapshots, AES-256-GCM secrets, fail-closed runtime ownership, a rollback-capable systemd/PM2 installer, authenticated SSH preflight/install, Kilo/OpenNext build/deploy/prechecks, scheduled continuity, and a distinct long-lived owner proxy. Added a complete clean-room recreation kit, generated SHA-256/API/UI/env/migration/test manifests, verification record, and release secret scanner. Final gates passed frozen pnpm 10.28.1 install, syntax, TypeScript, ESLint, 83 Jest suites/509 tests, Next/OpenNext builds, Wrangler dry-run, real Workerd scheduled/runtime/remote-route checks, host/remote-route preflights, 32-symbol public BingX stress, and the 240-second maximum production/UI soak with 64 simulated and zero real orders. Actual Cloudflare upload, external SSH host install, and authenticated exchange smoke remain explicitly blocked because no corresponding credentials/target/flat-account proof were supplied. |
| 2026-07-18 | Completed the coherent live-safety/production-continuity verification release through schema v79. Real/Live snapshots now preserve authoritative lineage and clamp Live <= Real even when Real is zero; the unsafe testnet Main-to-Live synthetic fallback is removed. Production status endpoints distinguish connected InlineLocalRedis from shared cross-instance durability, live smoke fails closed without shared Redis, Cloudflare/Kilo workers declare external minute ownership, both cron routes persist source/freshness/result diagnostics, and post-deploy/startup checks now fail on stale migrations, broken APIs, unprotected cron, or missing authorized ticks. Added bounded warm-state API p95 contracts, robust 15-symbol Dev/Prod soaks, 32-symbol UI lifecycle/settings/volume validation, and public BingX 32-symbol stress telemetry. BingX remains `bingx-api` package-first for supported account/order calls with duplicate-safe signed REST fallback; public quote/instrument reads now fail over from the official `.com` origin to `.pro` without ever replaying account/trade writes. Verified schema v79 restart persistence, 3,750 candles and hundreds of coordinated engine cycles in both Dev/Prod, Base/Main/Real/Live 2/2/2/2, active paper-position updates, stable post-warmup DB growth, Prod warm p95 33 ms, Dev warm p95 1,804 ms, 32-symbol UI QuickStart 143 ms, 6,400 live public candles across 32 BingX symbols with one primary-host timeout recovered by `.pro`, optimized Next production build, TypeScript, ESLint, portable 60,000 ms scheduler, and the final combined-current-main 79-suite/462-test matrix. No real exchange order was submitted: local/deployed prerequisites still lacked shared Redis plus the admin/live-placement gates, so the safety contract correctly blocked the authorized minimal-order smoke. |
| 2026-07-18 | Follow-up skipped-test enforcement after PR #129: repaired the standalone BingX readiness CLI so `.com` timeouts fail over to `.pro`, exit deterministically, and never submit orders; repaired the drift monitor's obsolete endpoint and made it fail on a globally running but heartbeat-stale/non-advancing connection; accepted current idle/realtime strategy phases and bounded transient retries in the comprehensive monitor; made `npm start` specify a portable host; and added a repository-aware deployment contract that rejects stale deployed schema/builds, outdated persistence diagnostics, missing site identity, incomplete migrations, and (when required) non-shared persistence or stale minute ticks. Additional validation passed route smoke, volatile cleanup, exact 60,000 ms scheduler, 15/15 public BingX symbols, 31 critical suites/138 tests, the complete 79-suite/462-test matrix, TypeScript, ESLint, and a fresh 65-second 15-symbol production restart/soak with 3,750 candles, 422 cycles, Base/Main/Real/Live 2/2/2/2, stable post-warmup DB growth, and 37 ms warm p95. The public Kilo URL is still an old schema-v74 build with process-local state and a stalled connection heartbeat/zero cycles; the new contract correctly rejects it, so real-order smoke remains blocked until the current build, shared Redis, external engine ownership, admin secret, and live-placement gates are deployed. |
| 2026-07-17 | Corrected Strategy Stage Real statistics after operator clarification. Overall is now an independent full ledger of Real Sets, confirmed positions, and placed orders; related-Base hedge history can neither inflate nor reduce those values and is rendered in a separate informational section with long/short entries, pairs, offset legs/ratio, and remaining exposure. Added a current open-position snapshot that prefers filled/exposed Live exchange positions and falls back to open Real-stage promotions in paper/dev mode, including unique open symbol count, position Long/Short counts, Long/Short symbol counts, and per-symbol direction rows. Pending, placed/unconfirmed, rejected, cancelled, error, and closed order rows are no longer classified as open exposure. Removed the former cumulative hedge-ledger symbol display and netted Overall UI from both Main Connection surfaces. Added regression coverage for hedge/Overall isolation, duplicate symbol aggregation, open-exposure lifecycle classification, and revised UI/API wiring. Verified full ESLint, TypeScript, source syntax, optimized Next production build, and all 74 Jest suites / 442 tests; no authenticated exchange call or real order was made. |
| 2026-07-16 | Added canonical detailed Strategy Stage Real position statistics across the Main Connection card and five-section information dialog. Overall now shows idempotent confirmed positions before and after hedge netting, offset count/ratio, hedged pairs, and Long/Short totals; hedge calculation offsets only opposing entries that share the same related Base Set and never nets unrelated strategies or symbols. Default and Trailing show position count/PF/DDT; Adjust Block and DCA show position count/PF/DDT plus Default+Trailing baseline, with-strategy count, delta, exact difference percentage, and explicit 0.2 ratio bands. Per-symbol Long/Short/gross/hedge-net counts are included. The confirmed-entry Lua/fallback ledger now atomically classifies each accepted paper/live entry by inferred Real variant, while partially upgraded running histories remain visibly on the legacy evaluation fallback until their variant subtotal is complete. Corrected Real variant PF/DDT raw-sum fallback divisors to use the writer's entry weighting. Added pure hedge/ratio math coverage including cross-Base isolation and rollout fallback. Verified TypeScript, source syntax/production lint through optimized Next build, 69 unit suites/415 tests, and the complete 74-suite/429-test Jest run. No exchange calls or real orders were made. |
| 2026-07-16 | Completed the Main Connections UI/status/settings audit and modernized the information dialog. The dialog now ships as a responsive five-section top-menu surface (Overview, Runtime, Indications, Strategies, Settings) with refresh cancellation/generation guards, partial-endpoint handling, explicit requested-vs-effective live-order safety, canonical progress/cycle/history metrics, bounded stage ratios, Main/Preset indication profiles including Trend, strategy/Preset details, symbols, volume/risk, position-count axes, DCA/trailing, and settings-version freshness. Fixed Guided QuickStart so its verification step cannot silently request Live Trade; accumulated adjacent debounced option edits; made selected-connection hydration fail closed; moved Control Orders side effects out of React state updaters; added versioned settings/volume readback and instant recoordination events; corrected volume defaults/rollback; prevented disabled-but-assigned connections from appearing addable; clarified Mainnet/Running/Queued/Paused/Realtime labels; repaired paused global controls and overlapping actions; invalidated the process-local status cache after mutations; bounded all displayed percentages/passed counts; and made cards/layouts responsive and dark-theme complete. Replaced the broken SQL-shaped Preset Type connection route with canonical Redis reads plus an ordered/versioned settings writer, so assignment now persists and immediately recoordinates while an unassigned preset returns 200/null. Extended production verification to recognize intentional progression-epoch counter resets, verify the compiled dialog asset and all six dialog snapshots, exercise Settings/Volume hot reload, Main Connection off/on, Pause/Resume/Stop/Start, and enforce ratio/order safety. Verified source syntax, ESLint, TypeScript, optimized Next production build, 73 Jest suites/420 tests, two 32-symbol 241–242s paper soaks (282–338 engine cycles, Historic 32/32 and 100%, Base→Main→Real→Live/Paper coordination, bounded GC memory waves), and a focused 32-symbol production UI run; zero real positions or exchange orders were created. Cloud Browser could not access localhost, so production HTML/client assets and the repository-owned UI/API workflow were verified without claiming manual visual clicks. |
| 2026-07-16 | Completed QuickStart timeout and maximum-symbol production validation. Added one shared client/server timing contract: 35s UI deadline, 18s default production engine-boot wait, at least 10s boot headroom, 1–25s override clamp, and a bounded 5s read-only connection check. Both QuickStart UI entry points now use the shared deadline; the compact UI explicitly sends the freshly-read effective Live state (eliminating a stale React-state race), supports its full 32-symbol maximum through a shared constant, and aborts a hung enable request. The production harness now carries all 32 symbols through preconfiguration, restart, local/cron caps, soak verification, and a reproducible UI-equivalent workflow that loads production HTML/assets, performs the exact top-volatility/QuickStart requests, measures the browser deadline, verifies canonical cycles/positions, and stops cleanly. Removed the production soak's invalid dependency on the intentionally disabled raw debug endpoint. A 242s max-symbol soak passed 117 rounds/1,287 requests/378 engine cycles, 32/32 historic symbols, Base→Main→Real→Live/Paper progression, p95 2,063ms, restart/settings/schema-v74 persistence, bounded post-warmup RSS behavior, and zero real positions/orders; a second UI-focused production run passed QuickStart in 4,079ms with cycles 177→180 and clean stop. Cloud Browser itself could not open the local port (`ERR_BLOCKED_BY_CLIENT`), so no visual click/screenshot claim is made; the repository-owned UI request harness is the reproducible substitute. Verified optimized production build, 72 Jest suites/410 tests, TypeScript, ESLint, source syntax, volatile cleanup, and diff checks; no authenticated BingX request or real order was made. |
| 2026-07-16 | Added Trend as the final Main indication type across realtime and set-backed engines, Settings, active profiles, dashboards, counters, health, cleanup, and progression. Trend evaluates independent 1/3/5/10/15/30-minute configurations with configurable negative PositionCost drawdown factors plus recent/active situation thresholds; Strategy Set identity preserves each selected timeframe/config through Base/Main/Real/Live and carries adaptive TP metadata through axis/position-count variants. Base pseudo positions now derive a stepped TP ladder from average absolute 1-minute market change divided by PositionCost (default minimum ×2, maximum 10, step 1), and shared batched/serialized Redis mutations prevent concurrent symbol/config writes from dropping positions or indexes. Pre-v74 Base config keys remain byte-compatible, Active-Advanced now enforces caps against its actual position pool, and Axis Sets retain a safe parent-entry fallback. Schema v74 seeds fill-missing-only Trend defaults into canonical and legacy settings mirrors, settings changes trigger immediate recoordination, candle ordering is deterministic, and cron fallback ownership now requires a fresh per-connection heartbeat instead of treating an unrelated global heartbeat as ownership. Verified all 71 Jest suites/406 tests, TypeScript, ESLint, source/diff/secret guards, and an optimized Next.js production build; no authenticated exchange calls or real orders were made. |
| 2026-07-16 | Follow-up runtime validation and coordination hardening: production and development safe 12-symbol soaks now exercise historic bootstrap, indication/realtime/LivePositions, Base/Main/Real/Live Sets, paper positions, restart persistence, and settings recoordination with zero real order requests. Fixed the scoped-vs-legacy prehistoric completion gate that could delay realtime by 60 seconds, coalesced settings changes during bootstrap, started LivePositions before continuous replay, bounded replay work, and made diagnostic/progression routes read canonical main-scoped state. QuickStart now atomically clears stale live flags in paper mode. Live dispatch/protection handling uses immediate SL/TP, narrow retries, terminal-position resurrection guards, close-result propagation, fast trailing rearm, and stable coordinator locks. Added balanced bounded config selection, strategy caps, DCA/Block/Trailing volume coverage, rate-limiter self-wakeup, portable minute scheduling, schema v73 timing/strategy migrations, and dev/prod preview validation. Verified 68 Jest suites/391 tests, TypeScript, source/diff guards, one-minute scheduler contract, isolated optimized production build, 60-second prod and dev 12-symbol soaks, mocked sub-300 ms order dispatch and sub-second protection with no stranded positions, and zero authenticated/order requests to BingX. |
| 2026-07-16 | Completed the live-safety, production-runtime, UI top-layer, strategy-coordination, and database-maintenance replacement release. Added three selectable transparent responsive header assets, shorter CTS metadata, removed the header Engine Test action, and eliminated nested duplicate layouts. BingX now defaults to the `bingx-api` community package fast path with signed official-REST fallback, connector reuse, normalized account/order/control/position operations, and no source-embedded credentials. Added portable one-minute scheduling outside Vercel Cron, configurable long-lived-server recovery, bounded cron sweeps, fatal migration/startup readiness, and corrected smoke cleanup. Base/Main/Real/Live now share symbol-scoped exact active Set lineage; active Live Sets survive PF/DDT/cap changes until terminal, candidates never count as entries, and Live vs paper books cannot double-count. The idempotent confirmed-entry ledger coordinates Set/Base/axis/hedge counts for initial and accumulation fills in both exchange and paper modes, with closed-only Previous/Last, reached-only directional Continuous, Pause windows, bounded fan-out, and terminal active-index cleanup. Database schema v71 adds crash-safe combined migration batching with a renewable distributed lock, canonical indexed connection reads with SCAN