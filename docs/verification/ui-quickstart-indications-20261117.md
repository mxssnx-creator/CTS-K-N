# UI, QuickStart basket and Low-Range indications — 2026-11-17

Cloud session checkout (canonical `/workspace/CTS-K-N` not present in this container), branch
`claude/great-maxwell-bi8gdd`, base main `1b9c754`. Verified pre-edit checkpoint:
`/home/user/backups/CTS-K-N/20261117T104413Z-before-ui-audit-20261117` (created with
`scripts/create-checkpoint.sh`). No production service, deployment, remote Redis or exchange account
was touched. No order of any kind was placed.

## Indications ported from other projects

Surveyed CTS-A, CTS-C, CTS-G and current CTS-A-O (`27ead50`). All four share the same
`shared/cts-indications` package (2,918 identical source ids); CTS-A-O's only indication additions
since the ported revision are `low-range-extra.ts` (band reclaim, squeeze break, RSI(2) reclaim, each
with standalone/trend/activity filters and inverse variants). K-N's own Low-Range port is already a
superset of upstream's (10 windows × 13 relations); CTS-C's Signals catalogue and CTS-G's Stable-02
bot families are not per-symbol Common indications.

- New opt-in Common types `lowRangeBandReclaim`, `lowRangeSqueezeBreak`, `lowRangeRsi2Reclaim`
  (`lib/common-indicators/ao/low-range-extra.ts`), parameters window 2–48 (default 6–24 step 6),
  filter 0–2, inverse 0–1, keep 1. Registered inventory 140 types / 2,509 tuples; the enabled default
  cohort is unchanged at 129 types / 2,325 tuples (research types stay opt-in until independent
  after-cost validation; no profitability claim).
- Upstream file copied verbatim to `shared/cts-indications/origin/indications/low-range-extra.ts`
  (manifest SHA-256 added) as the parity oracle. `__tests__/unit/low-range-extra-parity.test.ts`
  proves bar-for-bar equality with upstream for all 54 upstream specs in its batch and streaming
  paths, on 1/5/15-minute fixtures including a gap and a malformed bar, and asserts every method
  actually fires. The generic catalogue suite (causality, both directions, mirror symmetry, warm-up)
  covers the new types.

## QuickStart / Main connection basket coherence (bug)

`lib/forced-symbols.ts` mandates BTC/SOL/BCH/XRP first with the requested count as the total ceiling
(operator rule, unchanged). QuickStart applied it only inside the settings commit, while its response,
logs, progression snapshot and a later `trade_engine_state` write used the raw request. Reproduced
locally: a 4-symbol request (BTC/ETH/SOL/XRP) returned "processing BTC,ETH,SOL,XRP" while every
connection hash and the engine ran BTC/SOL/BCH/XRP (Redis MONITOR trace). QuickStart now resolves the
effective basket once via `normalizeSymbolAliasesInPatch` before persisting or reporting, returns
`requestedSymbols` and `symbolsAdjustedByPolicy`, and the dashboard logs the effective basket.
`quickstart-ordering.test.ts` asserts the response and both persisted patches.

## UI fixes

- Dead buttons: Overview Progression / Indications / Strategies dispatched events nothing listened to;
  they now open `ProgressionLogsDialog` on the matching tab (`initialTab`). Settings "Add New
  Connection" dispatched an unheard event; the connection manager now opens its dialog.
- Strategies: filters rebuilt around fields the stage-summary rows carry (symbols from loaded rows,
  stage Base/Main/Real/Live, last-update range, min PF, active/valid). Removed filters that silently
  acted on placeholders (TP/SL/volume, trailing, win rate, stock/forex presets, unused indication
  categories). Fixed stale-closure bug that dropped typed symbols. Avg PF averages measured rows only
  and shows "—" without data; "Trades/Day" sort (always 0) replaced by recorded entries; empty state
  no longer blames filters.
- Connection selector: no longer blank while connections refresh; label truncates inside the trigger
  (shared Select value slot now shrinks).
- Statistics: page header restored to the top in the loaded state (was nested under the tabs).
- Bots: uses the shared PageHeader (phones previously had no sidebar toggle on this page).
- Logistics: funnel follows the stage contract (Base emitted → Base valid → Main → Real → Live);
  Common family count is derived (was "17 official indicators"); descriptions sit under their labels;
  phone-width grids stack.
- Header actions get a legible plate over the decorative art; Preset Optimizer shows "—" instead of
  0.00 PF / 0 % with no presets; German status line translated.

## Validation

- TypeScript and ESLint on all changed files: pass. Production build: pass, 356 complete traces.
- Production server browser audit (Playwright) of 37 routes at 1440/820/390 px: no page errors, no
  failed API calls, no unintended horizontal overflow; dialogs fit the viewport at 390 and 1440 px.
- Forced-paper engine run (X02, no credentials, 4 symbols, public BingX market data only): 4/4
  history loaded (115,200 candles), type measurement 500 closes, 2,198 cycles, 71,809 indications,
  Base evaluated 3,318 Sets / passed 0 (measured PositionCost ratio ≈0.82 < gate); stage-funnel
  contract violations: none.

## Environment hazard found (not a code change)

This cloud container's environment injects `BINGX_API_KEY`/`BINGX_API_SECRET`, `FORCE_LIVE=1`,
`CTS_LIVE_TRADING_CONFIGURED=1`, `ALLOW_INLINE_REDIS_LIVE_TRADING=1` and `ALLOW_PROD_INLINE_REDIS=1`.
A locally started server therefore seeded the credentials onto `bingx-x01` (mainnet) and
`FORCE_LIVE` overrode `FORCE_SIMULATED`. Verified: X01 was never dashboard-enabled or live, has no
log lines and no order keys; only X02 (no credentials) ran, in paper mode. The server was stopped,
the disposable local Redis instances flushed, and all later runs strip these variables. The same
variables make `exchange-force-simulated`, `x01-explicit-authorization` and
`prehistoric-range-backfill` fail on unmodified main; they pass with a clean environment.
Recommendation: remove these variables from the cloud environment, or never start the app in it
without stripping them.
