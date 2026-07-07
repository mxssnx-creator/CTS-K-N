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
