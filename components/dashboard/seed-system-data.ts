/**
 * Pure mapping for the Seed 2.0 System Monitor dialog.
 *
 * Sources (existing fields only):
 *   - GET /api/monitoring/comprehensive   → system, database, trading, errors
 *   - GET /api/trade-engine/functional-overview → cycles, historic symbols,
 *     last-observed stage-basket snapshot
 *   - GET /api/engine-metrics?connectionId → realized results (ledger)
 *   - GET /api/monitoring/logs            → SystemLogger rows (`metadata`)
 * A figure whose source did not answer is null and renders as "—".
 */

type Json = Record<string, any> | null | undefined

export type SeedLogGroup = "overall" | "data" | "engine"
export type SeedLogFilter = "all" | SeedLogGroup | "errors"

export interface SeedLogEntry {
  id: string
  timestamp: string
  /** Raw SystemLogger category (api, trade_engine, connections, …). */
  category: string
  group: SeedLogGroup
  level: "info" | "warn" | "error"
  message: string
  details?: Record<string, unknown>
}

// SystemLogger categories are free-form (api, connections, trade_engine,
// trade-engine, trades, positions, toast, system, …). Map them onto the
// dialog's groups instead of expecting the group names as categories.
const ENGINE_CATEGORY = /engine|trade|position|order|strateg|indicat|signal|live|coordinat/i
const DATA_CATEGORY = /market|data|candle|historic|redis|migration|sync|ticker|symbol/i

export function seedLogGroup(category: unknown): SeedLogGroup {
  const value = String(category || "")
  if (ENGINE_CATEGORY.test(value)) return "engine"
  if (DATA_CATEGORY.test(value)) return "data"
  return "overall"
}

export function seedLogMatchesFilter(log: Pick<SeedLogEntry, "group" | "level">, filter: SeedLogFilter): boolean {
  if (filter === "all") return true
  if (filter === "errors") return log.level === "error"
  return log.group === filter
}

export function normalizeSeedLog(raw: Json, index: number): SeedLogEntry {
  const level = String(raw?.level || "info").toLowerCase()
  const metadata = raw?.metadata ?? raw?.details
  return {
    id: String(raw?.id || `log-${index}-${raw?.timestamp || ""}`),
    timestamp: String(raw?.timestamp || ""),
    category: String(raw?.category || "system"),
    group: seedLogGroup(raw?.category),
    level: level === "error" ? "error" : level === "warn" || level === "warning" ? "warn" : "info",
    message: String(raw?.message || ""),
    details: metadata && typeof metadata === "object" && Object.keys(metadata).length > 0
      ? metadata as Record<string, unknown>
      : undefined,
  }
}

export interface SeedPerformance {
  connectionId: string | null
  available: boolean
  profitFactor: number | null
  profitFactorInfinite: boolean
  winRate: number | null
  maxDrawdownUsd: number | null
  drawdownMinutes: number | null
  settledTrades: number | null
  lookbackDays: number | null
  complete: boolean
  reason: string | null
}

export interface SeedStats {
  performance: SeedPerformance
  /** Sum of the last-observed per-symbol stage rows (basket snapshot). */
  evaluationsSnapshot: number | null
  positions: { live: number | null; pending: number | null; closed: number | null }
  database: { requestsPerSec: number | null; sizeMb: number | null; keys: number | null; activeConnections: number | null }
  system: {
    cpuUsage: number | null
    memoryUsedMb: number | null
    memoryTotalMb: number | null
    uptimeSeconds: number | null
    processCount: number | null
  }
  errors: { total: number | null; lastHour: number | null; critical: number | null; warning: number | null }
  data: {
    prehistoricSymbols: number | null
    liveTradeConnections: number | null
    strategyCycles: number | null
    indicationCycles: number | null
  }
}

function value(source: Json, field: string): number | null {
  if (!source) return null
  const raw = source[field]
  if (raw === undefined || raw === null || raw === "") return null
  const numeric = Number(raw)
  return Number.isFinite(numeric) ? numeric : null
}

function megabytes(bytes: number | null): number | null {
  return bytes === null ? null : Math.round(bytes / 1024 / 1024)
}

export function buildSeedPerformance(connectionId: string | null, engineMetrics: Json): SeedPerformance {
  const performance = engineMetrics?.performance
  if (!connectionId) {
    return {
      connectionId: null,
      available: false,
      profitFactor: null,
      profitFactorInfinite: false,
      winRate: null,
      maxDrawdownUsd: null,
      drawdownMinutes: null,
      settledTrades: null,
      lookbackDays: null,
      complete: false,
      reason: "Select a connection to see its realized results",
    }
  }
  return {
    connectionId,
    available: performance?.available === true,
    profitFactor: value(performance, "profitFactor"),
    profitFactorInfinite: performance?.profitFactorInfinite === true,
    winRate: value(performance, "winRate"),
    maxDrawdownUsd: value(performance, "maxDrawdownUsd"),
    drawdownMinutes: value(performance, "maxDrawdownMinutes"),
    settledTrades: value(performance, "settledTrades"),
    lookbackDays: value(performance, "drawdownLookbackDays"),
    complete: performance?.complete === true,
    reason: performance
      ? (typeof performance.reason === "string" ? performance.reason : null)
      : "Results could not be loaded",
  }
}

export function buildSeedStats(
  monitoring: Json,
  overview: Json,
  performance: SeedPerformance,
): SeedStats {
  return {
    performance,
    evaluationsSnapshot: value(overview, "strategiesEvaluated"),
    positions: {
      live: value(monitoring?.trading, "livePositions"),
      pending: value(monitoring?.trading, "pendingPositions"),
      closed: value(monitoring?.trading, "closedPositions"),
    },
    database: {
      requestsPerSec: value(monitoring?.database, "requestsPerSecond"),
      sizeMb: value(monitoring?.database, "sizeMb"),
      keys: value(monitoring?.database, "totalKeys"),
      activeConnections: value(monitoring?.database, "activeConnections"),
    },
    system: {
      cpuUsage: value(monitoring?.system, "cpuUsage"),
      memoryUsedMb: megabytes(value(monitoring?.system, "memoryUsed")),
      memoryTotalMb: megabytes(value(monitoring?.system, "memoryTotal")),
      uptimeSeconds: value(monitoring?.system, "uptime"),
      processCount: value(monitoring?.system, "processCount"),
    },
    errors: {
      total: value(monitoring?.errors, "total"),
      lastHour: value(monitoring?.errors, "lastHour"),
      critical: value(monitoring?.errors, "critical"),
      warning: value(monitoring?.errors, "warnings"),
    },
    data: {
      prehistoricSymbols: value(overview?.prehistoricData, "symbolsProcessed"),
      liveTradeConnections: value(monitoring?.connections, "liveTrade"),
      strategyCycles: value(overview?.counts, "strategyCycles"),
      indicationCycles: value(overview?.counts, "indicationCycles"),
    },
  }
}
