# Stage funnel and "processing" Sets

Binding definition (operator decision, 2026-10-07): **only Sets that passed
the stage gate are "processing".** The validated, measured, higher-PF Sets
after Base are the ones Main, Real and Live process. Every count shown as
processing, progressing or running comes from them, never from the emitted
pool.

The contract is code: `lib/stage-funnel-contract.cjs` (implementation) and
`lib/stage-funnel-contract.ts` (typed re-export).

## Populations per stage

| Name | Meaning (Base) |
|---|---|
| emitted | Every Base Set produced this pass: one per indication type × direction × config. |
| awaiting history | Emitted, but fewer than `prevPosMinCount` (default 5) measured, cost-relative closes. |
| rejected | Measured, but failed the Base contract: PF below the stage PF (1.10) or DDT above its maximum. |
| valid | Passed the Base gate (`status = valid_base`). Main receives exactly these. |
| processing / progressing | Valid Sets with entries this cycle. |
| running | Valid Sets that hold an open pseudo or live position. |

Invariants, checked at runtime and in every verification run:
- running ≤ valid;
- processing ≤ valid;
- valid ≤ emitted;
- awaiting history + rejected + valid = emitted;
- Main input = Base valid;
- a stage's passed ≤ its evaluated;
- no negative counts.

Main, Real and Live count their own Sets, all of which descend from Base-valid parents.

## How Base judges a Set

1. **History window** (`selectBaseHistoryWindow`, `lib/strategy-coordinator.ts`). The Set's own result ring is used once it holds `prevPosMinCount` canonical closes. Until then the Set uses its symbol × type × direction bucket `pos_ring:{conn}:{symbol}:{type}:{direction}`.
2. **PF.** With enough measured closes, the Set's PF is min(raw indication PF, mean PositionCost ratio of the window). Ratio = 1 + net % / PositionCost × 0.1, net after the real round trip (`simulatedCloseCostPercent`, ≥ 0.26 %).
3. **Gate** (`createMainSets`):
   - too little history → awaiting;
   - PF < 1.10 or DDT too high → rejected;
   - otherwise valid.

## Prehistoric seeding: Base has data from the first realtime cycle

- **Measurement.** The prehistoric run replays every direct indication type on the venue's real 1-minute bars (`advanceTypeMeasurement`) and books each close into its type × direction bucket. The engine heartbeat continues the same measurement in realtime.
- **Backfill** (`backfillTypeMeasurement`). A measured type whose bucket ends the range with fewer than `prevPosMinCount` closes is extended backwards over older real bars:
  - one day at a time, up to 7 days;
  - causal: only bars before the range;
  - older closes are appended behind the newer ones, so the window still reads the latest closes.
- **Status.** The prehistoric hash records `type_measurement_status` and the backfill summary; the stats API exposes them as `historic.typeMeasurement.{status,backfill}`:
  - `measured`;
  - `no_closes`;
  - `skipped:forced_simulation`;
  - `skipped:context_error:…`.
- **Signal and Special** have no historic replay (remote, realtime-only). Their Sets wait for realtime closes, and this is reported, not hidden.

## Where the counts live

| Count | Redis | API / UI |
|---|---|---|
| Base processing | `strategy_detail:{conn}:base` `sets_progressing`, `s:{sym}:progressing`, written by Main from the valid funnel | `strategyDetail.base.setsProgressing`; tracking route `base.setsProgressing`; pipeline card "Validated Sets Processing" |
| Base running | `sets_running_now`, `s:{sym}:running`, `strategies_active:{conn}` `{sym}:base` | `activeProgressing.strategies.base.sets`; "Validated Sets Running Now" |
| Base awaiting / rejected | `awaiting_history`, `rejected_sets`, `s:{sym}:awaiting_history`, `s:{sym}:rejected` | tracking route `setsAwaitingHistory` / `setsRejected`; pipeline card "Base gate" line |
| Emitted | `created_sets`, `row_total`, `s:{sym}:created` | "Sets emitted (current)" |
| Flat stage keys | `strategies:{conn}:{base,main,real}:{count,evaluated,passed}` | written only by the coordinator; `statistics-tracker` no longer increments them |

## Guards

- **Runtime.** `StrategyCoordinator.guardStageFunnel` checks every pass, prehistoric and realtime. A violation logs one `stage_funnel_invariant_violation` progression event per connection × symbol × message per 10 minutes. It never changes trading.
- **Verification.** `scripts/verify-runtime-coverage.mjs` reports a funnel violation in the stats payload as an error. The observation harness and QuickStart soaks therefore fail on it.
- **Tests.** `__tests__/unit/stage-funnel-contract.test.ts` pins the contract, the verifier rule, and the writers and readers. A static scan fails if any processing/running field is computed from the emitted pool. `__tests__/unit/prehistoric-base-history-backfill.test.ts` pins the history choice, the append order and the backfill.

## Rule for future changes

Any new counter labelled processing, progressing, running or active goes through the stage funnel contract and counts gate-validated Sets only. A new counter that needs the emitted pool is named for it ("emitted", "created", "total").
