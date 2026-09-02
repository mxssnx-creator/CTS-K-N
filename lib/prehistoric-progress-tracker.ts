/**
 * Durable progress tracker for the legacy per-symbol historic loader.
 *
 * Redis SET membership is authoritative: parallel symbols, retries, and a
 * restarted process cannot lose a completion or inflate the X/N display.
 */

import { publishEngineEvent } from "@/lib/engine-event-bus"
import { getRedisClient } from "@/lib/redis-db"
import { buildPrehistoricGateKeys } from "@/lib/progression-scope"
import { scanRedisSetMembers } from "@/lib/redis-scan"

export interface PrehistoricProgress {
  connectionId: string
  totalSymbols: number
  processedSymbols: number
  currentSymbol: string | null
  currentProgress: number // 0-100
  remainingSymbols: string[]
  completedSymbols: string[]
  errorSymbols: { symbol: string; error: string }[]
  totalCandles: number
  /** Correctly-spelled canonical field for new consumers. */
  totalCandlesProcessed: number
  /** @deprecated Compatibility alias for the legacy API contract. */
  totalCandesProcessed: number
  startTime: number
  estimatedTimeRemaining: number // ms
  isComplete: boolean
  dataSource: "live" | "synthetic" | "cache"
  lastUpdate: number
}

function normalizeSymbol(value: unknown): string {
  return String(value || "").trim().toUpperCase()
}

function finiteInt(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback
}

function parseLegacyList(value: unknown): string[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value
    return Array.isArray(parsed)
      ? [...new Set(parsed.map(normalizeSymbol).filter(Boolean))]
      : []
  } catch {
    return []
  }
}

function parseLegacyErrors(value: unknown): Array<{ symbol: string; error: string }> {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value
    if (!Array.isArray(parsed)) return []
    const bySymbol = new Map<string, string>()
    for (const item of parsed) {
      const symbol = normalizeSymbol(item?.symbol)
      if (symbol) bySymbol.set(symbol, String(item?.error || "Unknown error"))
    }
    return [...bySymbol.entries()].map(([symbol, error]) => ({ symbol, error }))
  } catch {
    return []
  }
}

