import { NextResponse } from "next/server"
import { initRedis, getAllConnections, getRedisClient, getSettings } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { getProgressionLogs } from "@/lib/engine-progression-logs"
import { getFreshestProcessorHeartbeat } from "@/lib/engine-heartbeat"
import { buildPrehistoricGateKeys, buildProgressionScope } from "@/lib/progression-scope"
import { SystemLogger } from "@/lib/system-logger"
import { mapWithConcurrency } from "@/lib/bounded-concurrency"
import { normalizeSignalMaxPositions } from "@/lib/signal-position-policy"

function mapPhaseToType(phase: string, level = "info") {
  if (level === "error") return "error"
  if (level === "warning" || level === "warn") return "warning"
  // Order matters — "live_trading" must be classified before "position" so
  // that the new Live filter in the UI captures exchange-side events only.
  if (phase.includes("live")) return "live"
  if (phase.includes("setting") || phase.includes("recoordination") || phase.includes("toggle")) return "settings"
  if (phase.includes("prehistoric") || phase.includes("historic")) return "processing"
  if (phase.includes("indication")) return "indication"
  if (phase.includes("strategy")) return "strategy"
  if (phase.includes("position")) return "position"
  if (phase.includes("error")) return "error"
  return "engine"
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

const INDICATION_TYPES = ["direction", "move", "active", "active_advanced", "special", "optimal", "auto", "common", "signal", "trend"] as const
const HEARTBEAT_STALE_MS = 120_000
const PROCESSING_STALE_MS = 120_000
const MONITOR_READ_DEADLINE_MS = 10_000

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function toEpochMs(value: unknown): number {
  if (value == null || value === "") return 0
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function parseSymbols(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => String(item).trim().toUpperCase()).filter(Boolean)))
  }
  if (typeof value !== "string" || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parseSymbols(parsed)
  } catch {
    // Accept legacy comma-separated values.
  }
  return Array.from(new Set(value.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean)))
}

type MonitorAlert = {
  id: string
  level: "critical" | "warning" | "info"
  category: string
  message: string
  timestamp: string
  connectionId?: string
  details?: Record<string, unknown>
}

