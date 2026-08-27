/**
 * Processing Metrics API
 *
 * The long-lived engine owner persists its authoritative counters in Redis.
 * A request-local ProcessingMetricsTracker is not authoritative after a
 * process restart (and, in a standalone Next server, may never share the
 * engine module instance at all). Reconstruct the UI projection from the
 * durable progression/state hashes so recovery preserves cycle counts and a
 * healthy engine cannot be displayed as a new `0/0 idle` tracker.
 */

import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { getConnection, getRedisClient, initRedis } from "@/lib/redis-db"
import type { PhaseMetrics, ProcessingMetrics } from "@/lib/processing-metrics"
import { buildProgressionScope, progressionReadKeys } from "@/lib/progression-scope"

export const dynamic = "force-dynamic"

type Hash = Record<string, string>

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function maxField(hashes: Hash[], ...fields: string[]): number {
  let result = 0
  for (const hash of hashes) {
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(hash, field)) {
        result = Math.max(result, finite(hash[field]))
      }
    }
  }
  return result
}

function firstText(hashes: Hash[], ...fields: string[]): string {
  for (const hash of hashes) {
    for (const field of fields) {
      const value = String(hash[field] || "").trim()
      if (value) return value
    }
  }
  return ""
}

function timestamp(value: unknown): number {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  }
  const parsed = Date.parse(String(value || ""))
  return Number.isFinite(parsed) ? parsed : 0
}

function parseSymbols(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean)
  const text = String(value || "").trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parseSymbols(parsed)
  } catch {
    // Legacy connection rows can contain a comma-delimited basket.
  }
  return text.split(/[\n,|]/).map((item) => item.trim()).filter(Boolean)
}

function phase(
  status: PhaseMetrics["status"],
  cycleCount: number,
  itemsProcessed: number,
  itemsTotal: number,
  progress: number,
  duration: number,
  lastUpdate: string,
  errors: number,
  currentTimeframe: string,
): PhaseMetrics {
  return {
    status,
    cycleCount,
    itemsProcessed,
    itemsTotal,
    progress: Math.max(0, Math.min(100, progress)),
    currentTimeframe,
    duration,
    lastUpdate,
    errors,
  }
}

function continuousStatus(running: boolean, cycles: number): PhaseMetrics["status"] {
  if (running) return "running"
  return cycles > 0 ? "completed" : "idle"
}

