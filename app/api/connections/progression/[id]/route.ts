import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient, getSettings, getConnection } from "@/lib/redis-db"
import { getProgressionLogs, forceFlushLogs } from "@/lib/engine-progression-logs"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { normalizeSymbolList } from "@/lib/trade-engine/symbol-selection-ownership"
import {
  buildPrehistoricGateKeys,
  buildProgressionScope,
  calculateHistoricProgress,
  ensureScopedProgressionFromLegacy,
  progressionReadKeys,
} from "@/lib/progression-scope"
import { getFreshestProcessorHeartbeat } from "@/lib/engine-heartbeat"

export const dynamic = "force-dynamic"
export const dynamicParams = true
export const runtime = "nodejs"
export const maxDuration = 30
export const revalidate = 0
export const fetchCache = "force-no-store"

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function parseSymbolList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((symbol) => String(symbol).trim()).filter(Boolean)
  }
  if (typeof value !== "string") return []
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      return parsed.map((symbol) => String(symbol).trim()).filter(Boolean)
    }
  } catch {
    // Fall through to comma/newline parsing for legacy Redis fields.
  }
  return trimmed
    .split(/[\n,]/)
    .map((symbol) => symbol.trim())
    .filter(Boolean)
}


const PROGRESSION_AUX_TIMEOUT_MS = 750

