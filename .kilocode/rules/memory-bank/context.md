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
| 2026-07-07 | PROD-ONLY FAILURE INVESTIGATION (user: prod broken, dev OK; coordinator error msgs, progression failures, unsuccessful, different results). Built + ran isolated production server (`.next-prod`, :3003). ROOT CAUSE (primary): `lib/trade-engine/stages/live-stage.ts` enables REAL exchange order execution whenever `is_live_trade`/`live_trade_enabled` is truthy — but migrations 051/052/056 force `is_live_trade=1` on the base connection unconditionally, with NO credential check. In production (empty/placeholder API keys) every live order attempt fails with auth errors → coordinator error messages + progression failures + "unsuccessful" trades; dev works because it has real local credentials. FIX: added a credential gate at the live-stage pre-flight — when `is_live_trade` is on but the connection has no valid API key/secret, execution falls through to the existing paper/simulation branch (status `simulated`) with a clear warning instead of failing. Verified: `tsc --noEmit` clean, prod `next build` clean, prod server boots healthy (engine running, no error storm). NOTE: the app's in-memory `InlineLocalRedis` is per-process — multi-instance/serverless production still needs a shared durable Redis (`REDIS_URL`/`KV_URL`/Upstash); the silent inline-local fallback only guarantees consistency for a single `next start` process. |