function summary(metrics: ProcessingMetrics): string {
  const phases = Object.entries(metrics.phases)
    .map(([name, item]) => `${name}: ${item.cycleCount} cycles, ${item.itemsProcessed}/${item.itemsTotal} items`)
    .join(" | ")
  const evaluations = Object.entries(metrics.evaluationCounts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}: ${count}`)
    .join(", ")
  return `Processing Metrics: ${phases} | Evaluations: ${evaluations || "unavailable"} | Positions: ${metrics.pseudoPositions.currentActive} active | Last cycle: ${metrics.performanceMetrics.avgCycleDuration.toFixed(0)}ms`
}

export async function GET(request: NextRequest) {
  try {
    const connectionId = String(request.nextUrl.searchParams.get("connectionId") || "").trim()
    if (!connectionId) {
      return NextResponse.json({ error: "Missing connectionId parameter" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient()
    const connection = await getConnection(connectionId).catch(() => null) as Record<string, unknown> | null
    const engineType = String(connection?.engine_type || connection?.engineType || "main").trim() || "main"
    const scope = buildProgressionScope(connectionId, engineType)
    const progressionKeys = [...new Set(progressionReadKeys(scope))]
    const engineStateKeys = [...new Set([
      scope.tradeEngineStateKey,
      `settings:trade_engine_state:${connectionId}`,
      `trade_engine_state:${connectionId}:${engineType}`,
      `trade_engine_state:${connectionId}`,
    ])]

    const [progressionHashes, engineStateHashes, prehistoricHashes, persistedRaw, activePositions] = await Promise.all([
      Promise.all(progressionKeys.map((key) => client.hgetall(key).catch(() => ({} as Hash)))),
      Promise.all(engineStateKeys.map((key) => client.hgetall(key).catch(() => ({} as Hash)))),
      Promise.all([
        client.hgetall(scope.prehistoricKey).catch(() => ({} as Hash)),
        client.hgetall(`prehistoric:${connectionId}`).catch(() => ({} as Hash)),
      ]),
      client.get(`processing_metrics:${connectionId}`).catch(() => null),
      client.scard(`pseudo_positions:${connectionId}:active_config_keys`).catch(() => 0),
    ])

    const progression = progressionHashes.filter((hash) => hash && Object.keys(hash).length > 0)
    const engineStates = engineStateHashes.filter((hash) => hash && Object.keys(hash).length > 0)
    const prehistoric = prehistoricHashes.filter((hash) => hash && Object.keys(hash).length > 0)
    const allRuntimeHashes = [...engineStates, ...progression]
    const available = progression.length > 0 || engineStates.length > 0 || prehistoric.length > 0

    let persisted: ProcessingMetrics | null = null
    if (persistedRaw) {
      try {
        const parsed = JSON.parse(persistedRaw)
        if (parsed && typeof parsed === "object") persisted = parsed as ProcessingMetrics
      } catch {
        // A malformed compatibility snapshot is ignored; canonical hashes win.
      }
    }

    const configuredSymbols = parseSymbols(
      connection?.force_symbols ?? connection?.active_symbols ?? connection?.symbols,
    )
    const symbolTotal = Math.max(
      configuredSymbols.length,
      maxField(prehistoric, "symbols_total"),
      maxField(allRuntimeHashes, "symbol_count", "symbols_total", "config_set_symbols_total"),
    )
    const historicProcessedRaw = Math.max(
      maxField(prehistoric, "symbols_processed"),
      maxField(allRuntimeHashes, "prehistoric_symbols_processed_count", "config_set_symbols_processed"),
    )
    const historicProcessed = symbolTotal > 0
      ? Math.min(symbolTotal, historicProcessedRaw)
      : historicProcessedRaw
    const bootstrapStatus = firstText(engineStates, "prehistoric_bootstrap_status").toLowerCase()
    const historicComplete =
      (symbolTotal > 0 && historicProcessed >= symbolTotal) ||
      bootstrapStatus === "complete" ||
      firstText(prehistoric, "is_complete") === "1"

    const lastHeartbeatMs = Math.max(
      ...allRuntimeHashes.map((hash) => Math.max(
        timestamp(hash.last_processor_heartbeat),
        timestamp(hash.last_heartbeat_at),
        timestamp(hash.heartbeat_at),
        timestamp(hash.updated_at),
      )),
      0,
    )
    const stateText = firstText(engineStates, "actual_status", "status").toLowerCase()
    const running = ["running", "active", "processing", "starting"].includes(stateText) &&
      lastHeartbeatMs > 0 && Date.now() - lastHeartbeatMs <= 120_000
    const lastUpdate = lastHeartbeatMs > 0
      ? new Date(lastHeartbeatMs).toISOString()
      : firstText(allRuntimeHashes, "updated_at", "last_update") || new Date().toISOString()
    const timeframe = firstText(allRuntimeHashes, "current_timeframe", "timeframe") || "1m"

    const indicationCycles = maxField(allRuntimeHashes, "indication_cycle_count", "indication_live_cycle_count")
    const strategyCycles = maxField(allRuntimeHashes, "strategy_cycle_count", "strategy_live_cycle_count")
    const realtimeCycles = maxField(allRuntimeHashes, "realtime_cycle_count", "realtime_live_cycle_count")
    const prehistoricCycles = maxField(allRuntimeHashes, "prehistoric_cycles_completed", "prehistoric_progression_cycles")
    const lastCycleDuration = maxField(allRuntimeHashes, "last_cycle_duration", "cycle_duration", "prehistoric_progression_last_cycle_ms")
    const engineErrors = maxField(allRuntimeHashes, "cycle_error_count", "errors", "failed_cycles")
    const historicErrors = maxField(prehistoric, "config_work_failed_units", "errors")
    const continuousItems = symbolTotal > 0 ? symbolTotal : Math.max(1, configuredSymbols.length)
    const continuousProgress = running || indicationCycles + strategyCycles + realtimeCycles > 0 ? 100 : 0

    const nowIso = new Date().toISOString()
    const metrics: ProcessingMetrics = {
      connectionId,
      timestamp: nowIso,
      phases: {
        prehistoric: phase(
          historicComplete ? "completed" : running ? "running" : "idle",
          prehistoricCycles,
          historicProcessed,
          symbolTotal,
          historicComplete ? 100 : symbolTotal > 0 ? (historicProcessed / symbolTotal) * 100 : 0,
          maxField(prehistoric, "duration_ms", "processing_duration_ms") ||
            maxField(allRuntimeHashes, "prehistoric_duration_ms"),
          firstText(prehistoric, "last_processed_at", "completed_at", "updated_at") || lastUpdate,
          historicErrors,
          timeframe,
        ),
        realtime: phase(
          continuousStatus(running, realtimeCycles),
          realtimeCycles,
          realtimeCycles > 0 ? continuousItems : 0,
          continuousItems,
          continuousProgress,
          lastCycleDuration,
          lastUpdate,
          engineErrors,
          timeframe,
        ),
        indication: phase(
          continuousStatus(running, indicationCycles),
          indicationCycles,
          indicationCycles > 0 ? continuousItems : 0,
          continuousItems,
          continuousProgress,
          lastCycleDuration,
          lastUpdate,
          engineErrors,
          timeframe,
        ),
        strategy: phase(
          continuousStatus(running, strategyCycles),
          strategyCycles,
          strategyCycles > 0 ? continuousItems : 0,
          continuousItems,
          continuousProgress,
          lastCycleDuration,
          lastUpdate,
          engineErrors,
          timeframe,
        ),
      },
      dataSizes: persisted?.dataSizes || {},
      evaluationCounts: {
        indicationBase: maxField(allRuntimeHashes, "indications_count", "prehistoric_indications_total"),
        indicationMain: maxField(allRuntimeHashes, "indications_main_total"),
        indicationOptimal: maxField(allRuntimeHashes, "indications_optimal_total"),
        strategyBase: maxField(allRuntimeHashes, "strategies_base_total", "base_positions_created_count"),
        strategyMain: maxField(allRuntimeHashes, "strategies_main_total", "main_positions_created_count"),
        strategyReal: maxField(allRuntimeHashes, "strategies_real_total", "real_positions_created_count"),
      },
      pseudoPositions: {
        totalCreated: maxField(allRuntimeHashes, "live_positions_created_count", "base_positions_created_count"),
        totalEvaluated: maxField(allRuntimeHashes, "real_positions_created_count", "strategies_real_total"),
        currentActive: finite(activePositions),
      },
      performanceMetrics: {
        avgCycleDuration: lastCycleDuration || persisted?.performanceMetrics?.avgCycleDuration || 0,
        totalProcessingTime: maxField(allRuntimeHashes, "total_processing_time", "total_cycle_duration") ||
          persisted?.performanceMetrics?.totalProcessingTime || 0,
        lastUpdate,
      },
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          current: metrics,
          summary: summary(metrics),
          persisted,
          availability: {
            available,
            source: available ? "redis_engine_progression" : persisted ? "persisted_processing_snapshot" : "unavailable",
            recoveredAfterRestart: available && !persisted,
            engineRunning: running,
            heartbeatAgeMs: lastHeartbeatMs > 0 ? Math.max(0, Date.now() - lastHeartbeatMs) : null,
            symbolCount: symbolTotal || null,
            capturedAt: nowIso,
          },
          timestamp: nowIso,
        },
      },
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      },
    )
  } catch (error) {
    console.error("[API] Processing metrics error:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to get processing metrics",
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    )
  }
}
