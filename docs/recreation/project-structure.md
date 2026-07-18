# Project structure

This map describes ownership. Use `manifests/source-tree.txt` for the complete
file list and `project-files.tsv` for exact checksums.

```text
CTS-K-N/
├── app/                         Next.js App Router pages, layout, and API routes
│   └── api/                     HTTP control/data/install/cron surface
├── components/                  Dashboard, settings, presets, UI primitives
├── contexts/                    Client-side shared React state
├── hooks/                       Browser state, events, polling helpers
├── lib/                         Domain, persistence, exchange, runtime modules
│   ├── exchanges/               Exchange connector implementations
│   └── trade-engine/            Pipeline stages, manager, locks, event flow
├── scripts/                     Build, deployment, scheduler, smoke and stress tools
├── __tests__/                   Unit, integration and E2E contracts
├── docs/                        Operations and recreation documentation
├── public/                      Static assets
├── .kilocode/                   Project memory/rules/recipes
├── package.json                 Commands and exact toolchain intent
├── pnpm-lock.yaml               Sole dependency lockfile
├── next.config.mjs              Next build/runtime configuration
├── open-next.config.ts          OpenNext build configuration
├── custom-worker.ts             OpenNext fetch + Cloudflare scheduled handler
├── wrangler.jsonc               Kilo/Cloudflare Worker source of truth
└── vercel.json                  Optional Vercel compatibility configuration
```

## Critical domain modules

| File | Contract |
| --- | --- |
| `lib/strategy-coordinator.ts` | Base/Main/Real/Live Set graphs, axes, variants, Block overlays, caps, stats |
| `lib/strategy-axis-settings.ts` | Normalized position-count axis settings |
| `lib/block-count-state.ts` | Block count parsing, quantity/PF formulas, active/pause lifecycle |
| `lib/dca-strategy.ts` | DCA profile layering, triggers, quantities, stable step keys, TP rules |
| `lib/pos-history.ts` | Exact Set entry/active/closed ledgers and realized PF/DDT rings |
| `lib/strategy-real-stats.ts` | Stable Real/variant/Block stats snapshot shapes |
| `lib/trade-engine/stages/real-stage.ts` | Main signal to RealPosition conversion and lineage propagation |
| `lib/trade-engine/stages/live-stage.ts` | Real/paper execution, outbox, fills, protection, Block/DCA accumulation/reconcile |
| `lib/trade-engine/engine-manager.ts` | Long-running connection engines and lifecycle |
| `lib/real-trade-gates.ts` | Explicit real-trading readiness and fail-closed reasons |
| `lib/redis-db.ts` | Shared/inline adapters, key helpers, settings/connections, snapshots |
| `lib/redis-migrations.ts` | Ordered idempotent schema evolution |
| `lib/connection-recoordinator.ts` | Serialized settings commit, invalidation and progression refresh |
| `lib/deployment-runtime.ts` | Serverless/Kilo/long-lived owner classification |
| `lib/server-continuity-runner.ts` | In-process long-lived continuity ownership |

## Critical application surfaces

- `components/settings/strategy-coordination-section.tsx`: full connection-level
  axis, Block and DCA controls.
- `components/settings/tabs/strategy-tab.tsx`: global/preset strategy controls.
- `components/settings/connection-settings-dialog.tsx`: connection settings
  normalization and persistence.
- `components/settings/connection-info-dialog.tsx`: derived runtime/settings
  observability.
- `components/settings/install-manager.tsx`: local migration and remote SSH
  preflight/install UI.
- `app/api/settings/**`: canonical settings writers/readers.
- `app/api/connections/progression/[id]/stats/route.ts`: aggregate dashboard
  contract, including Count1..10 Block PF statistics.
- `app/api/cron/server-continuity/route.ts` and
  `app/api/cron/sync-live-positions/route.ts`: portable scheduled ownership.
- `app/api/install/remote-postgres/route.ts`: legacy-named, current generic
  remote Linux install owner/proxy route.

## Generated and runtime-only paths

Do not include these in a source reconstruction: `node_modules/`, `.next/`,
`.open-next/`, `.wrangler/`, `.cts-runtime/`, logs, local Redis snapshots,
`.env*`, `.dev.vars*`, and deployment platform metadata. Recreate them from the
lockfile, source, environment, and documented commands.