export class PrehistoricProgressTracker {
  private connectionId: string
  private trackingKey: string

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.trackingKey = `prehistoric:progress:${connectionId}`
  }

  private key(kind: "symbols" | "processed" | "completed" | "errors" | "in_progress" | "error_details"): string {
    return `${this.trackingKey}:${kind}`
  }

  private async expireKeys(client: any): Promise<void> {
    const keys = [
      this.trackingKey,
      this.key("symbols"),
      this.key("processed"),
      this.key("completed"),
      this.key("errors"),
      this.key("in_progress"),
      this.key("error_details"),
    ]
    // Some lightweight test/local Redis adapters omit EXPIRE. Keep the
    // durable membership semantics available there instead of turning an
    // optional TTL into a failed progress update.
    await Promise.all(keys.map((key) =>
      typeof client.expire === "function"
        ? client.expire(key, 86400).catch(() => 0)
        : Promise.resolve(0),
    ))
  }

  /**
   * Initialize prehistoric progress tracking
   */
  async initialize(totalSymbols: string[]): Promise<void> {
    const now = Date.now()
    const client = getRedisClient() as any
    if (!client) return

    const symbols = [...new Set(totalSymbols.map(normalizeSymbol).filter(Boolean))]
    const doneKeys = buildPrehistoricGateKeys(this.connectionId, "main", "done")
    const firstPassKeys = buildPrehistoricGateKeys(this.connectionId, "main", "firstpass:done")
    try {
      // A new historic generation must never inherit stale success gates or
      // completed-symbol JSON left by a prior basket.
      await Promise.all([
        client.del(
          this.key("symbols"),
          this.key("processed"),
          this.key("completed"),
          this.key("errors"),
          this.key("in_progress"),
          this.key("error_details"),
        ),
        client.del(doneKeys.scoped, doneKeys.legacy, firstPassKeys.scoped, firstPassKeys.legacy),
      ])
      if (symbols.length > 0) await client.sadd(this.key("symbols"), ...symbols)
      await client.hset(this.trackingKey, {
        total_symbols: String(symbols.length),
        processed_symbols: "0",
        current_symbol: "",
        completed_symbols: "[]",
        error_symbols: "[]",
        total_candles: "0",
        total_candles_processed: "0",
        start_time: String(now),
        is_complete: "0",
        data_source: "live",
        last_update: String(now),
      })
      await this.expireKeys(client)
    } catch (err) {
      console.warn(`[v0] Failed to initialize prehistoric progress tracker: ${err}`)
    }
  }

  /**
   * Mark a symbol as currently being processed
   */
  async startSymbol(symbol: string): Promise<void> {
    const client = getRedisClient() as any
    const normalized = normalizeSymbol(symbol)
    if (!client || !normalized) return

    try {
      // Retrying a failed symbol clears only its own error; the other workers
      // and their progress remain untouched.
      await Promise.all([
        client.sadd(this.key("in_progress"), normalized),
        typeof client.srem === "function"
          ? client.srem(this.key("errors"), normalized).catch(() => 0)
          : Promise.resolve(0),
        typeof client.hdel === "function"
          ? client.hdel(this.key("error_details"), normalized).catch(() => 0)
          : Promise.resolve(0),
        client.hset(this.trackingKey, {
          current_symbol: normalized,
          is_complete: "0",
          last_update: String(Date.now()),
        }),
      ])
      await this.expireKeys(client)
    } catch (err) {
      console.warn(`[v0] Failed to update current symbol: ${err}`)
    }
  }

  /**
   * Mark a symbol as completed with candle count
   */
  async completeSymbol(symbol: string, candleCount: number): Promise<void> {
    const client = getRedisClient() as any
    const normalized = normalizeSymbol(symbol)
    if (!client || !normalized) return

    try {
      const added = Number(await client.sadd(this.key("completed"), normalized)) || 0
      await Promise.all([
        client.sadd(this.key("processed"), normalized),
        typeof client.srem === "function"
          ? client.srem(this.key("errors"), normalized).catch(() => 0)
          : Promise.resolve(0),
        typeof client.srem === "function"
          ? client.srem(this.key("in_progress"), normalized).catch(() => 0)
          : Promise.resolve(0),
        typeof client.hdel === "function"
          ? client.hdel(this.key("error_details"), normalized).catch(() => 0)
          : Promise.resolve(0),
        added > 0 && finiteInt(candleCount) > 0
          ? client.hincrby(this.trackingKey, "total_candles", finiteInt(candleCount))
          : Promise.resolve(0),
      ])
      const [processed, completed, errors] = await Promise.all([
        client.scard(this.key("processed")),
        scanRedisSetMembers(client, this.key("completed"), { count: 250 }),
        scanRedisSetMembers(client, this.key("errors"), { count: 250 }),
      ])
      await client.hset(this.trackingKey, {
        processed_symbols: String(processed || 0),
        completed_symbols: JSON.stringify((completed || []).map(normalizeSymbol).filter(Boolean)),
        error_symbols: JSON.stringify((errors || []).map((value: unknown) => ({ symbol: normalizeSymbol(value), error: "Unknown error" }))),
        current_symbol: "",
        is_complete: "0",
        last_update: String(Date.now()),
      })
      await this.expireKeys(client)
    } catch (err) {
      console.warn(`[v0] Failed to complete symbol: ${err}`)
    }
  }

  /**
   * Mark a symbol as errored
   */
  async errorSymbol(symbol: string, error: string): Promise<void> {
    const client = getRedisClient() as any
    const normalized = normalizeSymbol(symbol)
    if (!client || !normalized) return

    try {
      await Promise.all([
        client.sadd(this.key("processed"), normalized),
        client.sadd(this.key("errors"), normalized),
        typeof client.srem === "function"
          ? client.srem(this.key("in_progress"), normalized).catch(() => 0)
          : Promise.resolve(0),
        client.hset(this.key("error_details"), { [normalized]: String(error || "Unknown error") }),
      ])
      const [processed, errors] = await Promise.all([
        client.scard(this.key("processed")),
        scanRedisSetMembers(client, this.key("errors"), { count: 250 }),
      ])
      const details = await client.hgetall(this.key("error_details")).catch(() => ({} as Record<string, string>))
      const errorRows = (errors || [])
        .map(normalizeSymbol)
        .filter(Boolean)
        .map((item: string) => ({ symbol: item, error: String(details?.[item] || "Unknown error") }))
      await client.hset(this.trackingKey, {
        processed_symbols: String(processed || 0),
        error_symbols: JSON.stringify(errorRows),
        current_symbol: "",
        is_complete: "0",
        last_update: String(Date.now()),
      })
      await this.expireKeys(client)
    } catch (err) {
      console.warn(`[v0] Failed to record symbol error: ${err}`)
    }
  }

  /**
   * Publish the realtime gate only when every selected symbol succeeded.
   * Terminal errors remain visible at 100% progress but never become a false
   * historic-complete marker. A retry replaces only the affected error.
   */
  async markComplete(dataSource: "live" | "synthetic" | "cache" = "live"): Promise<boolean> {
    const now = Date.now()
    const client = getRedisClient() as any
    if (!client) return false

    const doneKeys = buildPrehistoricGateKeys(this.connectionId, "main", "done")
    const firstPassKeys = buildPrehistoricGateKeys(this.connectionId, "main", "firstpass:done")
    try {
      const [state, completed, errors] = await Promise.all([
        client.hgetall(this.trackingKey),
        scanRedisSetMembers(client, this.key("completed"), { count: 250 }),
        scanRedisSetMembers(client, this.key("errors"), { count: 250 }),
      ])
      const total = finiteInt(state?.total_symbols)
      const completedCount = new Set((completed || []).map(normalizeSymbol).filter(Boolean)).size
      const errorCount = new Set((errors || []).map(normalizeSymbol).filter(Boolean)).size
      const ready = total > 0 && completedCount >= total && errorCount === 0

      await client.hset(this.trackingKey, {
        is_complete: ready ? "1" : "0",
        current_symbol: "",
        data_source: dataSource,
        completion_block_reason: ready ? "" : errorCount > 0
          ? `${errorCount} historic symbol error${errorCount === 1 ? "" : "s"}`
          : `coverage ${completedCount}/${total}`,
        last_update: String(now),
      })
      if (ready) {
        await Promise.all([
          client.set(doneKeys.scoped, "1", { EX: 86400 }),
          client.set(doneKeys.legacy, "1", { EX: 86400 }),
        ])
      } else {
        await client.del(doneKeys.scoped, doneKeys.legacy, firstPassKeys.scoped, firstPassKeys.legacy)
      }
      await this.expireKeys(client)
      await publishEngineEvent("progression.stage.completed", {
        connectionId: this.connectionId,
        stage: "prehistoric_data",
        successful: ready,
        timestamp: new Date(now).toISOString(),
      }).catch(() => undefined)
      if (ready && process.env.NODE_ENV !== "test" && !process.env.JEST_WORKER_ID) {
        console.log(`[v0] Prehistoric complete for ${this.connectionId} at ${new Date(now).toISOString()}`)
      }
      return ready
    } catch (err) {
      // A partial completion write must fail closed. Event-driven engine work
      // will retry on the next durable state transition; no delay loop blocks
      // the control plane here.
      await Promise.allSettled([
        client.del(doneKeys.scoped, doneKeys.legacy, firstPassKeys.scoped, firstPassKeys.legacy),
        client.hset(this.trackingKey, {
          is_complete: "0",
          completion_block_reason: "durable completion write failed",
          last_update: String(now),
        }),
      ])
      console.error(`[v0] Failed to mark prehistoric complete: ${err}`)
      return false
    }
  }

  /**
   * Get current progress (non-blocking)
   */
  async getProgress(): Promise<PrehistoricProgress> {
    const client = getRedisClient() as any
    const now = Date.now()

    const defaultProgress: PrehistoricProgress = {
      connectionId: this.connectionId,
      totalSymbols: 0,
      processedSymbols: 0,
      currentSymbol: null,
      currentProgress: 0,
      remainingSymbols: [],
      completedSymbols: [],
      errorSymbols: [],
      totalCandles: 0,
      totalCandlesProcessed: 0,
      totalCandesProcessed: 0,
      startTime: now,
      estimatedTimeRemaining: 0,
      isComplete: false,
      dataSource: "live",
      lastUpdate: now,
    }

    if (!client) return defaultProgress

    try {
      const snapshot = await Promise.race([
        Promise.all([
          client.hgetall(this.trackingKey),
          scanRedisSetMembers(client, this.key("symbols"), { count: 250 }),
          scanRedisSetMembers(client, this.key("processed"), { count: 250 }),
          scanRedisSetMembers(client, this.key("completed"), { count: 250 }),
          scanRedisSetMembers(client, this.key("errors"), { count: 250 }),
          scanRedisSetMembers(client, this.key("in_progress"), { count: 250 }),
          client.hgetall(this.key("error_details")),
        ]),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
      ]) as [Record<string, string>, string[], string[], string[], string[], string[], Record<string, string>] | null
      if (!snapshot) return defaultProgress
      const [state, knownRaw, processedRaw, completedRaw, errorsRaw, inProgressRaw, details] = snapshot
      if (!state || Object.keys(state).length === 0) return defaultProgress

      const known = [...new Set((knownRaw || []).map(normalizeSymbol).filter(Boolean))]
      const completed = [...new Set((completedRaw || []).map(normalizeSymbol).filter(Boolean))]
      const resolvedCompleted = completed.length > 0 ? completed : parseLegacyList(state.completed_symbols)
      const errors = [...new Set((errorsRaw || []).map(normalizeSymbol).filter(Boolean))]
      const errorRows = errors.length > 0
        ? errors.map((symbol) => ({ symbol, error: String(details?.[symbol] || "Unknown error") }))
        : parseLegacyErrors(state.error_symbols)
      const processed = new Set([
        ...(processedRaw || []).map(normalizeSymbol).filter(Boolean),
        ...resolvedCompleted,
        ...errorRows.map((row) => row.symbol),
      ])
      const total = finiteInt(state.total_symbols, known.length)
      const boundedProcessed = total > 0 ? Math.min(processed.size, total) : processed.size
      const totalCandles = finiteInt(state.total_candles)
      const startTime = finiteInt(state.start_time, now)
      const remainingSymbols = known.filter((symbol) => !processed.has(symbol))
      const currentSymbols = (inProgressRaw || []).map(normalizeSymbol).filter(Boolean)
      const elapsed = Math.max(0, now - startTime)
      const estimatedPerSymbol = elapsed / Math.max(boundedProcessed, 1)
      const isComplete = state.is_complete === "1" && errorRows.length === 0 && total > 0 && resolvedCompleted.length >= total

      return {
        connectionId: this.connectionId,
        totalSymbols: total,
        processedSymbols: boundedProcessed,
        currentSymbol: currentSymbols[0] || normalizeSymbol(state.current_symbol) || null,
        currentProgress: total > 0 ? Math.min(100, Math.round((boundedProcessed / total) * 100)) : 0,
        remainingSymbols,
        completedSymbols: resolvedCompleted,
        errorSymbols: errorRows,
        totalCandles,
        totalCandlesProcessed: totalCandles,
        totalCandesProcessed: totalCandles,
        startTime,
        estimatedTimeRemaining: Math.round(Math.max(0, remainingSymbols.length * estimatedPerSymbol)),
        isComplete,
        dataSource: (state.data_source as "live" | "synthetic" | "cache") || "live",
        lastUpdate: finiteInt(state.last_update, now),
      }
    } catch (err) {
      console.warn(`[v0] Error fetching prehistoric progress: ${err}`)
      return defaultProgress
    }
  }
}

/**
 * Get or create singleton tracker for a connection
 */
const trackers = new Map<string, PrehistoricProgressTracker>()

export function getPrehistoricProgressTracker(connectionId: string): PrehistoricProgressTracker {
  if (!trackers.has(connectionId)) {
    trackers.set(connectionId, new PrehistoricProgressTracker(connectionId))
  }
  return trackers.get(connectionId)!
}
