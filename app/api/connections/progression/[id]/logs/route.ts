import { type NextRequest, NextResponse } from "next/server"
import { getProgressionLogs, clearProgressionLogs } from "@/lib/engine-progression-logs"
import { initRedis, getRedisClient, getSettings } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { buildProgressionScope, ensureScopedProgressionFromLegacy } from "@/lib/progression-scope"
import { compactLogValue } from "@/lib/log-payload"
import { serveSerializedResponseSWR, invalidateSerializedResponseSWR } from "@/lib/serialized-response-swr"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30
export const revalidate = 0

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function sanitizeNonNegative(value: unknown): number {
  return Math.max(0, toNumber(value))
}

async function buildLogsResponse(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id
    const engineType = request.nextUrl.searchParams.get("engineType") || "main"
    const scope = buildProgressionScope(connectionId, engineType)
    
    await initRedis()

    if (!connectionId) {
      return NextResponse.json({ error: "Connection ID required" }, { status: 400 })
    }

    // Get progression logs for this connection
    const logs = await getProgressionLogs(connectionId, { flush: false, limit: 100 })
    
    // Get progression state (cycles, trades, etc.)
    const progressionState = await ProgressionStateManager.getProgressionState(connectionId, engineType)
    const engineState = await getSettings(`trade_engine_state:${connectionId}:${engineType}`)
    
    // Get engine progression phase
    const engineProgression = await getSettings(scope.engineProgressionKey)
    
    // Get structured engine logs
    const client = getRedisClient()
    let structuredLogs: any[] = []
    try {
      const rawLogs = await client.lrange(`engine:logs:${connectionId}`, 0, 99)
      structuredLogs = rawLogs.map((log: string) => {
        try { return compactLogValue(JSON.parse(log)) } catch { return null }
      }).filter(Boolean)
    } catch {
      structuredLogs = []
    }

    // Per-type indication counters are HINCRBY fields written by the engine
    // every indication cycle (`indications_{type}_count`). They are read
    // through the canonical progression reader; Common and Special are not
    // exposed there yet, so those two come from the scoped hash directly.
    let progHashForLogs: Record<string, string> = {}
    try {
      await ensureScopedProgressionFromLegacy(client, connectionId, engineType)
      progHashForLogs = (await client.hgetall(scope.progressionKey)) || {}
    } catch {
      progHashForLogs = {}
    }
    const indicationsByType = {
      direction: toNumber(progressionState.indicationsDirectionCount),
      move:      toNumber(progressionState.indicationsMoveCount),
      active:    toNumber(progressionState.indicationsActiveCount),
      active_advanced: toNumber(progressionState.indicationsActiveAdvancedCount),
      optimal:   toNumber(progressionState.indicationsOptimalCount),
      auto:      toNumber(progressionState.indicationsAutoCount),
      signal:    toNumber(progressionState.indicationsSignalCount),
      trend:     toNumber(progressionState.indicationsTrendCount),
      common:    toNumber(progHashForLogs["indications_common_count"]),
      special:   toNumber(progHashForLogs["indications_special_count"]),
    }
    const indicationsByTypeTotal = Object.values(indicationsByType).reduce((sum, count) => sum + count, 0)

    const mergedLogs = logs.length > 0
      ? logs
      : structuredLogs.map((log: any) => ({
          timestamp: log.timestamp || new Date().toISOString(),
          level: log.status === "error" ? "error" : "info",
          phase: log.phase || log.engine || "engine",
          message: log.action || "structured log",
          details: log.details || {},
          connectionId,
        }))

    // Stage Set totals are the strategy-coordinator's `strategies_{stage}_total`
    // progression counters (the former `progression_lifecycle:{id}` hash is
    // never written). Historic symbols live in the engine-scoped SADD set;
    // the unscoped set is only a fallback for installations that have not
    // created the scoped namespace yet.
    const baseSetCount = toNumber(progressionState.strategiesBaseTotal)
    const mainSetCount = toNumber(progressionState.strategiesMainTotal)
    const realSetCount = toNumber(progressionState.strategiesRealTotal)
    const scopedPrehistoricSymbolsKey = `${scope.prehistoricKey}:symbols`
    const [
      scopedPrehistoricSymbols,
      scopedPrehistoricSymbolsExist,
      legacyPrehistoricSymbols,
      historicIntervalsProcessed,
      schemaVersion,
      redisDbSize,
      redisMemoryInfo,
    ] = await Promise.all([
      client.scard(scopedPrehistoricSymbolsKey).catch(() => 0),
      client.exists(scopedPrehistoricSymbolsKey).catch(() => 0),
      client.scard(`prehistoric:${connectionId}:symbols`).catch(() => 0),
      // Historic intervals are counted by the config-set processor on the
      // prehistoric hash; `intervals:{id}:processed_count` is never written.
      client.hget(scope.prehistoricKey, "intervals_processed").catch(() => null),
      client.get("_schema_version").catch(() => null),
      client.dbSize().catch(() => 0),
      client.info().catch(() => ""),
    ])
    const prehistoricSymbolsSet = toNumber(scopedPrehistoricSymbolsExist) > 0
      ? toNumber(scopedPrehistoricSymbols)
      : toNumber(legacyPrehistoricSymbols)
    const indicationCycleCount = toNumber(progressionState.indicationCycleCount)
    const strategyCycleCount = toNumber(progressionState.strategyCycleCount)
    const realtimeCycleCount = toNumber(progressionState.realtimeCycleCount)

    const usedMemoryLine = String(redisMemoryInfo)
      .split("\n")
      .find((line) => line.startsWith("used_memory:"))
    const usedMemoryBytes = toNumber(usedMemoryLine?.split(":")[1])
    const dbSizeMb = usedMemoryBytes > 0 ? usedMemoryBytes / (1024 * 1024) : 0

    return NextResponse.json({
      success: true,
      connectionId,
      logsCount: mergedLogs.length,
      logsLimit: 100,
      logs: mergedLogs,
      structuredLogs,
      structuredLogsCount: structuredLogs.length,
      progressionState: {
        // Cycle counters are kept out of trade_engine_state by the engine; the
        // progression counters are the only source.
        cyclesCompleted: sanitizeNonNegative(progressionState.cyclesCompleted),
        successfulCycles: sanitizeNonNegative(progressionState.successfulCycles),
        failedCycles: sanitizeNonNegative(progressionState.failedCycles),
        totalTrades: sanitizeNonNegative(progressionState.totalTrades),
        successfulTrades: sanitizeNonNegative(progressionState.successfulTrades),
        totalProfit: toNumber(progressionState.totalProfit),
        cycleSuccessRate: sanitizeNonNegative(progressionState.cycleSuccessRate),
        tradeSuccessRate: sanitizeNonNegative(progressionState.tradeSuccessRate),
        lastCycleTime: progressionState.lastCycleTime,
        prehistoricCyclesCompleted: sanitizeNonNegative(progressionState.prehistoricCyclesCompleted),
        prehistoricPhaseActive: progressionState.prehistoricPhaseActive,
        indicationCycleCount: sanitizeNonNegative(indicationCycleCount),
        strategyCycleCount: sanitizeNonNegative(strategyCycleCount),
        realtimeCycleCount: sanitizeNonNegative(realtimeCycleCount),
        cycleTimeMs: sanitizeNonNegative(engineState?.last_cycle_duration),
        intervalsProcessed: sanitizeNonNegative(historicIntervalsProcessed),
        indicationsCount: sanitizeNonNegative(
          // Prefer the live progression hash total; fall back to the flat counter
          indicationsByTypeTotal > 0
            ? indicationsByTypeTotal
            : toNumber(await client.get(`indications:${connectionId}:count`).catch(() => 0))
        ),
        indicationsByType,
        strategiesCount: sanitizeNonNegative(await client.get(`strategies:${connectionId}:count`).catch(() => 0)),
        strategyEvaluatedBase: sanitizeNonNegative(await client.get(`strategies:${connectionId}:base:evaluated`).catch(() => 0)),
        strategyEvaluatedMain: sanitizeNonNegative(await client.get(`strategies:${connectionId}:main:evaluated`).catch(() => 0)),
        strategyEvaluatedReal: sanitizeNonNegative(await client.get(`strategies:${connectionId}:real:evaluated`).catch(() => 0)),
        // Cumulative indications produced per type since run start (the
        // former `indications:{id}:{type}:evaluated` keys are never written).
        indicationEvaluatedDirection: sanitizeNonNegative(indicationsByType.direction),
        indicationEvaluatedMove: sanitizeNonNegative(indicationsByType.move),
        indicationEvaluatedActive: sanitizeNonNegative(indicationsByType.active),
        indicationEvaluatedActiveAdvanced: sanitizeNonNegative(indicationsByType.active_advanced),
        indicationEvaluatedOptimal: sanitizeNonNegative(indicationsByType.optimal),
        indicationEvaluatedAuto: sanitizeNonNegative(indicationsByType.auto),
        indicationEvaluatedSignal: sanitizeNonNegative(indicationsByType.signal),
        indicationEvaluatedTrend: sanitizeNonNegative(indicationsByType.trend),
        prehistoricSymbolsProcessed: sanitizeNonNegative(engineState?.config_set_symbols_processed),
        prehistoricCandlesProcessed: sanitizeNonNegative(engineState?.config_set_candles_processed),
        prehistoricSymbolsProcessedCount: sanitizeNonNegative(prehistoricSymbolsSet || engineState?.config_set_symbols_processed),
        // Log polling must never scan the entire production keyspace.
        prehistoricDataSize: null,
        prehistoricDataSizeAvailable: false,
        setsBaseCount: sanitizeNonNegative(baseSetCount),
        setsMainCount: sanitizeNonNegative(mainSetCount),
        setsRealCount: sanitizeNonNegative(realSetCount),
        // `setsTotalCount` is the pipeline's final-stage output (Real).
        // Main can derive multiple related Sets from Base, so parent and
        // downstream stage populations must not be summed.
        setsTotalCount: sanitizeNonNegative(realSetCount),
        redisDbEntries: sanitizeNonNegative(redisDbSize),
        redisDbSizeMb: Number(dbSizeMb.toFixed(2)),
        // Applied Redis schema (migration) version; null when never migrated.
        schemaVersion: schemaVersion === null || schemaVersion === undefined ? null : sanitizeNonNegative(schemaVersion),
        processingCompleteness: {
          prehistoricLoaded: !!(engineState?.prehistoric_data_loaded === true || engineState?.prehistoric_data_loaded === "1" || engineState?.prehistoric_data_loaded === "true"),
          indicationsRunning: indicationCycleCount > 0,
          strategiesRunning: strategyCycleCount > 0,
          realtimeRunning: realtimeCycleCount > 0,
          hasErrors: sanitizeNonNegative(engineState?.config_set_errors) > 0,
        },
      },
      enginePhase: engineProgression ? {
        phase: engineProgression.phase,
        progress: engineProgression.progress,
        detail: engineProgression.detail,
        updatedAt: engineProgression.updated_at,
      } : null,
      timestamp: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    console.error("[v0] Error fetching progression logs:", error)
    return NextResponse.json(
      { error: "Failed to fetch progression logs", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const scope = buildProgressionScope(id, request.nextUrl.searchParams.get("engineType") || "main")
  return serveSerializedResponseSWR({
    namespace: "progression-logs",
    key: scope.progressionKey,
    freshMs: 5_000,
    maxStaleMs: 15_000,
    producer: () => buildLogsResponse(request, context),
  })
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id
    const engineType = request.nextUrl.searchParams.get("engineType") || "main"
    const scope = buildProgressionScope(connectionId, engineType)
    
    await initRedis()

    if (!connectionId) {
      return NextResponse.json({ error: "Connection ID required" }, { status: 400 })
    }

    // Clear progression logs
    await clearProgressionLogs(connectionId)
    invalidateSerializedResponseSWR("progression-logs")
    
    // Also clear structured logs
    const client = getRedisClient()
    await client.del(`engine:logs:${connectionId}`)
    await client.del(`engine_logs:${connectionId}`)

    return NextResponse.json({
      success: true,
      message: "Logs cleared successfully",
      connectionId,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] Error clearing progression logs:", error)
    return NextResponse.json(
      { error: "Failed to clear logs", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
