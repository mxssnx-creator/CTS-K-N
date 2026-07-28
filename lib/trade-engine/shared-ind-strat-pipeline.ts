/**
 * Shared Indication + Strategy Pipeline
 *
 * ── The single canonical inner pipeline used by BOTH the Prehistoric
 *    Progression and the Realtime Progression. ──
 *
 * Per the architectural spec:
 *
 *   "indications and strategies processings are in the same intervalled
 *    progress … indications and strategies progress is unique for both
 *    prehistoric and realtime (it processes through)."
 *
 * The two callers share IDENTICAL indication-derivation and strategy
 * code paths. The only behavioural difference is the `asOfMs` parameter
 * threaded through `processIndication`:
 *
 *   asOfMs === undefined  → Realtime mode. processIndication evaluates
 *                           the latest live candle in Redis hot keys
 *                           and stamps indications at wall-clock now.
 *                           Phase 2 marks live pseudo positions to the
 *                           current price.
 *
 *   asOfMs === number     → Replay mode. processIndication slices the
 *                           loaded candle history to <= asOfMs, treats
 *                           the tail candle as the simulated "current"
 *                           bar, and stamps indications at asOfMs. The
 *                           shared `indication_set:*` keyspace is
 *                           filled with the simulated bar. Phase 2 is
 *                           SKIPPED — backdated candles must never trip
 *                           TP/SL on live pseudo positions.
 *
 * ── Phase order per symbol per cycle ──────────────────────────────────
 *   Phase 1   processIndication(symbol, asOfMs?)            (both modes)
 *   Phase 2   updateOpenPseudoPositionsForSymbol            (realtime)
 *   Phase 3   processStrategy(symbol, indications)          (both modes,
 *             gated on indicationCount > 0)
 *
 * ── Coordination guarantees ───────────────────────────────────────────
 * Independent timers; a slow prehistoric cycle never blocks realtime.
 * Set keyspace `indication_set:{connId}:{symbol}:{type}:{cfg}` is SHARED:
 * Prehistoric writes (per replay step), Realtime reads (per live tick).
 * `processAllIndicationSets` is idempotent per `(symbol, candle.timestamp)`
 * so overlapping replay ranges across cycles are cheap and safe.
 */

import { IndicationProcessor } from "./indication-processor-fixed"
import { StrategyProcessor } from "./strategy-processor"
import type { RealtimeProcessor } from "./realtime-processor"
import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"
import { isServerlessDeploymentRuntime } from "@/lib/deployment-runtime"

export type PipelineMode = "historical" | "realtime"

export interface PipelineCycleResult {
  symbol: string
  mode: PipelineMode
  asOfMs?: number
  indicationCount: number
  indicationTypeCounts: Record<string, number>
  pseudoUpdates: number
  strategiesEvaluated: number
  liveReady: number
  durationMs: number
  error?: string
}

export interface PipelineDeps {
  indication: IndicationProcessor
  strategy: StrategyProcessor
  realtime: RealtimeProcessor
  /**
   * Replay-mode anchors (both required together for replay mode):
   *   asOfMs    — simulated wall-clock for this step (= candle.timestamp).
   *   asOfCandle — the candle object at that timestamp; passed straight
   *                into `processAllIndicationSets` so Sets-fill uses the
   *                exact same bar processIndication's slice tail sees.
   *   setsProcessor — optional shared IndicationSetsProcessor; the
   *                prehistoric tick allocates one per cycle and reuses
   *                it across all replay steps to avoid per-step churn.
   */
  asOfMs?: number
  asOfCandle?: any
  setsProcessor?: IndicationSetsProcessor
  skipLiveDispatch?: boolean
  enableStrategyFlow?: boolean
  /**
   * Cooperative generation guard supplied by the owning engine loop. A
   * settings save, symbol recoordination, disable, restart, or ownership loss
   * flips this to false so an already-running cycle cannot publish stale
   * results or reach Live dispatch.
   */
  shouldContinue?: () => boolean
}

// ── Live dispatch ownership ───────────────────────────────────────
// Live exchange dispatch is intentionally owned by
// `StrategyCoordinator.createLiveSets()` in Phase 3. This shared pipeline
// must not read `real:sets` or perform a second dispatch pass: slim Real
// set storage can contain coord/axis identities that cannot be recovered by
// filtering Base sets alone, and a second selector risks duplicate or
// conflicting live orders.