async function withProgressionTimeout<T>(
  label: string,
  connectionId: string,
  work: Promise<T>,
  fallback: T,
  timeoutMs = PROGRESSION_AUX_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[v0] [ProgressionAPI] ${label} timed out for ${connectionId}; returning live snapshot without blocking UI`)
          resolve(fallback)
        }, timeoutMs)
        timer.unref?.()
      }),
    ])
  } catch (error) {
    console.warn(`[v0] [ProgressionAPI] ${label} failed for ${connectionId}:`, error)
    return fallback
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function getConfiguredSymbolCount(connection: any, engineState: any): number {
  // The saved connection is the current operator-selected generation. Engine
  // state can legitimately retain the previous generation's denominator until
  // the new Historic pass finishes, so it must not override this list.
  for (const candidate of [connection?.force_symbols, connection?.active_symbols, connection?.selected_symbols]) {
    const symbols = parseSymbolList(candidate)
    if (symbols.length > 0) return symbols.length
  }
  const canonicalSelectedSymbols = normalizeSymbolList(engineState?.selected_symbols)
  const canonicalTotal = Math.max(toNumber(engineState?.config_set_symbols_total), canonicalSelectedSymbols.length)
  if (canonicalTotal > 0) return canonicalTotal
  const candidates = [
    engineState?.force_symbols,
    engineState?.active_symbols,
  ]
  for (const candidate of candidates) {
    const symbols = parseSymbolList(candidate)
    if (symbols.length > 0) return symbols.length
  }
  return Math.max(
    toNumber(connection?.symbol_count),
    toNumber(engineState?.symbol_count),
    toNumber(engineState?.config_set_symbols_total),
  )
}

/**
 * GET /api/connections/progression/[id]
 * Returns comprehensive progression data for an active connection
 * Tracks: initialization, historical data loading, indications, strategies, realtime, live trading
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id
    const engineType = request.nextUrl.searchParams.get("engineType") || "main"

    // PRODUCTION FIX: Initialize Redis before use
    try {
      await initRedis()
    } catch (redisErr) {
      console.error(`[v0] [ProgressionAPI] Redis init failed for ${connectionId}:`, redisErr)
      return getErrorResponse(connectionId, "Redis initialization failed")
    }
    
    // Keep the card/progress endpoint responsive even while dev/prod engines are
    // producing heavy logs. A stale log buffer must never block the live
    // progression/stats snapshot used by Main Connections cards.
    await withProgressionTimeout("log flush", connectionId, forceFlushLogs(connectionId), undefined)

    // Get connection details for context
    const connection = await getConnection(connectionId).catch((e) => {
      console.warn(`[v0] [ProgressionAPI] Failed to get connection ${connectionId}:`, e)
      return null
    })
    const connName = connection?.name || connectionId

    // Get progression phase data from engine-manager's updateProgressionPhase
    const scope = buildProgressionScope(connectionId, engineType)
    const progression = await getSettings(scope.engineProgressionKey).catch((e) => {
      console.warn(`[v0] [ProgressionAPI] Failed to get progression settings for ${connectionId}:`, e)
      return {}
    }).then(async (scoped) => {
      if (scoped && Object.keys(scoped).length > 0) return scoped
      return getSettings(`engine_progression:${connectionId}`).catch(() => ({}))
    })
    
    // Get engine state from all production writers and merge newest/scoped fields.
    // Engine workers often publish hot heartbeat/config counters to
    // settings:trade_engine_state:{id}:{engineType}, while legacy/startup paths
    // may still write trade_engine_state:{id}. Reading only one hash made the
    // progress endpoint use stale symbol totals and appear stuck in prod.
    const client = getRedisClient()
    const [scopedEngineState, scopedRawEngineState, legacySettingsEngineState, legacyRawEngineState] = await Promise.all([
      getSettings(scope.tradeEngineStateKey).catch(() => ({})),
      getSettings(`trade_engine_state:${connectionId}:${engineType}`).catch(() => ({})),
      getSettings(`settings:trade_engine_state:${connectionId}`).catch(() => ({})),
      getSettings(`trade_engine_state:${connectionId}`).catch(() => ({})),
    ]).catch((e) => {
      console.warn(`[v0] [ProgressionAPI] Failed to get engine state for ${connectionId}:`, e)
      return [{}, {}, {}, {}] as any[]
    })
    const engineState = {
      ...(legacyRawEngineState || {}),
      ...(legacySettingsEngineState || {}),
      ...(scopedRawEngineState || {}),
      ...(scopedEngineState || {}),
    }
    
    // Also check global state (stored as Redis HASH via hset, not a string)
    let globalState: any = {}
    try {
      if (client) {
        const globalStateData = await client.hgetall("trade_engine:global").catch(() => null)
        globalState = globalStateData && Object.keys(globalStateData).length > 0 ? globalStateData : {}
      }
    } catch {
      globalState = {}
    }
    const globalIntent = globalState?.operator_intent || globalState?.desired_status || globalState?.status || ""
    const isGloballyRunning = globalIntent === "running" || (!globalIntent && (globalState?.operator_stopped !== "1" && globalState?.operator_stopped !== "true"))
    let configuredSymbolCount = getConfiguredSymbolCount(connection, engineState)
    
     // PHASE 2 FIX: Check running flag directly from coordinator (most reliable)
     // Get current engine running state from coordinator
     let isEngineRunning = false
     try {
       const coordinator = getGlobalTradeEngineCoordinator()
       if (coordinator) {
         isEngineRunning = coordinator.isEngineRunning(connectionId)
       }
     } catch (e) {
       console.warn(`[v0] [ProgressionAPI] ${connectionId}: Failed to check coordinator state, falling back to Redis flag`)
       const runningFlag = await client?.get(`engine_is_running:${connectionId}`).catch(() => null)
       isEngineRunning = runningFlag === "true" || runningFlag === "1"
     }
    
    // Check if this connection is currently active/dashboard enabled
    const isActive = connection?.is_enabled_dashboard === "1" || connection?.is_enabled_dashboard === true
    const isEnabled = connection?.is_enabled === "1" || connection?.is_enabled === true
    const isInserted = connection?.is_inserted === "1" || connection?.is_inserted === true
    const isActiveInserted = connection?.is_active_inserted === "1" || connection?.is_active_inserted === true
    
    // Get progression state (cycles, success rates)
    let progressionState = await ProgressionStateManager.getProgressionState(connectionId, engineType).catch((e) => {
      console.warn(`[v0] [ProgressionAPI] Failed to get progression state for ${connectionId}:`, e)
      return ProgressionStateManager.getDefaultState(connectionId)
    })
    
    // Read live progression hash (written EVERY cycle) for real-time counts
    // This is more current than engineState which persists only every 50-100 cycles
    let progHash: Record<string, string> = {}
    try {
      await ensureScopedProgressionFromLegacy(client, connectionId, engineType)
      const orderedProgressionKeys = progressionReadKeys(scope)
      for (const progressionKey of orderedProgressionKeys) {
        const candidate = (await client.hgetall(progressionKey).catch(() => null)) || {}
        if (Object.keys(candidate).length > 0) {
          progHash = candidate
          break
        }
      }
      // The active progression hash is the most reliable per-session symbol
      // owner. Prefer it over stale connection-level symbol_count values left
      // by old migrations/default profiles so progress does not show 0/20 while
      // stats correctly show the active 1/1 production run.
      const activeProgressionSymbolCount = toNumber(progHash.symbol_count) || toNumber(progHash.quickstart_symbol_count)
      const primaryIsScheduledLegacy = orderedProgressionKeys[0] === scope.legacyProgressionKey
      if (activeProgressionSymbolCount > 0 && (!primaryIsScheduledLegacy || configuredSymbolCount <= 0)) {
        configuredSymbolCount = activeProgressionSymbolCount
      }
    } catch { /* non-critical */ }

    // Cycle counts: prefer live progression hash over engineState (more current)
    const indicationCycleCount =
      parseInt(progHash.indication_cycle_count || "0", 10) ||
      toNumber(engineState?.indication_cycle_count) ||
      progressionState.indicationCycleCount ||
      progressionState.indicationLiveCycleCount ||
      0
    const strategyCycleCount =
      parseInt(progHash.strategy_cycle_count || "0", 10) ||
      toNumber(engineState?.strategy_cycle_count) ||
      progressionState.strategyCycleCount ||
      progressionState.strategyLiveCycleCount ||
      0
    const processorHeartbeat = await getFreshestProcessorHeartbeat(connectionId).catch(() => 0)
    const hasFreshProcessorHeartbeat = processorHeartbeat > 0 && Date.now() - processorHeartbeat < 90_000
    const hasRecentActivity = hasFreshProcessorHeartbeat || (engineState?.last_indication_run
      ? (Date.now() - new Date(engineState.last_indication_run).getTime()) < 60000 // Active in last 60s
      : false)
    
    // Engine is running only when there is current runtime evidence, or when
    // production continuity has explicit/implicit running intent for an
    // assigned+enabled connection that may still be attaching its first worker.
    const engineRunning = isEngineRunning || 
      hasFreshProcessorHeartbeat ||
      (isGloballyRunning && (isActiveInserted || isInserted) && isEnabled) ||
      engineState?.status === "running" ||
      hasRecentActivity

    let indicationsCount = parseInt(progHash.indications_count || "0", 10)
    let strategiesCount  = parseInt(progHash.strategies_count  || "0", 10)

    // Fallback to string counter keys written by statistics-tracker, then to
    // the canonical progression-state fields used by the status endpoint. The
    // old route returned zero stats while /trade-engine/status showed active
    // Base/Main/Real set counts, making the UI look stalled even after the
    // engine reached live trading.
    if (indicationsCount === 0) {
      indicationsCount =
        toNumber(await client.get(`indications:${connectionId}:count`).catch(() => 0)) ||
        progressionState.indicationsCount ||
        progressionState.indicationsDirectionCount ||
        progressionState.indicationsMoveCount ||
        progressionState.indicationsActiveCount ||
        toNumber(engineState?.config_set_indication_results)
    }
    if (strategiesCount === 0) {
      strategiesCount =
        toNumber(await client.get(`strategies:${connectionId}:count`).catch(() => 0)) ||
        progressionState.strategiesCount ||
        Math.max(
          progressionState.strategiesBaseTotal || 0,
          progressionState.strategiesMainTotal || 0,
          progressionState.strategiesRealTotal || 0,
          progressionState.strategyEvaluatedBase || 0,
          progressionState.strategyEvaluatedMain || 0,
          progressionState.strategyEvaluatedReal || 0,
        ) ||
        toNumber(engineState?.total_strategies_evaluated)
    }
    
    // Phase progression depends on stored phase or derived from state
    let phase = progression?.phase || "idle"
    let progress = Number(progression?.progress) || 0
    let detail = progression?.detail || "Not running"

    // ── Prehistoric gate (spec: realtime starts AFTER prehistoric done) ──
    // Read the prehistoric `:done` flag eagerly. While it is unset AND
    // the engine is running, force phase = "prehistoric_data" with the
    // live percent from the stored `engine_progression:{id}` hash —
    // regardless of any incidental indication/strategy cycle counters
    // (which can be non-zero on engine restart from a previous live run).
    // The downstream auto-derivation only kicks in once prehistoric is
    // truly complete, so the user always sees the honest phase + percent.
    const prehistoricGateKeys = buildPrehistoricGateKeys(connectionId, scope.engineType, "done")
    const prehistoricDoneRaw =
      await client?.get(prehistoricGateKeys.scoped).catch(() => null) ||
      await client?.get(prehistoricGateKeys.legacy).catch(() => null)
    const prehistoricDone = String(prehistoricDoneRaw) === "1"

    if (engineRunning && !prehistoricDone) {
      // Trust the engine's own phase update (written per-symbol-completion
      // by config-set-processor) — it carries the live 15 → 95 percent.
      // Fall back to a "starting" 15% if the engine hasn't written one
      // yet (boot transient).
      phase = "prehistoric_data"
      progress = progression?.phase === "prehistoric_data" ? (Number(progression?.progress) || 15) : 15
      detail = progression?.phase === "prehistoric_data"
        ? (progression?.detail || "Prehistoric calc filling sets…")
        : "Prehistoric calc filling sets…"
    } else if (progression?.phase === "live_trading" && Number(progression?.progress || 0) >= 100) {
      // The engine writes the authoritative terminal live-trading state after
      // prehistoric completes. Trust it before heuristic cycle/indication
      // derivation; otherwise a fresh run with indications but zero completed
      // realtime cycles regressed the visible UI back to 90% forever.
      phase = "live_trading"
      progress = 100
      detail = progression.detail || `Live stage ACTIVE — evaluating ${configuredSymbolCount || "configured"} symbols`
    } else if (indicationCycleCount > 100 || progressionState.cyclesCompleted > 100) {
      phase = "live_trading"
      progress = 100
      detail = `Live trading active - ${Math.max(indicationCycleCount, progressionState.cyclesCompleted)} cycles`
    } else if (indicationCycleCount > 20 || progressionState.cyclesCompleted > 20 || indicationsCount > 50) {
      phase = "live_trading"
      progress = 90 + Math.min(10, indicationCycleCount / 100)
      detail = `Live trading - ${Math.max(indicationCycleCount, progressionState.cyclesCompleted)} cycles`
    } else if (indicationCycleCount > 0 || indicationsCount > 0 || progressionState.cyclesCompleted > 0) {
      const totalCycles = Math.max(progressionState.cyclesCompleted, indicationCycleCount)
      phase = "realtime"
      progress = 80 + Math.min(20, totalCycles / 10)
      detail = `Processing - ${totalCycles} cycles`
    } else if (progression?.phase && !["ready", "idle", "initializing"].includes(progression.phase)) {
      phase = progression.phase
      progress = Number(progression.progress) || 50
      detail = progression.detail || "Engine running"
    } else if (engineState?.all_phases_started || engineState?.live_trading_started) {
      phase = "live_trading"
      progress = 100
      detail = "All phases active"
    } else if (engineState?.strategies_started) {
      phase = "strategies"
      progress = 75
      detail = "Strategies processor active"
    } else if (engineState?.indications_started) {
      phase = "indications"
      progress = 60
      detail = "Indications processor active"
    } else if (engineState?.prehistoric_data_loaded) {
      phase = "prehistoric_data"
      progress = 15
      detail = "Prehistoric data loaded"
    } else if (engineState?.status === "running" || isEngineRunning) {
      phase = "initializing"
      progress = 30
      detail = "Engine starting up..."
    } else if (!isEnabled || (!isActiveInserted && !isInserted)) {
      phase = "idle"
      progress = 0
      detail = "Connection disabled or not inserted"
    } else if (progression?.phase === "ready") {
      phase = "ready"
      progress = 0
      detail = progression.detail || "Ready - toggle Enable on dashboard to start"
    }
    
    // Get detailed prehistoric progress tracking
    let prehistoricProgress = {
      symbolsProcessed: 0,
      // Prefer the operator-configured symbol count so the UI never shows a
      // stale 0/1 denominator while prehistoric hashes are being reset or
      // rewritten during a settings-driven recoordination.
      symbolsTotal: Math.max(configuredSymbolCount, 1),
      candlesLoaded: 0,
      candlesTotal: 0,
      indicatorsCalculated: 0,
      currentSymbol: "",
      duration: 0,
      percentComplete: 0,
    }
    
    try {
      if (client) {
        // Check for prehistoric progress tracking in Redis. All three sources
        // are read in parallel — the hash holds the canonical state written by
        // EngineManager / ConfigSetProcessor, the SADD set is the source of
        // truth for the list of processed symbols, and the `:done` marker
        // lets us flip to 100% even if the hash's `is_complete` field was
        // written before a hot reload.
        const [prehistoricDataRaw, prehistoricSymbolsSet, scopedDoneMarker, legacyDoneMarker, legacyPrehistoricRaw] = await Promise.all([
          client.hgetall(scope.prehistoricKey).catch(() => null),
          client.smembers(`${scope.prehistoricKey}:symbols`).catch(() => [] as string[]),
          client.get(prehistoricGateKeys.scoped).catch(() => null),
          client.get(prehistoricGateKeys.legacy).catch(() => null),
          client.hgetall(`prehistoric:${connectionId}`).catch(() => null),
        ])
        const doneMarker = scopedDoneMarker || legacyDoneMarker
        const prehistoricData = (prehistoricDataRaw as Record<string, string> | null) || {}
        const legacyPrehistoric = (legacyPrehistoricRaw as Record<string, string> | null) || {}
        const processedSet = Array.isArray(prehistoricSymbolsSet) ? prehistoricSymbolsSet : []

        if (Object.keys(prehistoricData).length > 0 || processedSet.length > 0 || doneMarker) {
          prehistoricProgress.currentSymbol = prehistoricData.current_symbol || ""
          prehistoricProgress.candlesLoaded = Number(prehistoricData.candles_loaded || 0)
          prehistoricProgress.candlesTotal = Number(prehistoricData.candles_total || 0)
          prehistoricProgress.indicatorsCalculated = Number(prehistoricData.indicators_calculated || 0)
          prehistoricProgress.duration = Number(
            prehistoricData.total_duration_ms || prehistoricData.duration || 0,
          )

          // Use the largest known total. Redis hashes can briefly contain stale
          // legacy values (for example 1) while a background engine start resets
          // prehistoric progress, so the saved connection/engine symbol list is
          // the floor for the denominator.
          const hashSymbolsTotal = Number(prehistoricData.symbols_total || 0)
          const canonicalProgressTotal = configuredSymbolCount > 0 ? configuredSymbolCount : hashSymbolsTotal
          prehistoricProgress.symbolsTotal = Math.max(
            prehistoricProgress.symbolsTotal,
            canonicalProgressTotal,
            processedSet.length,
          )

          // symbolsProcessed — canonical source of truth, in priority order:
          //   1. Hash field `symbols_processed` (written by engine-manager /
          //      config-set-processor on each symbol completion)
          //   2. SCARD of the `prehistoric:{id}:symbols` SADD set
          //   3. Fall back to 1 if currently processing a symbol. Legacy
          //      `:*:completed` markers are repaired by migrations instead of
          //      scanned from the UI poll path.
          const hashProcessed = Number(prehistoricData.symbols_processed || 0)
          const legacyHashProcessed = Number(legacyPrehistoric.symbols_processed || 0)
          const progHashCount = toNumber(progHash.prehistoric_symbols_processed_count)
          const portableProcessed = toNumber(progHash.portable_symbols_processed)
          const engineStateProcessed = toNumber(engineState?.config_set_symbols_processed)
          const setProcessed = processedSet.length
          let processed = Math.max(hashProcessed, legacyHashProcessed, progHashCount, portableProcessed, engineStateProcessed, setProcessed)
          // Do not fall back to a Redis KEYS scan here. In production that scan
          // can block large keyspaces and make the progress endpoint itself
          // look like the stall. Modern processors write both the hash and the
          // canonical SADD set above; legacy completed-marker keys are repaired
          // by migrations instead of scanned on every UI poll.
          if (processed === 0 && prehistoricProgress.currentSymbol) processed = 1
          prehistoricProgress.symbolsProcessed = Math.min(
            processed,
            prehistoricProgress.symbolsTotal,
          )

          const historicProgressState = calculateHistoricProgress(
            prehistoricProgress.symbolsProcessed,
            prehistoricProgress.symbolsTotal,
          )
          prehistoricProgress.symbolsProcessed = historicProgressState.symbolsProcessed
          prehistoricProgress.percentComplete = historicProgressState.progressPercent
        }
      }
    } catch (e) {
      console.warn(`[v0] [ProgressionAPI] Failed to get prehistoric progress for ${connectionId}:`, e)
    }

    // Do not synthesize X/X merely because a stale earlier generation already
    // reached realtime/live. The detailed historic widget remains tied to the
    // measured coverage of the currently selected symbol basket.
    const finalHistoricProgress = calculateHistoricProgress(
      prehistoricProgress.symbolsProcessed,
      prehistoricProgress.symbolsTotal,
    )
    prehistoricProgress.symbolsProcessed = finalHistoricProgress.symbolsProcessed
    prehistoricProgress.percentComplete = finalHistoricProgress.progressPercent
    if (engineRunning && !finalHistoricProgress.isComplete) {
      phase = "prehistoric_data"
      progress = Math.max(
        15,
        Math.min(95, 15 + Math.round(finalHistoricProgress.progressPercent * 0.8)),
      )
      detail = `Prehistoric calc filling sets — ${finalHistoricProgress.symbolsProcessed}/${finalHistoricProgress.symbolsTotal}`
    }
    
    const subItem = progression?.sub_item || (phase === "prehistoric_data" ? "symbols" : "")
    const storedSubCurrent = Number(progression?.sub_current) || 0
    const storedSubTotal = Number(progression?.sub_total) || 0
    const prehistoricProcessedFallback = Math.max(
      toNumber(engineState?.config_set_symbols_processed),
      toNumber(progHash.prehistoric_symbols_processed_count),
      toNumber(progHash.portable_symbols_processed),
    )
    const subCurrent = phase === "prehistoric_data"
      ? Math.max(storedSubCurrent, prehistoricProgress.symbolsProcessed, prehistoricProcessedFallback)
      : storedSubCurrent
    const subTotal = phase === "prehistoric_data"
      ? Math.max(storedSubTotal, prehistoricProgress.symbolsTotal, configuredSymbolCount)
      : storedSubTotal

    // Build comprehensive message
    let message = detail
    if (subTotal > 0 && subCurrent > 0) {
      message = `${detail} (${subCurrent}/${subTotal}${subItem ? ` - ${subItem}` : ""})`
    } else if (engineRunning && phase === "realtime") {
      message = "Processing realtime indications and strategies"
    }

    // Derive detailed step flags from phase progression
    const phaseOrder = ["idle", "initializing", "prehistoric_data", "indications", "strategies", "realtime", "live_trading"]
    const currentIdx = phaseOrder.indexOf(phase)

    // Get recent logs for this connection, but do not let logging I/O block
    // progress/stats rendering during high-throughput recoordination runs.
    const recentLogs = await withProgressionTimeout(
      "recent logs",
      connectionId,
      getProgressionLogs(connectionId, { flush: false }),
      [],
    )

    const response = {
      success: true,
      connectionId,
      connectionName: connName,
      connection: {
        exchange: connection?.exchange || "unknown",
        isActive,
        isEnabled,
        isInserted,
        isActiveInserted,
      },
      progression: {
        phase,
        progress,
        message,
        timestamp: new Date().toISOString(),
        subPhase: subItem || null,
        subProgress: {
          current: subCurrent,
          total: subTotal,
        },
        startedAt: globalState?.started_at || engineState?.started_at || null,
        updatedAt: progression?.updated_at || engineState?.last_indication_run || new Date().toISOString(),
        details: {
          historicalDataLoaded: currentIdx >= 3 || (progressionState.prehistoricCyclesCompleted || 0) > 0,
          indicationsCalculated: currentIdx >= 4 || engineRunning || indicationsCount > 0,
          strategiesProcessed: currentIdx >= 5 || engineRunning || strategiesCount > 0,
          liveProcessingActive: currentIdx >= 5 || engineRunning,
          liveTradingActive: phase === "live_trading",
        },
        prehistoricProgress: prehistoricProgress,
        error: phase === "error" ? detail : null,
      },
      state: {
        cyclesCompleted: progressionState.cyclesCompleted,
        successfulCycles: progressionState.successfulCycles,
        failedCycles: progressionState.failedCycles,
        cycleSuccessRate: Math.round(progressionState.cycleSuccessRate * 10) / 10,
        totalTrades: progressionState.totalTrades,
        successfulTrades: progressionState.successfulTrades,
        totalProfit: progressionState.totalProfit,
        tradeSuccessRate: Math.round((progressionState.tradeSuccessRate ?? 0) * 10) / 10,
        lastCycleTime: progressionState.lastCycleTime?.toISOString() || null,
        prehistoricCyclesCompleted: progressionState.prehistoricCyclesCompleted,
        prehistoricPhaseActive: progressionState.prehistoricPhaseActive,
      },
      metrics: {
        indicationsCount,
        strategiesCount,
        strategiesBaseTotal: progressionState.strategiesBaseTotal || parseInt(progHash.strategies_base_total || "0", 10),
        strategiesMainTotal: progressionState.strategiesMainTotal || parseInt(progHash.strategies_main_total || "0", 10),
        strategiesRealTotal: progressionState.strategiesRealTotal || parseInt(progHash.strategies_real_total || "0", 10),
        strategyEvaluatedBase: progressionState.strategyEvaluatedBase || parseInt(progHash.strategies_base_evaluated || "0", 10),
        strategyEvaluatedMain: progressionState.strategyEvaluatedMain || parseInt(progHash.strategies_main_evaluated || "0", 10),
        strategyEvaluatedReal: progressionState.strategyEvaluatedReal || parseInt(progHash.strategies_real_evaluated || "0", 10),
        intervalsProcessed: toNumber(await client?.get(`intervals:${connectionId}:processed_count`).catch(() => 0)),
        engineRunning,
        // UI consumers historically read `isEngineRunning`; expose the same
        // durable running truth as `engineRunning` so hot-reload coordinator
        // loss does not show a false stopped state while Redis/global/runtime
        // evidence proves the engine is active.
        isEngineRunning: engineRunning,
        coordinatorEngineRunning: isEngineRunning,
        hasRecentActivity,
        globalEngineStatus: globalState?.status || "unknown",
        engineStateStatus: engineState?.status || "unknown",
        indicationCycleCount,
        strategyCycleCount,
        realtimeCycleCount: toNumber(engineState?.realtime_cycle_count),
        // LivePositions loop (Loop C) telemetry — written by engine-manager
        // `tickLivePositions` every 200 ms into `progression:{id}`.
        livePositionsCycleCount: parseInt(progHash.live_positions_cycle_count || "0", 10),
        livePositionsLastCycleAt: toNumber(progHash.live_positions_last_cycle_at),
        livePositionsLastCycleMs: toNumber(progHash.live_positions_last_cycle_ms),
        cycleTimeMs: toNumber(engineState?.last_cycle_duration),
        totalStrategiesEvaluated: toNumber(engineState?.total_strategies_evaluated),
        totalIndicationsEvaluated: toNumber(engineState?.total_indications_evaluated),
        prehistoricSymbolsTotal: Math.max(configuredSymbolCount, prehistoricProgress.symbolsTotal),
        // `prehistoricProgress` already reconciles every writer and clamps the
        // numerator to the current generation's denominator. Re-expanding it
        // with stale legacy 20-symbol counters reintroduced 20/5 in Kilo.
        prehistoricSymbolsProcessed: prehistoricProgress.symbolsProcessed,
        prehistoricCandlesProcessed: toNumber(engineState?.config_set_candles_processed),
        prehistoricIndicationResults: toNumber(engineState?.config_set_indication_results),
        prehistoricStrategyPositions: toNumber(engineState?.config_set_strategy_positions),
        prehistoricErrors: toNumber(engineState?.config_set_errors),
        progressionCyclesCompleted: progressionState.cyclesCompleted,
        lastIndicationRun: engineState?.last_indication_run || null,
        lastStrategyRun: engineState?.last_strategy_run || null,
      },
      recentLogs: recentLogs.slice(0, 20).map(log => ({
        timestamp: log.timestamp,
        level: log.level,
        phase: log.phase,
        message: log.message,
        details: log.details,
      })),
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error("[v0] [Progression] Failed to fetch progression:", error)
    const { id } = await params
    return getErrorResponse(id, error instanceof Error ? error.message : "Unknown error")
  }
}

// Production-safe error response helper
function getErrorResponse(connectionId: string, message: string) {
  return NextResponse.json({ 
    success: false,
    connectionId,
    progression: {
      phase: "error",
      progress: 0,
      message: "Failed to fetch progression status",
      subPhase: null,
      subProgress: { current: 0, total: 0 },
      startedAt: null,
      updatedAt: null,
      details: {
        historicalDataLoaded: false,
        indicationsCalculated: false,
        strategiesProcessed: false,
        liveProcessingActive: false,
        liveTradingActive: false,
      },
      error: message,
    },
  }, { status: 500 })
}
