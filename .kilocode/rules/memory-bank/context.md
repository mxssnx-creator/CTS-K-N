# Active Context: CTS-V-yd Trading System (main project)

## Current State

**Project Status**: ✅ Consolidated as the main project on `main`

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

- [x] Base Next.js 16 setup with App Router
- [x] TypeScript configuration with strict mode
- [x] Tailwind CSS 4 integration
- [x] ESLint configuration
- [x] Memory bank documentation
- [x] Recipe system for common features
- [x] Fix route handlers `localStartAllowed` pattern (NODE_ENV → VERCEL) for self-hosted production
- [x] Fixed `pre-startup.ts` symbol seeding to preserve existing snapshot values (no overwrite of `force_symbols`)
- [x] Updated redis-snapshot.json with complete bingx-x01 configuration: API credentials, 5 symbols (BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, ADAUSDT), live_volume_factor=0.1, market data placeholder entries

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
| Initial | Template created with base setup |
| 2026-07-07 | Consolidated CTS-V-yd trading system as the main project; committed to `main` and pushed to `origin/main` (CTS-K-N). Removed starter template + `ctsv-dev` symlinks. |
| 2026-07-07 | ROOT CAUSE: production logs show no migration output because `next.config.mjs` `removeConsole` strips all `console.log` from the prod server bundle (only `error`/`warn` survive), and once migrated `runMigrations()` fast-paths silently. Migrations DO run in prod. FIX: `startup-coordinator.completeStartup()` + `runMigrations()` now emit migration/boot status via `console.warn` (survives strip). Added `scripts/verify-migration-status.mjs` to query `/api/install/database/migrations-info` on dev + prod and compare `current_version` vs `target_version` (verified: 65 migrations run, schema reaches v65, `isMigrated=true`). |
| 2026-07-07 | VERIFIED FIX IN BOTH MODES: ran separate dev server (`.next`, :3102) and production server (`.next-prod` built via `NEXT_DIST_DIR=.next-prod`, :3200) with isolated `V0_REDIS_SNAPSHOT_PATH`. Both report `current_version=65/target_version=65`, `is_up_to_date=true` via `/api/install/database/migrations-info`. Prod log confirms `console.log` is stripped (no `[v0] [Startup] Beginning pre-startup` line) yet the `console.warn` `[v0] [Startup] Migration status — current=v65 target=v65 UP TO DATE` IS present — fix works. `scripts/verify-migration-status.mjs` exits 0 in both modes. No fixes needed. |
| 2026-07-07 | TASK: ReRun + verify UI interactivity & Progression Stats. Re-ran full jest suite (120 unit + 1 integration + 1 e2e, all pass), `bun typecheck`, `bun lint`, and a production `next build` (clean). Started prod server and exercised `/api/trade-engine/progression` + `/api/connections/progression/bingx-x01/stats` (valid data) and ran the integration/e2e progression tests live (pass). FIXED correctness bugs in Progression Stats UI: divide-by-zero → `NaN` in `app/statistics/page.tsx` (Coordination/Optimal/Risk tabs, market-condition avg performance, avg drawdown, avg Sharpe) via a `safeAvg` helper; added missing "Symbols"/"Charts" tab triggers that had content but were unreachable; guarded `calculateVolatility` empty-positions → NaN in `lib/analytics.ts`. |
| 2026-07-07 | PROD-ONLY FAILURE INVESTIGATION (user: prod broken, dev OK; coordinator error msgs, progression failures, unsuccessful, different results). ROOT CAUSE: `lib/trade-engine/shared-ind-strat-pipeline.ts` Phase 3 (`processStrategy`) was gated by `process.env.NODE_ENV !== "production"` — this disabled the entire strategy evaluation pipeline (BASE→MAIN→REAL→LIVE) in ALL production builds, including self-hosted `next start`. The same bug existed in `lib/indication-sets-processor.ts` (`apiSetFillEnabled`). In dev, Phase 3 ran and the coordinator produced full strategy output; in production, Phase 3 silently no-op'd, leaving the coordinator with nothing to coordinate, progression counters frozen at 0, and the UI showing failures/errors. The other "production-only" guards in `engine-manager.ts` (`apiRealtimeProgressionEnabled`, `apiLiveSyncEnabled`) correctly use `process.env.VERCEL !== "1"` (self-hosted prod runs them; only Vercel serverless opts out). FIX: changed both gates to `process.env.VERCEL !== "1" || ...`, matching the other two checks. Verified: `bun typecheck` clean, `bun lint` clean. |
| 2026-07-07 | NOTE: the app's in-memory `InlineLocalRedis` is per-process — multi-instance/serverless production still needs a shared durable Redis (`REDIS_URL`/`KV_URL`/Upstash); the silent inline-local fallback only guarantees consistency for a single `next start` process. |
| 2026-07-07 | Fixed route handler `localStartAllowed` checks using `NODE_ENV !== "production"` instead of `VERCEL !== "1"` pattern. The wrong pattern blocked self-hosted production (`NODE_ENV=production` but `VERCEL≠"1"`) from starting engines via dashboard toggle. Fixed in: `app/api/settings/connections/[id]/toggle-dashboard/route.ts`, `app/api/settings/connections/[id]/enable/route.ts`, `app/api/settings/connections/[id]/live-trade/route.ts`. |
| 2026-07-07 | Fixed `pre-startup.ts` and `startup-coordinator.ts` to use `VERCEL !== "1"` instead of `NODE_ENV !== "production"` for non-Vercel production compatibility. This ensures symbol seeding and proper coordination for self-hosted production deployments. |
| 2026-07-07 | BingX credentials now preserved across startup — `pre-startup.ts:seedPredefinedConnections()` now checks all Redis locations (`settings:trade_engine_state:{id}`, `settings:connection:{id}`, raw `trade_engine_state:{id}`) before writing symbols, preventing overwrite of snapshot values. Updated `redis-snapshot.json` with complete bingx-x01 state including `force_symbols` in all required locations and market data placeholders for 5 symbols. |
| 2026-07-07 | Check-and-fix pass: fixed the QuickStart unit-test teardown leak by disabling the detached prehistoric preload during Jest runs, and updated the regression guardrail to assert the current self-hosted production `VERCEL !== "1"` local-start gate. Verified `bun typecheck`, `bun lint`, `bun test:all`, and `bun run build` pass. |
| 2026-07-07 | Production-vs-dev stability follow-up: QuickStart's best-effort prehistoric preload is now development-only by default (or explicit `ENABLE_QUICKSTART_PREHISTORIC_PRELOAD=1`). Production QuickStart relies on the real engine start path instead of launching a second detached `SymbolDataProcessor`, preventing duplicate prehistoric/progression writers that caused coordinator lock noise, stalled progression counters, crashes/failures, and lower-quality prod-only results. Added regression coverage for the production guard. |
| 2026-07-07 | Production status/progression heartbeat fix: production smoke showed migrations at v65 and the global worker heartbeat fresh, but status routes still showed connection-level `configured_no_worker_heartbeat` because they read only raw `trade_engine_state:{id}` while live engine ticks write `last_processor_heartbeat` to `settings:trade_engine_state:{id}`. Updated system/trade-engine status APIs to merge both hashes so production pages stop reporting false coordinator/progression failures. |