/**
 * Run one full per-symbol pipeline pass. Errors are isolated to the
 * result object — they never propagate so the caller's loop survives.
 */
// Phase 1 and Phase 3 can legitimately enumerate large operator-defined
// configuration spaces. Their runtime thresholds are diagnostics only; the
// owning generation guard is the cancellation mechanism. Phase 2 remains
// bounded because it is exchange/network I/O rather than Cartesian work.
function withPhaseTimeout<T>(work: Promise<T>, label: string, ms: number): Promise<T> {
  // When ms=Infinity, skip the timeout entirely — the outer cycle deadline
  // (engine-manager) is the correct bound. setTimeout(fn, Infinity) would fire
  // at 1ms in Node.js (V8 clamps Infinity to MAX_TIMEOUT), so we guard here.
  if (!isFinite(ms) || ms <= 0) return work
  return new Promise<T>((resolve, reject) => {
    let done = false
    const t = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error(`[phase-timeout] ${label} exceeded ${ms}ms`))
    }, ms)
    if (typeof (t as any).unref === "function") try { (t as any).unref() } catch { /* ok */ }
    work.then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v) } },
      (e) => { if (!done) { done = true; clearTimeout(t); reject(e) } },
    )
  })
}

/**
 * Give HTTP/control callbacks one full event-loop turn between the CPU-heavy
 * historic phases. Promise continuations alone only drain the microtask queue,
 * so a replay step could otherwise run indication calculation, Set filling and
 * strategy coordination back-to-back before a waiting Signal/status request
 * was allowed to run.
 *
 * `setImmediate` preserves the strict phase order while yielding to pending
 * I/O. The timer fallback keeps non-Node test adapters compatible.
 */
function yieldPipelineEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof setImmediate === "function") {
      setImmediate(resolve)
    } else {
      setTimeout(resolve, 0)
    }
  })
}