async function withinMonitorDeadline<T>(
  work: Promise<T>,
  deadlineAt: number,
  label: string,
): Promise<T> {
  const remainingMs = Math.max(1, deadlineAt - Date.now())
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Detailed monitoring timed out while reading ${label}`)),
          remainingMs,
        )
      }),
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

async function getRecentLiveOrderAudits(client: ReturnType<typeof getRedisClient>, connectionIds: string[], limit = 75) {
  const rowsByConnection = await mapWithConcurrency(connectionIds, 6, async (connectionId) => {
    const rows: any[] = []
    try {
      const traceIds = await client.zrevrange(`live_order_audit:${connectionId}:recent`, 0, limit - 1).catch(() => [])
      const rawRows = await mapWithConcurrency(
        traceIds,
        12,
        (traceId) => client.get(`live_order_audit:${connectionId}:${traceId}`).catch(() => null),
      )
      for (const raw of rawRows) {
        if (!raw) continue
        try { rows.push(typeof raw === "string" ? JSON.parse(raw) : raw) } catch { /* ignore malformed audit */ }
      }
    } catch {
      // best-effort diagnostics only
    }
    return rows
  })

  return rowsByConnection
    .flat()
    .filter((row) => row && row.traceId && row.connectionId)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())
    .slice(0, limit)
}

async function countIndicationsByType(client: ReturnType<typeof getRedisClient>, connectionId: string) {
  const counters = await Promise.all(
    INDICATION_TYPES.map(async (type) => ({
      type,
      count: toNumber(await client.get(`indications:${connectionId}:${type}:count`).catch(() => 0)),
    })),
  )

  const result = counters.reduce(
    (acc, item) => {
      acc[item.type] = item.count
      acc.total += item.count
      return acc
    },
    { direction: 0, move: 0, active: 0, active_advanced: 0, special: 0, optimal: 0, auto: 0, common: 0, signal: 0, trend: 0, total: 0 } as Record<string, number>,
  )

  // Never wildcard-scan indication result keys from a polling endpoint. The
  // bounded counters above are the canonical monitoring read model.
  return result
}

async function countStrategiesByType(client: ReturnType<typeof getRedisClient>, connectionId: string, symbols: string[]) {
  // PRIMARY: read from per-stage counter keys written by statistics-tracker (most current)
  const [baseFromCounter, mainFromCounter, realFromCounter] = await Promise.all([
    client.get(`strategies:${connectionId}:base:count`).then(v => toNumber(v)).catch(() => 0),
    client.get(`strategies:${connectionId}:main:count`).then(v => toNumber(v)).catch(() => 0),
    client.get(`strategies:${connectionId}:real:count`).then(v => toNumber(v)).catch(() => 0),
  ])

  if (baseFromCounter > 0 || mainFromCounter > 0 || realFromCounter > 0) {
    return { base: baseFromCounter, main: mainFromCounter, real: realFromCounter }
  }

  // SECONDARY: read from progression hash written by StrategyCoordinator (hincrby every cycle)
  try {
    const progHash = await client.hgetall(`progression:${connectionId}`) || {}
    const baseFromHash = parseInt(progHash.strategies_base_total || "0", 10)
    const mainFromHash = parseInt(progHash.strategies_main_total || "0", 10)
    const realFromHash = parseInt(progHash.strategies_real_total || "0", 10)
    if (baseFromHash > 0 || mainFromHash > 0 || realFromHash > 0) {
      return { base: baseFromHash, main: mainFromHash, real: realFromHash }
    }
  } catch { /* non-critical */ }

  // TERTIARY: fall back to settings hash keys written by setSettings in StrategyCoordinator
  // Key pattern: settings:strategies:{connId}:{symbol}:{stage}:sets (hash with .count field)
  const uniqueSymbols = Array.from(new Set(symbols.filter(Boolean)))
  if (uniqueSymbols.length === 0) {
    uniqueSymbols.push("BTCUSDT", "ETHUSDT", "SOLUSDT")
  }

  const rows = await Promise.all(
    uniqueSymbols.flatMap((symbol) =>
      (["base", "main", "real"] as const).map(async (stage) => {
      try {
        const settingsHash = await client.hgetall(`settings:strategies:${connectionId}:${symbol}:${stage}:sets`)
        return { stage, count: parseInt(settingsHash?.count || "0", 10) || 0 }
      } catch { /* non-critical */ }
        return { stage, count: 0 }
      }),
    ),
  )
  const totals = rows.reduce(
    (acc, row) => {
      acc[row.stage] += row.count
      return acc
    },
    { base: 0, main: 0, real: 0 },
  )

  return totals
}

async function getStrategyEvaluationCounters(client: ReturnType<typeof getRedisClient>, connectionId: string) {
  const [baseEvaluated, mainEvaluated, realEvaluated, basePassed, mainPassed, realPassed] = await Promise.all([
    client.get(`strategies:${connectionId}:base:evaluated`).catch(() => 0),
    client.get(`strategies:${connectionId}:main:evaluated`).catch(() => 0),
    client.get(`strategies:${connectionId}:real:evaluated`).catch(() => 0),
    client.get(`strategies:${connectionId}:base:passed`).catch(() => 0),
    client.get(`strategies:${connectionId}:main:passed`).catch(() => 0),
    client.get(`strategies:${connectionId}:real:passed`).catch(() => 0),
  ])

  return {
    base: toNumber(baseEvaluated),
    main: toNumber(mainEvaluated),
    real: toNumber(realEvaluated),
    passed: {
      base: toNumber(basePassed),
      main: toNumber(mainPassed),
      real: toNumber(realPassed),
    },
  }
}

export const dynamic = "force-dynamic"
export const maxDuration = 15

export async function GET(request: Request) {
  try {
    const monitorDeadlineAt = Date.now() + MONITOR_READ_DEADLINE_MS
    await withinMonitorDeadline(initRedis(), monitorDeadlineAt, "database initialization")
    const { searchParams } = new URL(request.url)
    const selectedConnectionId = searchParams.get("connectionId")
    const selectedExchange = (searchParams.get("exchange") || "").toLowerCase()

    const allConnections = await withinMonitorDeadline(
      getAllConnections(),
      monitorDeadlineAt,
      "connections",
    )
    let activeConnections = allConnections.filter((c: any) => {
      const exch = (c.exchange || "").toLowerCase()
      const isBase = ["bingx", "bybit", "pionex", "orangex"].includes(exch)
      return isBase || isTruthy(c.is_dashboard_inserted) || isTruthy(c.is_active_inserted) || isTruthy(c.is_enabled_dashboard)
    })

    if (selectedConnectionId) {
      activeConnections = activeConnections.filter((c: any) => c.id === selectedConnectionId)
    } else if (selectedExchange) {
      activeConnections = activeConnections.filter((c: any) => (c.exchange || "").toLowerCase() === selectedExchange)
    }

    const [
      connectionReadModels,
      globalLogs,
      systemLogsRaw,
    ] = await withinMonitorDeadline(
      Promise.all([
        mapWithConcurrency(activeConnections, 6, async (connection: any) => {
          const [progression, connectionLogs] = await Promise.all([
            ProgressionStateManager.getProgressionState(connection.id),
            getProgressionLogs(connection.id),
          ])
          return { progression, connectionLogs }
        }),
        getProgressionLogs("global"),
        SystemLogger.getLogs(undefined, 200),
      ]),
      monitorDeadlineAt,
      "progress and logs",
    )
    const progressionStates = connectionReadModels.map((item) => item.progression)
    const logsByConnection = connectionReadModels.map((item) => item.connectionLogs)

    const combinedLogsRaw = [...logsByConnection.flat(), ...globalLogs]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 300)

    const logs = combinedLogsRaw.map((log, index) => ({
      id: `${log.connectionId}-${index}-${log.timestamp}`,
      timestamp: log.timestamp,
      level: log.level === "warning" ? "warn" : log.level,
      category: "engine",
      type: mapPhaseToType(log.phase, log.level),
      symbol: log.details?.symbol,
      phase: log.phase,
      message: log.message,
      connectionId: log.connectionId,
      details: log.details || {},
    }))

    const selectedIds = new Set(activeConnections.map((connection: any) => connection.id))
    const systemLogs = systemLogsRaw
      .filter((log) => {
        if (!selectedConnectionId && !selectedExchange) return true
        const logConnectionId = String(log.metadata?.connectionId || "")
        return !logConnectionId || selectedIds.has(logConnectionId)
      })
      .map((log, index) => {
        const connectionId = String(log.metadata?.connectionId || "") || undefined
        const level = log.level === "warn" ? "warn" : log.level
        return {
          id: `system-${index}-${log.timestamp}`,
          timestamp: log.timestamp,
          level,
          category: log.category || "system",
          type: mapPhaseToType(`system_${log.category || "event"}`, level),
          phase: `system_${log.category || "event"}`,
          message: log.message,
          connectionId,
          symbol: typeof log.metadata?.symbol === "string" ? log.metadata.symbol : undefined,
          details: log.metadata || {},
        }
      })

    const client = getRedisClient()
    const rawSignalSettings = await withinMonitorDeadline(
      client.get("indications:signal").catch(() => null),
      monitorDeadlineAt,
      "Signal settings",
    )
    let configuredSignalPositionLimit = normalizeSignalMaxPositions(undefined)
    try {
      const parsed = typeof rawSignalSettings === "string"
        ? JSON.parse(rawSignalSettings)
        : rawSignalSettings
      const configured = Number(parsed?.maxPositionsTotal)
      if (Number.isFinite(configured)) {
        configuredSignalPositionLimit = normalizeSignalMaxPositions(configured)
      }
    } catch {
      // The engine applies the same safe default when legacy JSON is malformed.
    }
    const auditRows = await withinMonitorDeadline(
      getRecentLiveOrderAudits(client, activeConnections.map((c: any) => c.id)),
      monitorDeadlineAt,
      "order audits",
    )
    const auditLogs = auditRows.map((audit: any) => ({
      id: `audit-${audit.connectionId}-${audit.traceId}`,
      timestamp: audit.updatedAt || audit.createdAt || new Date().toISOString(),
      level:
        audit.entryOrderStatus === "failed" || audit.entryOrderStatus === "rejected"
          ? "error"
          : "info",
      category: "orders",
      type:
        audit.entryOrderStatus === "failed" || audit.entryOrderStatus === "rejected"
          ? "error"
          : "live",
      symbol: audit.symbol,
      phase: "live_order_audit",
      message: `Live order audit ${audit.symbol} ${audit.direction} ${audit.entryOrderStatus || "pending"} protection=${audit.protectionState}`,
      connectionId: audit.connectionId,
      details: audit,
    }))

    const perConnection = await withinMonitorDeadline(
      mapWithConcurrency(activeConnections, 6, async (conn: any, index: number) => {
        const progression = progressionStates[index] || {}
        const scope = buildProgressionScope(conn.id, "main")
        const doneGateKeys = buildPrehistoricGateKeys(conn.id, "main", "done")
        const firstPassGateKeys = buildPrehistoricGateKeys(conn.id, "main", "firstpass:done")
        const [
          settingsStateRaw,
          rawState,
          scopedState,
          legacyProgHash,
          scopedProgHash,
          legacyPrehistoricHash,
          scopedPrehistoricHash,
          signalCapacityRaw,
          heartbeatAt,
          doneScoped,
          doneLegacy,
          firstPassScoped,
          firstPassLegacy,
        ] = await Promise.all([
          getSettings(`trade_engine_state:${conn.id}`).catch(() => ({})),
          client.hgetall(`trade_engine_state:${conn.id}`).catch(() => ({} as Record<string, string>)),
          client.hgetall(scope.tradeEngineStateKey).catch(() => ({} as Record<string, string>)),
          client.hgetall(`progression:${conn.id}`).catch(() => ({} as Record<string, string>)),
          client.hgetall(scope.progressionKey).catch(() => ({} as Record<string, string>)),
          client.hgetall(`prehistoric:${conn.id}`).catch(() => ({} as Record<string, string>)),
          client.hgetall(scope.prehistoricKey).catch(() => ({} as Record<string, string>)),
          client.hgetall(`signal:position_capacity:${conn.id}`).catch(() => ({} as Record<string, string>)),
          getFreshestProcessorHeartbeat(conn.id),
          client.get(doneGateKeys.scoped).catch(() => null),
          client.get(doneGateKeys.legacy).catch(() => null),
          client.get(firstPassGateKeys.scoped).catch(() => null),
          client.get(firstPassGateKeys.legacy).catch(() => null),
        ])
        const state = {
          ...(rawState || {}),
          ...(scopedState || {}),
          ...((settingsStateRaw as Record<string, unknown>) || {}),
        }
        const progHash = {
          ...(legacyProgHash || {}),
          ...(scopedProgHash || {}),
        }
        const progressionCounter = (field: string) =>
          Math.max(
            toNumber((legacyProgHash as Record<string, string>)?.[field]),
            toNumber((scopedProgHash as Record<string, string>)?.[field]),
          )
        const hasScopedPrehistoric = Object.keys(scopedPrehistoricHash || {}).length > 0
        const prehistoricHash = hasScopedPrehistoric
          ? scopedPrehistoricHash
          : legacyPrehistoricHash

        const symbols =
          parseSymbols((state as any).selected_symbols).length > 0
            ? parseSymbols((state as any).selected_symbols)
            : parseSymbols(
                (state as any).force_symbols ||
                (state as any).active_symbols ||
                (state as any).symbols ||
                conn.selected_symbols ||
                conn.force_symbols ||
                conn.active_symbols ||
                conn.symbols,
              )

        const historicSymbolsKey = hasScopedPrehistoric
          ? `${scope.prehistoricKey}:symbols`
          : `prehistoric:${conn.id}:symbols`
        const [indicationsByType, strategyCounts, strategyEvaluations, basePseudoCount, mainPseudoCount, realPseudoCount, baseDirection, baseMove, baseActive, baseActiveAdvanced, baseSpecial, baseOptimal, baseCommon, baseSignal, baseTrend, livePositionsCount, prehistoricSymbols, processedIntervalsRaw] =
          await Promise.all([
            countIndicationsByType(client, conn.id),
            countStrategiesByType(client, conn.id, symbols),
            getStrategyEvaluationCounters(client, conn.id),
            client.scard(`base_pseudo:${conn.id}`).catch(() => 0),
            client.scard(`main_pseudo:${conn.id}`).catch(() => 0),
            client.scard(`real_pseudo:${conn.id}`).catch(() => 0), // active/open validated Real stage only (reconciled)
            client.scard(`base_pseudo:${conn.id}:direction`).catch(() => 0),
            client.scard(`base_pseudo:${conn.id}:move`).catch(() => 0),
            client.scard(`base_pseudo:${conn.id}:active`).catch(() => 0),
            client.scard(`base_pseudo:${conn.id}:active_advanced`).catch(() => 0),
            client.scard(`base_pseudo:${conn.id}:special`).catch(() => 0),
            client.scard(`base_pseudo:${conn.id}:optimal`).catch(() => 0),
            client.scard(`base_pseudo:${conn.id}:common`).catch(() => 0),
            client.scard(`base_pseudo:${conn.id}:signal`).catch(() => 0),
            client.scard(`base_pseudo:${conn.id}:trend`).catch(() => 0),
            client.scard(`positions:${conn.id}:live`).catch(() => 0),
            client.scard(historicSymbolsKey).catch(() => 0),
            client.get(`intervals:${conn.id}:processed_count`).catch(() => 0),
          ])

        const processedIntervals = toNumber(processedIntervalsRaw)
        const now = Date.now()
        const dashboardEnabled = isTruthy(conn.is_enabled_dashboard)
        const heartbeatAgeMs = heartbeatAt > 0 ? Math.max(0, now - heartbeatAt) : null
        const selectionEpoch = String(
          (state as any).symbol_selection_epoch ||
          progHash.symbol_selection_epoch ||
          conn.symbol_selection_epoch ||
          (state as any).quickstart_symbol_generation ||
          "",
        )
        const historicSelectionEpoch = String(prehistoricHash.symbol_selection_epoch || "")
        const generationMatches =
          !selectionEpoch ||
          (!historicSelectionEpoch
            ? !isTruthy((state as any).prehistoric_data_loaded)
            : historicSelectionEpoch === selectionEpoch)
        const historicSymbolsTotal = Math.max(
          symbols.length,
          toNumber(prehistoricHash.symbols_total),
        )
        const historicSymbolsProcessed = generationMatches
          ? Math.min(
              historicSymbolsTotal,
              Math.max(prehistoricSymbols, toNumber(prehistoricHash.symbols_processed)),
            )
          : 0
        const completionGatesOpen =
          (doneScoped === "1" || doneLegacy === "1") &&
          (firstPassScoped === "1" || firstPassLegacy === "1")
        const prehistoricLoaded =
          isTruthy((state as any).prehistoric_data_loaded) &&
          generationMatches &&
          completionGatesOpen &&
          historicSymbolsTotal > 0 &&
          historicSymbolsProcessed >= historicSymbolsTotal &&
          prehistoricHash.is_complete === "1"
        const bootstrapStatus = String(
          (state as any).prehistoric_bootstrap_status ||
          prehistoricHash.bootstrap_status ||
          (prehistoricLoaded ? "complete" : dashboardEnabled ? "running" : "idle"),
        )
        const entryProcessorsGated =
          isTruthy((state as any).entry_processors_gated) ||
          (dashboardEnabled && !prehistoricLoaded)
        const settingsRequestedVersion = String(
          progHash.settings_recoordination_requested_version ||
          (state as any).settings_recoordination_requested_version ||
          "",
        )
        const settingsAppliedVersion = String(
          progHash.settings_recoordination_applied_version ||
          (state as any).settings_recoordination_applied_version ||
          "",
        )
        const settingsSynchronized =
          !settingsRequestedVersion || settingsRequestedVersion === settingsAppliedVersion
        const historicProgressAt = Math.max(
          toEpochMs(prehistoricHash.updated_at),
          toEpochMs(prehistoricHash.last_processed_at),
          toEpochMs((state as any).prehistoric_last_processed_at),
          toEpochMs((state as any).prehistoric_bootstrap_started_at),
          toEpochMs((state as any).prehistoric_recoordination_requested_at),
          toEpochMs((state as any).prehistoric_bootstrap_failed_at),
        )
        // A complete Strategy pass over a dense 32-symbol matrix can outlive
        // one timer heartbeat while it is still making forward progress. The
        // progression hash is written at every completed indication/strategy
        // tick and is independent from the heartbeat timer, so use both
        // channels before declaring the live lifecycle stalled.
        const runtimeActivityAt = Math.max(
          toEpochMs(progHash.last_activity_at),
          toEpochMs(progHash.last_indication_tick_at),
          toEpochMs(progHash.last_strategy_tick_at),
          toEpochMs(progHash.last_realtime_tick_at),
          toEpochMs((state as any).last_indication_run),
          toEpochMs((state as any).last_strategy_run),
          toEpochMs((state as any).last_realtime_run),
          toEpochMs((state as any).last_live_positions_run),
        )
        const lastProgressAt = Math.max(historicProgressAt, runtimeActivityAt)
        const progressAgeMs = lastProgressAt > 0 ? Math.max(0, now - lastProgressAt) : null
        const historicProgressAgeMs = historicProgressAt > 0
          ? Math.max(0, now - historicProgressAt)
          : null
        const runtimeActivityAgeMs = runtimeActivityAt > 0
          ? Math.max(0, now - runtimeActivityAt)
          : null
        const signalCapacityUpdatedAt = toEpochMs(signalCapacityRaw.updated_at)
        const signalCapacityTotal = toNumber(signalCapacityRaw.total)
        const signalCapacityLimit = normalizeSignalMaxPositions(
          toNumber(signalCapacityRaw.limit) || configuredSignalPositionLimit,
        )
        const bootstrapActive = ["running", "queued", "superseding", "retry_wait"].includes(bootstrapStatus)
        const stalled =
          dashboardEnabled &&
          (
            (
              !entryProcessorsGated &&
              (heartbeatAgeMs == null || heartbeatAgeMs > HEARTBEAT_STALE_MS) &&
              (runtimeActivityAgeMs == null || runtimeActivityAgeMs > PROCESSING_STALE_MS)
            ) ||
            (
              bootstrapActive &&
              historicProgressAgeMs != null &&
              historicProgressAgeMs > PROCESSING_STALE_MS
            )
          )

        return {
          id: conn.id,
          name: conn.name || conn.id,
          exchange: conn.exchange || "unknown",
          dashboardEnabled,
          symbols,
          // Prefer live progression hash (updated every cycle) over engineState (every 50-100 cycles)
          indicationCycles:
            progressionCounter("indication_cycle_count") ||
            toNumber((state as any).indication_cycle_count) ||
            toNumber((progression as any).cyclesCompleted),
          strategyCycles:
            progressionCounter("strategy_cycle_count") ||
            toNumber((state as any).strategy_cycle_count) ||
            toNumber((progression as any).successfulCycles),
          realtimeCycles:
            progressionCounter("realtime_cycle_count") ||
            toNumber((state as any).realtime_cycle_count),
          strategiesEvaluated: toNumber((state as any).total_strategies_evaluated),
          durations: {
            indication: toNumber((state as any).indication_avg_duration_ms),
            strategy: toNumber((state as any).strategy_avg_duration_ms),
            realtime: toNumber((state as any).realtime_avg_duration_ms),
          },
          indicationsByType,
          strategyCounts,
          strategyEvaluations,
          pseudoCounts: {
            base: basePseudoCount,
            main: mainPseudoCount,
            real: realPseudoCount,
          },
          basePseudoByIndication: {
            direction: baseDirection,
            move: baseMove,
            active: baseActive,
            active_advanced: baseActiveAdvanced,
            special: baseSpecial,
            optimal: baseOptimal,
            common: baseCommon,
            signal: baseSignal,
            trend: baseTrend,
          },
          livePositions: livePositionsCount,
          signalCapacity: {
            total: signalCapacityTotal,
            long: toNumber(signalCapacityRaw.long),
            short: toNumber(signalCapacityRaw.short),
            limit: signalCapacityLimit,
            remaining: Math.max(0, signalCapacityLimit - signalCapacityTotal),
            selectionMode: String(signalCapacityRaw.selection_mode || "best_first"),
            state: String(signalCapacityRaw.state || "idle"),
            updatedAt: signalCapacityUpdatedAt > 0
              ? new Date(signalCapacityUpdatedAt).toISOString()
              : null,
            ageMs: signalCapacityUpdatedAt > 0
              ? Math.max(0, now - signalCapacityUpdatedAt)
              : null,
          },
          // Live exchange execution metrics sourced from the progression hash
          // (written by live-stage.ts). Counters only — no exchange history
          // calls. Keeps the endpoint fast even with heavy live activity.
          liveMetrics: {
            ordersPlaced: progressionCounter("live_orders_placed_count"),
            ordersFilled: progressionCounter("live_orders_filled_count"),
            ordersFailed: progressionCounter("live_orders_failed_count"),
            ordersRejected: progressionCounter("live_orders_rejected_count"),
            ordersSimulated: progressionCounter("live_orders_simulated_count"),
            positionsCreated: progressionCounter("live_positions_created_count"),
            positionsClosed: progressionCounter("live_positions_closed_count"),
            wins: progressionCounter("live_wins_count"),
            volumeUsdTotal: progressionCounter("live_volume_usd_total"),
          },
          prehistoric: {
            loaded: prehistoricLoaded,
            symbols: historicSymbolsProcessed,
            // A bounded set cardinality is used instead of a wildcard key scan.
            dataKeys: prehistoricSymbols,
            indicationResults: toNumber((state as any).config_set_indication_results),
            strategyPositions: toNumber((state as any).config_set_strategy_positions),
            candlesProcessed: toNumber((state as any).config_set_candles_processed),
            symbolsProcessed: historicSymbolsProcessed,
            symbolsTotal: historicSymbolsTotal,
            symbolsWithoutData: toNumber((state as any).config_set_symbols_without_data),
            errors: toNumber((state as any).config_set_errors),
            durationMs: toNumber((state as any).config_set_duration_ms),
            lastProcessedAt: (state as any).prehistoric_last_processed_at || null,
          },
          intervalsProcessed: processedIntervals,
          lifecycle: {
            status: dashboardEnabled
              ? stalled
                ? "stalled"
                : entryProcessorsGated
                  ? "gated"
                  : "running"
              : "disabled",
            heartbeatAt: heartbeatAt > 0 ? new Date(heartbeatAt).toISOString() : null,
            heartbeatAgeMs,
            heartbeatFresh: heartbeatAgeMs != null && heartbeatAgeMs <= HEARTBEAT_STALE_MS,
            lastProgressAt: lastProgressAt > 0 ? new Date(lastProgressAt).toISOString() : null,
            progressAgeMs,
            historicProgressAt: historicProgressAt > 0 ? new Date(historicProgressAt).toISOString() : null,
            historicProgressAgeMs,
            runtimeActivityAt: runtimeActivityAt > 0 ? new Date(runtimeActivityAt).toISOString() : null,
            runtimeActivityAgeMs,
            stalled,
            selectionEpoch: selectionEpoch || null,
            historicSelectionEpoch: historicSelectionEpoch || null,
            generationMatches,
            bootstrapStatus,
            bootstrapGeneration: toNumber((state as any).prehistoric_bootstrap_generation),
            retryAttempt: toNumber((state as any).prehistoric_bootstrap_retry_attempt),
            entryProcessorsGated,
            settingsRequestedVersion: settingsRequestedVersion || null,
            settingsAppliedVersion: settingsAppliedVersion || null,
            settingsSynchronized,
            stateSwitchVersion: String((state as any).state_switch_version || conn.state_switch_version || "") || null,
            lastError: String(
              (state as any).prehistoric_data_error ||
              progHash.settings_recoordination_last_error ||
              "",
            ) || null,
            recoordinationReason: String((state as any).prehistoric_recoordination_reason || "") || null,
          },
        }
      }),
      monitorDeadlineAt,
      "connection lifecycle",
    )

    const indicationCycles = perConnection.reduce((sum, item) => sum + item.indicationCycles, 0)
    const strategyCycles = perConnection.reduce((sum, item) => sum + item.strategyCycles, 0)
    const realtimeCycles = perConnection.reduce((sum, item) => sum + item.realtimeCycles, 0)
    const aggregatedIndications = perConnection.reduce(
      (acc, item) => {
        acc.direction += item.indicationsByType.direction || 0
        acc.move += item.indicationsByType.move || 0
        acc.active += item.indicationsByType.active || 0
        acc.active_advanced += item.indicationsByType.active_advanced || 0
        acc.special += item.indicationsByType.special || 0
        acc.optimal += item.indicationsByType.optimal || 0
        acc.auto += item.indicationsByType.auto || 0
        acc.common += item.indicationsByType.common || 0
        acc.signal += item.indicationsByType.signal || 0
        acc.trend += item.indicationsByType.trend || 0
        acc.total += item.indicationsByType.total || 0
        return acc
      },
      { direction: 0, move: 0, active: 0, active_advanced: 0, special: 0, optimal: 0, auto: 0, common: 0, signal: 0, trend: 0, total: 0 },
    )

    const aggregatedStrategyCounts = perConnection.reduce(
      (acc, item) => {
        acc.base += item.strategyCounts.base
        acc.main += item.strategyCounts.main
        acc.real += item.strategyCounts.real
        return acc
      },
      { base: 0, main: 0, real: 0 },
    )
    // Monitoring is an observation surface, never a synthetic projection.
    // Preserve the exact stage counters even when a partial/recovering run
    // temporarily violates the expected Base → Main → Real relationship.
    const normalizedStrategyHierarchy = { ...aggregatedStrategyCounts }

    const aggregatedStrategyEvaluations = perConnection.reduce(
      (acc, item) => {
        acc.base += item.strategyEvaluations.base
        acc.main += item.strategyEvaluations.main
        acc.real += item.strategyEvaluations.real
        acc.passed.base += item.strategyEvaluations.passed.base
        acc.passed.main += item.strategyEvaluations.passed.main
        acc.passed.real += item.strategyEvaluations.passed.real
        return acc
      },
      { base: 0, main: 0, real: 0, passed: { base: 0, main: 0, real: 0 } },
    )

    const aggregatedPseudo = perConnection.reduce(
      (acc, item) => {
        acc.base += item.pseudoCounts.base
        acc.main += item.pseudoCounts.main
        acc.real += item.pseudoCounts.real
        return acc
      },
      { base: 0, main: 0, real: 0 },
    )
    const normalizedPseudoHierarchy = { ...aggregatedPseudo }

    const aggregatedPrehistoric = perConnection.reduce(
      (acc, item) => {
        acc.symbols += item.prehistoric.symbols
        acc.dataKeys += item.prehistoric.dataKeys
        acc.indicationResults += item.prehistoric.indicationResults
        acc.strategyPositions += item.prehistoric.strategyPositions
        acc.candlesProcessed += item.prehistoric.candlesProcessed
        acc.symbolsProcessed += item.prehistoric.symbolsProcessed
        acc.symbolsTotal += item.prehistoric.symbolsTotal
        acc.symbolsWithoutData += item.prehistoric.symbolsWithoutData
        acc.errors += item.prehistoric.errors
        acc.durationMs += item.prehistoric.durationMs
        return acc
      },
      {
        symbols: 0,
        dataKeys: 0,
        indicationResults: 0,
        strategyPositions: 0,
        candlesProcessed: 0,
        symbolsProcessed: 0,
        symbolsTotal: 0,
        symbolsWithoutData: 0,
        errors: 0,
        durationMs: 0,
      },
    )

    const intervalsProcessed = perConnection.reduce((sum, item) => sum + item.intervalsProcessed, 0)
    const livePositions = perConnection.reduce((sum, item) => sum + item.livePositions, 0)
    const cycleDurationMs = perConnection.length
      ? Math.round(
          perConnection.reduce(
            (sum, item) => sum + Math.max(item.durations.indication, item.durations.strategy, item.durations.realtime),
            0,
          ) / perConnection.length,
        )
      : 0
    const avgCycleDuration = perConnection.length
      ? Math.round(
          perConnection.reduce(
            (sum, item) => sum + item.durations.indication + item.durations.strategy + item.durations.realtime,
            0,
          ) / Math.max(1, perConnection.length * 3),
        )
      : 0

    // Aggregate Live execution metrics across all connections (progression hash counters only).
    const aggregatedLive = perConnection.reduce(
      (acc, item) => {
        const lm = (item as any).liveMetrics || {}
        acc.ordersPlaced     += lm.ordersPlaced     || 0
        acc.ordersFilled     += lm.ordersFilled     || 0
        acc.ordersFailed     += lm.ordersFailed     || 0
        acc.ordersRejected   += lm.ordersRejected   || 0
        acc.ordersSimulated  += lm.ordersSimulated  || 0
        acc.positionsCreated += lm.positionsCreated || 0
        acc.positionsClosed  += lm.positionsClosed  || 0
        acc.wins             += lm.wins             || 0
        acc.volumeUsdTotal   += lm.volumeUsdTotal   || 0
        return acc
      },
      {
        ordersPlaced: 0, ordersFilled: 0, ordersFailed: 0, ordersRejected: 0, ordersSimulated: 0,
        positionsCreated: 0, positionsClosed: 0, wins: 0, volumeUsdTotal: 0,
      },
    )
    const liveFillRate = aggregatedLive.ordersPlaced > 0
      ? Math.round((aggregatedLive.ordersFilled / aggregatedLive.ordersPlaced) * 1000) / 10
      : 0
    const liveWinRate = aggregatedLive.positionsClosed > 0
      ? Math.round((aggregatedLive.wins / aggregatedLive.positionsClosed) * 1000) / 10
      : 0

    const basePseudoByIndication = perConnection.reduce(
      (acc, item) => {
        acc.direction += item.basePseudoByIndication.direction
        acc.move += item.basePseudoByIndication.move
        acc.active += item.basePseudoByIndication.active
        acc.active_advanced += item.basePseudoByIndication.active_advanced
        acc.special += item.basePseudoByIndication.special
        acc.optimal += item.basePseudoByIndication.optimal
        acc.common += item.basePseudoByIndication.common
        acc.signal += item.basePseudoByIndication.signal
        acc.trend += item.basePseudoByIndication.trend
        return acc
      },
      { direction: 0, move: 0, active: 0, active_advanced: 0, special: 0, optimal: 0, common: 0, signal: 0, trend: 0 },
    )

    const unifiedLogs = [...auditLogs, ...systemLogs, ...logs]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 500)
    const alerts: MonitorAlert[] = []
    const alertTimestamp = new Date().toISOString()
    const recentFailedAuditsByConnection = auditRows.reduce((counts: Map<string, number>, audit: any) => {
      const status = String(audit?.entryOrderStatus || "").toLowerCase()
      const timestamp = toEpochMs(audit?.updatedAt || audit?.createdAt)
      if (
        (status === "failed" || status === "rejected") &&
        timestamp > 0 &&
        Date.now() - timestamp <= 60 * 60 * 1000
      ) {
        const connectionId = String(audit.connectionId || "")
        if (connectionId) counts.set(connectionId, (counts.get(connectionId) || 0) + 1)
      }
      return counts
    }, new Map<string, number>())

    for (const item of perConnection) {
      const lifecycle = item.lifecycle
      if (item.dashboardEnabled && lifecycle.stalled) {
        alerts.push({
          id: `engine-stalled-${item.id}`,
          level: "critical",
          category: "Runtime",
          message: `${item.name} has no fresh processing heartbeat or historic progress.`,
          timestamp: alertTimestamp,
          connectionId: item.id,
          details: {
            heartbeatAgeMs: lifecycle.heartbeatAgeMs,
            progressAgeMs: lifecycle.progressAgeMs,
            bootstrapStatus: lifecycle.bootstrapStatus,
          },
        })
      }
      if (item.dashboardEnabled && !lifecycle.generationMatches) {
        alerts.push({
          id: `historic-generation-${item.id}`,
          level: "warning",
          category: "Historic processing",
          message: `${item.name} is discarding progress from an older symbol selection generation.`,
          timestamp: alertTimestamp,
          connectionId: item.id,
          details: {
            selectionEpoch: lifecycle.selectionEpoch,
            historicSelectionEpoch: lifecycle.historicSelectionEpoch,
          },
        })
      }
      if (item.dashboardEnabled && !lifecycle.settingsSynchronized) {
        alerts.push({
          id: `settings-pending-${item.id}`,
          level: "warning",
          category: "Settings",
          message: `${item.name} has a settings change waiting for engine acknowledgement.`,
          timestamp: alertTimestamp,
          connectionId: item.id,
          details: {
            requestedVersion: lifecycle.settingsRequestedVersion,
            appliedVersion: lifecycle.settingsAppliedVersion,
          },
        })
      }
      if (item.dashboardEnabled && lifecycle.lastError) {
        alerts.push({
          id: `historic-error-${item.id}`,
          level: "critical",
          category: "Historic processing",
          message: lifecycle.lastError,
          timestamp: alertTimestamp,
          connectionId: item.id,
          details: {
            retryAttempt: lifecycle.retryAttempt,
            bootstrapStatus: lifecycle.bootstrapStatus,
          },
        })
      } else if (item.dashboardEnabled && lifecycle.bootstrapStatus === "retry_wait") {
        alerts.push({
          id: `historic-retry-${item.id}`,
          level: "warning",
          category: "Historic processing",
          message: `${item.name} is waiting for historic retry ${lifecycle.retryAttempt}. Entry processors remain safely gated.`,
          timestamp: alertTimestamp,
          connectionId: item.id,
        })
      }
      if (item.dashboardEnabled && item.prehistoric.errors > 0) {
        alerts.push({
          id: `historic-symbol-errors-${item.id}`,
          level: "warning",
          category: "Historic processing",
          message: `${item.name} recorded ${item.prehistoric.errors} historic symbol processing error(s).`,
          timestamp: alertTimestamp,
          connectionId: item.id,
        })
      }
      if (
        item.dashboardEnabled &&
        item.signalCapacity.total >= item.signalCapacity.limit
      ) {
        alerts.push({
          id: `signal-capacity-${item.id}`,
          level: "warning",
          category: "Signal capacity",
          message:
            `${item.name} has reached the Signal position capacity ` +
            `(${item.signalCapacity.total}/${item.signalCapacity.limit} Long + Short). ` +
            "Lower-ranked candidates wait for a slot.",
          timestamp: alertTimestamp,
          connectionId: item.id,
          details: item.signalCapacity,
        })
      }
      const recentFailedOrders = recentFailedAuditsByConnection.get(item.id) || 0
      if (recentFailedOrders > 0) {
        alerts.push({
          id: `live-orders-${item.id}`,
          level: "warning",
          category: "Orders",
          message: `${item.name} has ${recentFailedOrders} failed or rejected live order attempt(s) in the last hour.`,
          timestamp: alertTimestamp,
          connectionId: item.id,
          details: item.liveMetrics,
        })
      }
    }

    const recentSystemErrors = systemLogs.filter(
      (log) =>
        log.level === "error" &&
        Date.now() - toEpochMs(log.timestamp) <= 60 * 60 * 1000,
    )
    if (recentSystemErrors.length >= 5) {
      alerts.push({
        id: "recent-system-errors",
        level: recentSystemErrors.length >= 10 ? "critical" : "warning",
        category: "System",
        message: `${recentSystemErrors.length} system errors were logged in the last hour.`,
        timestamp: alertTimestamp,
      })
    }
    if (activeConnections.length === 0) {
      alerts.push({
        id: "no-active-connections",
        level: "info",
        category: "Configuration",
        message: "No active connection is currently selected for monitoring.",
        timestamp: alertTimestamp,
      })
    }

    const sectionCounts = {
      overview: unifiedLogs.length,
      activity: unifiedLogs.filter((log) => log.level === "info" || log.level === "debug").length,
      processing: unifiedLogs.filter((log) =>
        log.type === "processing" ||
        log.type === "indication" ||
        log.type === "strategy" ||
        String(log.phase || "").includes("prehistoric"),
      ).length,
      settings: unifiedLogs.filter((log) =>
        log.type === "settings" ||
        String(log.category || "").includes("setting") ||
        String(log.phase || "").includes("recoordination"),
      ).length,
      orders: unifiedLogs.filter((log) =>
        log.category === "orders" ||
        log.type === "live" ||
        String(log.phase || "").includes("order"),
      ).length,
      warnings: unifiedLogs.filter((log) => log.level === "warn" || log.type === "warning").length + alerts.filter((alert) => alert.level === "warning").length,
      errors: unifiedLogs.filter((log) => log.level === "error" || log.type === "error").length + alerts.filter((alert) => alert.level === "critical").length,
      system: unifiedLogs.filter((log) => String(log.phase || "").startsWith("system_")).length,
    }

    const summary = {
      symbolsActive: perConnection.reduce((sum, item) => sum + item.symbols.length, 0),
      indicationCycles,
      strategyCycles,
      totalIndicationsCalculated: aggregatedIndications.total || indicationCycles,
      totalStrategiesEvaluated:
        perConnection.reduce((sum, item) => sum + item.strategiesEvaluated, 0) ||
        aggregatedStrategyCounts.main ||
        strategyCycles,
      pseudoPositions: {
        base: normalizedPseudoHierarchy.base,
        main: normalizedPseudoHierarchy.main,
        real: normalizedPseudoHierarchy.real,
        // Cascade pipeline — NOT a sum. `total` is the final-stage (Real) count;
        // Base and Main are intermediate filter stages of the SAME pseudo-positions.
        total: normalizedPseudoHierarchy.real,
      },
      // Extended stats
      prehistoricSymbols: aggregatedPrehistoric.symbols,
      prehistoricDataSize: aggregatedPrehistoric.dataKeys,
      intervalsProcessed,
      indicationsByType: aggregatedIndications,
      strategyCountsByType: normalizedStrategyHierarchy,
      strategyCountsByTypeRaw: aggregatedStrategyCounts,
      strategyEvaluatedByType: {
        base: aggregatedStrategyEvaluations.base || aggregatedStrategyCounts.base,
        main: aggregatedStrategyEvaluations.main || aggregatedStrategyCounts.main,
        real: aggregatedStrategyEvaluations.real || aggregatedStrategyCounts.real,
      },
      strategyPassedByType: aggregatedStrategyEvaluations.passed,
      pseudoPositionsByType: {
        baseByIndication: basePseudoByIndication,
      },
      pseudoPositionsRaw: {
        base: aggregatedPseudo.base,
        main: aggregatedPseudo.main,
        real: aggregatedPseudo.real,
      },
      livePositions,
      // Detailed Live execution metrics — orders, positions, fill & win rates
      liveExecution: {
        ...aggregatedLive,
        positionsOpen: Math.max(
          0,
          aggregatedLive.positionsCreated - aggregatedLive.positionsClosed +
          Math.max(0, aggregatedLive.ordersPlaced - aggregatedLive.ordersFilled)
        ),
        fillRate: liveFillRate,
        winRate: liveWinRate,
      },
      cycleDurationMs,
      realtimeCycles,
      realtimeRunningConnections: perConnection.filter((item) => item.realtimeCycles > 0).length,
      prehistoricProcessing: {
        symbolsProcessed: aggregatedPrehistoric.symbolsProcessed,
        symbolsTotal: aggregatedPrehistoric.symbolsTotal,
        symbolsWithoutData: aggregatedPrehistoric.symbolsWithoutData,
        candlesProcessed: aggregatedPrehistoric.candlesProcessed,
        indicationResults: aggregatedPrehistoric.indicationResults,
        strategyPositions: aggregatedPrehistoric.strategyPositions,
        errors: aggregatedPrehistoric.errors,
        durationMs: aggregatedPrehistoric.durationMs,
      },
      configsProcessed: perConnection.reduce((sum, item) => sum + item.prehistoric.indicationResults + item.prehistoric.strategyPositions, 0),
      // `evalsCompleted` = canonical strategies-evaluated count = Real-stage output.
      // Base and Main contain parent/derived pipeline populations; summing them
      // would mix upstream work with the final evaluated output.
      evalsCompleted: aggregatedStrategyCounts.real,
      avgCycleDuration,
      lastUpdate: new Date().toISOString(),
      errors: sectionCounts.errors,
      warnings: sectionCounts.warnings,
    }

    return NextResponse.json({
      success: true,
      logs: unifiedLogs,
      liveOrderAudits: auditRows,
      summary,
      monitoring: {
        status: alerts.some((alert) => alert.level === "critical")
          ? "critical"
          : alerts.some((alert) => alert.level === "warning")
            ? "warning"
            : "healthy",
        alerts,
        sectionCounts,
        connections: perConnection.map((item) => ({
          id: item.id,
          name: item.name,
          exchange: item.exchange,
          dashboardEnabled: item.dashboardEnabled,
          symbols: item.symbols,
          prehistoric: item.prehistoric,
          cycles: {
            indication: item.indicationCycles,
            strategy: item.strategyCycles,
            realtime: item.realtimeCycles,
          },
          signalCapacity: item.signalCapacity,
          liveMetrics: item.liveMetrics,
          lifecycle: item.lifecycle,
        })),
      },
      timestamp: new Date().toISOString(),
      activeConnections: activeConnections.map((c: any) => ({
        id: c.id,
        name: c.name,
        exchange: c.exchange,
        dashboardEnabled: isTruthy(c.is_enabled_dashboard),
      })),
    })
  } catch (error) {
    console.error("[v0] Error fetching detailed logs:", error)
    return NextResponse.json({
      success: false,
      logs: [],
      summary: null,
      error: error instanceof Error ? error.message : "Unknown error",
    })
  }
}