export async function runIndStratCycle(
  connectionId: string,
  symbol: string,
  mode: PipelineMode,
  deps: PipelineDeps,
): Promise<PipelineCycleResult> {
  const cycleStart = Date.now()
  const result: PipelineCycleResult = {
    symbol,
    mode,
    asOfMs: deps.asOfMs,
    indicationCount: 0,
    indicationTypeCounts: {},
    pseudoUpdates: 0,
    strategiesEvaluated: 0,
    liveReady: 0,
    durationMs: 0,
  }
  const shouldContinue = (): boolean => {
    try {
      return deps.shouldContinue?.() !== false
    } catch {
      return false
    }
  }

  try {
    if (!shouldContinue()) return result
    // ── Phase 1: Indication evaluation (UNIFIED) ──────────────────────
    // One method, both modes. asOfMs threads through to control which
    // candle slice and emission timestamp the processor uses.
    // Exhaustive calculation has no fixed completion timeout. A fixed 20s
    // Promise.race discarded a valid completed snapshot while its underlying
    // work continued, making Base/Stats look partially populated.
    const indications = await withPhaseTimeout(
      deps.indication.processIndication(symbol, deps.asOfMs, shouldContinue),
      `Phase1/processIndication/${symbol}`,
      Infinity,
    ).catch((err) => {
        console.error(
          `[v0] [SharedPipeline] processIndication failed for ${symbol} (mode=${mode}, asOfMs=${deps.asOfMs ?? "now"}):`,
          err instanceof Error ? err.message : String(err),
        )
        return [] as any[]
      })
    if (!shouldContinue()) return result
    result.indicationCount = Array.isArray(indications) ? indications.length : 0
    if (Array.isArray(indications)) {
      for (const indication of indications) {
        const rawType =
          typeof indication?.type === "string" ? indication.type
            : typeof indication?.indication_type === "string" ? indication.indication_type
              : typeof indication?.indicationType === "string" ? indication.indicationType
                : ""
        const type = rawType.trim()
        if (type.length > 0) {
          result.indicationTypeCounts[type] = (result.indicationTypeCounts[type] ?? 0) + 1
        }
      }
    }
    await yieldPipelineEventLoop()
    if (!shouldContinue()) return result

    // Phase 1 now materialises and returns the exact Set snapshot in both
    // realtime and replay modes. A second replay-only fill here used to
    // calculate and write every Cartesian row twice while Strategy consumed
    // only the reduced Phase-1 array.

    // ── Phase 2: Open pseudo position handling (REALTIME ONLY) ────────
    // Backdated candles must NEVER reach the pseudo-position close
    // engine — a 2-hour-old bar would trip TP/SL on every open paper
    // position instantly. Realtime mode marks against the live price.
    // Timeout: 8s — exchange price fetch + Redis writes should be <2s normally.
    if (mode === "realtime") {
      if (!shouldContinue()) return result
      try {
        const pseudoUpdates = await withPhaseTimeout(
          deps.realtime.updateOpenPseudoPositionsForSymbol(symbol),
          `Phase2/pseudoUpdate/${symbol}`,
          8_000,
        )
        result.pseudoUpdates = pseudoUpdates
      } catch (pseudoErr) {
        console.error(
          `[v0] [SharedPipeline] Pseudo update failed for ${symbol}:`,
          pseudoErr instanceof Error ? pseudoErr.message : String(pseudoErr),
        )
      }
      await yieldPipelineEventLoop()
      if (!shouldContinue()) return result
    }

    // ── Phase 3: Strategy evaluation (UNIFIED, indication-gated) ──────
    // In production the API worker also owns the coordinator. Calling the
    // full strategy evaluator on every empty warm-up tick can monopolize the
    // Node event loop and make health/status routes look crashed. Run the
    // evaluator when Phase 1 produced live indications (historical replay still
    // passes its backdated indication array), and let the next productive tick
    // advance the strategy/live stages.
    // Phase3 has no inner timeout. processStrategy is CPU-bound and with 3800+
    // sets takes 50-110s per symbol on single-threaded Node. A fixed inner
    // timeout was too conservative and discarded valid indication work from
    // Phase1/Phase2. The outer cycle deadline (120s dev / 75s prod) enforced
    // by the engine is the correct bound: if the cycle runs long, the engine
    // skips it and tries again next tick. Setting PHASE3_TIMEOUT_MS=Infinity
    // disables the Promise.race in the caller.
    const PHASE3_TIMEOUT_MS = Infinity
    // API-worker safety gate: strategy evaluation runs by default for self-hosted
    // workers so production progress advances; Vercel/serverless workers remain
    // opt-in. The indication-count check below still prevents empty work.
    const apiStrategyFlowEnabled =
      process.env.DISABLE_API_STRATEGY_FLOW !== "1" &&
      process.env.ENABLE_API_STRATEGY_FLOW !== "0" &&
      process.env.ENABLE_API_STRATEGY_FLOW !== "false" &&
      (!isServerlessDeploymentRuntime() ||
        process.env.ENABLE_API_STRATEGY_FLOW === "1" ||
        process.env.ENABLE_API_STRATEGY_FLOW === "true" ||
        // The bounded scheduled owner is an explicit, awaited strategy owner;
        // unlike a generic serverless HTTP request it is safe and required to
        // advance Main/Real/Live before the invocation returns.
        deps.enableStrategyFlow === true) &&
      deps.enableStrategyFlow !== false
    // Live dispatch can still be skipped independently by CRON_LIVE_DISPATCH=0.
    if (result.indicationCount > 0 && apiStrategyFlowEnabled) {
      await yieldPipelineEventLoop()
      if (!shouldContinue()) return result
      const stratResult = await withPhaseTimeout(
        deps.strategy
          .processStrategy(
            symbol,
            indications,
            process.env.CRON_LIVE_DISPATCH === "0" ||
              process.env.CRON_LIVE_DISPATCH === "false"
              ? true
              : deps.skipLiveDispatch === true,
            shouldContinue,
          )
          .catch((err) => {
            console.error(
              `[v0] [SharedPipeline] processStrategy failed for ${symbol} (mode=${mode}):`,
              err instanceof Error ? err.message : String(err),
            )
            return { strategiesEvaluated: 0, liveReady: 0 }
          }),
        `Phase3/processStrategy/${symbol}`,
        PHASE3_TIMEOUT_MS,
      )
      if (!shouldContinue()) return result
      result.strategiesEvaluated = stratResult.strategiesEvaluated || 0
      result.liveReady = stratResult.liveReady || 0
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    console.error(
      `[v0] [SharedPipeline] Cycle error for ${connectionId}/${symbol} (${mode}):`,
      result.error,
    )
  } finally {
    result.durationMs = Date.now() - cycleStart
  }

  return result
}
