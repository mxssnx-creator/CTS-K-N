/**
 * Independent Strategy Sets Processor
 * Evaluates every indication for every strategy calculation type.
 * Stored histories remain compactable, but current-cycle candidates are
 * never sampled or capped.
 */

import { getRedisClient, initRedis, getSettings, setSettings } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { emitStrategyUpdate } from "@/lib/broadcast-helpers"
import {
  normalizeTradeDirection,
  resolveConsistentTradeDirection,
} from "@/lib/trade-direction"
import {
  compact,
  loadCompactionConfig,
  type CompactionConfig,
  type SetCompactionType,
} from "@/lib/sets-compaction"
import { scaleMainTradePfCoordinate } from "@/lib/main-trade-profit-factor"

// Pre-cached client reference
let cachedClient: any = null
async function getCachedClient() {
  if (!cachedClient) {
    await initRedis()
    cachedClient = getRedisClient()
  }
  return cachedClient
}

// Per-setKey serialize lock. `saveBatchToSet` performs a read-modify-write
// (GET the set, push entries, SET it back). When two cycles for the same
// (connectionId, symbol, type, direction) overlap, the later SET overwrites the earlier
// batch and qualifying entries are silently lost. Serializing per setKey makes
// the RMW atomic with respect to other saves for that key.
const _setSaveLocks = new Map<string, Promise<void>>()
async function withSetKeyLock(setKey: string, fn: () => Promise<void>): Promise<void> {
  const prev = _setSaveLocks.get(setKey) ?? Promise.resolve()
  const next = prev
    .catch(() => {})
    .then(fn)
    .finally(() => {
      if (_setSaveLocks.get(setKey) === next) _setSaveLocks.delete(setKey)
    })
  _setSaveLocks.set(setKey, next)
  await next
}

// These are storage-retention floors only. They do not limit calculations.
const DEFAULT_LIMITS = {
  base: 900,
  main: 300,
  real: 120,
  live: 500,
}

export interface StrategySetLimits {
  base: number
  main: number
  real: number
  live: number
}

type StrategySetType = keyof StrategySetLimits
type StrategyDirection = "long" | "short"
type StrategyBatchEntry = {
  strategy: any
  indicationType: string
  sourceSetKey?: string
}

const STRATEGY_SET_TYPES: StrategySetType[] = ["base", "main", "real", "live"]
const STRATEGY_DIRECTIONS: StrategyDirection[] = ["long", "short"]

function canonicalStrategySymbol(symbol: unknown): string | null {
  const normalized = String(symbol ?? "").trim().toUpperCase()
  return normalized || null
}

function resolveStrategyDirection(indication: any): StrategyDirection | null {
  return resolveConsistentTradeDirection(
    indication?.direction,
    indication?.metadata?.direction,
    indication?.side,
    indication?.metadata?.side,
  )
}

export interface StrategySet {
  type: "base" | "main" | "real" | "live"
  connectionId: string
  symbol: string
  entries: Array<{
    id: string
    timestamp: Date
    profitFactor: number
    confidence: number
    config: any
    metadata: any
  }>
  maxEntries: number // Configurable per type, default 500
  stats: {
    totalCalculated: number
    totalQualified: number
    avgProfitFactor: number
    lastCalculated: Date | null
  }
}

export class StrategySetsProcessor {
  private connectionId: string
  private limits: StrategySetLimits = { ...DEFAULT_LIMITS }
  private explicitLimitOverrides: Partial<Record<keyof StrategySetLimits, boolean>> = {}
  private settingsReady: Promise<void>
  /**
   * Per-type compaction config cache. Refreshed lazily by the underlying
   * `loadCompactionConfig` helper (5s TTL). Strategy pools use the
   * "best" compaction mode — when the buffer overflows we keep the
   * highest-PF entries, not the most recent ones, because what
   * downstream Real/Live look up is "the best signals available", not
   * "the most recent ones".
   */

  /**
   * Resolve the compaction config for a strategy pool, with the legacy
   * per-type limit (`getLimit()`) as the floor when no operator-level
   * override exists. Mirrors the indication-sets processor for
   * uniformity.
   */
  private async resolveCompaction(
    type: keyof StrategySetLimits,
  ): Promise<CompactionConfig> {
    const ckey = `strategy.${type}` as SetCompactionType
    // Do NOT cache on the processor instance (see indication-sets-processor):
    // `loadCompactionConfig` already keeps a 5s module-level cache, so an
    // unbounded instance cache here only defeats that refresh and ignores
    // operator Set-Compaction changes for the processor's lifetime.
    const cfg = await loadCompactionConfig(ckey)
    const legacyLimit = this.getLimit(type)
    // The user may have customised the legacy `strategy_sets_config`
    // floor (e.g. base=900). Prefer that when no operator-level
    // Set-Compaction override is set — detected by the resolved floor
    // being the hard-coded 250 default.
    const finalCfg: CompactionConfig =
      this.explicitLimitOverrides[type] || (cfg.floor === 250 && legacyLimit > 250)
        ? { floor: legacyLimit, thresholdPct: cfg.thresholdPct }
        : cfg
    return finalCfg
  }

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.settingsReady = this.loadSettings()
  }

  private async loadSettings(): Promise<void> {
    try {
      const settings = await getSettings("strategy_sets_config")
      if (settings) {
        // Load independent limits per type
        if (settings.base) { this.limits.base = Number(settings.base); this.explicitLimitOverrides.base = true }
        if (settings.main) { this.limits.main = Number(settings.main); this.explicitLimitOverrides.main = true }
        if (settings.real) { this.limits.real = Number(settings.real); this.explicitLimitOverrides.real = true }
        if (settings.live) { this.limits.live = Number(settings.live); this.explicitLimitOverrides.live = true }
        // Fallback: legacy maxEntriesPerSet applies weighted by type.
        if (settings.maxEntriesPerSet && !settings.base) {
          const limit = Number(settings.maxEntriesPerSet)
          this.limits = {
            base: Math.max(300, Math.round(limit * 1.8)),
            main: Math.max(120, Math.round(limit * 0.8)),
            real: Math.max(60, Math.round(limit * 0.35)),
            live: Math.max(120, limit),
          }
        }
      }
    } catch (error) {
      console.error("[v0] [StrategySets] Failed to load settings:", error)
    }
  }

  /** Get the limit for a specific strategy type */
  getLimit(type: keyof StrategySetLimits): number {
    return this.limits[type] || DEFAULT_LIMITS[type] || 500
  }


  /**
   * Process every strategy type independently for a symbol AND direction.
   * Unknown directions fail closed: they are counted as rejected input and
   * never leak into a Long bucket.
   */
  async processAllStrategySets(symbol: string, indications: any[]): Promise<void> {
    try {
      const startTime = Date.now()
      await this.settingsReady

      const canonicalSymbol = canonicalStrategySymbol(symbol)
      if (!canonicalSymbol) {
        throw new Error("Strategy Set processing requires a non-empty symbol/market")
      }

      const rawTotal = indications.length
      let selectedTotal = 0
      let rejectedDirectionTotal = 0
      const batches: Record<StrategySetType, Record<StrategyDirection, StrategyBatchEntry[]>> = {
        base: { long: [], short: [] },
        main: { long: [], short: [] },
        real: { long: [], short: [] },
        live: { long: [], short: [] },
      }

      // Classify the complete indication inventory in one CPU pass. The four
      // result rows remain independently configured/stored, while Redis writes
      // run concurrently after classification. No candidate is sampled.
      for (const indication of indications) {
        const direction = resolveStrategyDirection(indication)
        if (!direction) {
          rejectedDirectionTotal++
          continue
        }
        selectedTotal++
        const confidence = Number(indication.confidence) || 0
        const profitFactor = Number(indication.profitFactor) || 0
        const indicationType = String(indication.type || "unknown")
        const sourceSetKey = indication?.setKey ? String(indication.setKey) : undefined
        const strategyMetadata = (strategyType: StrategySetType, riskLevel: string) => ({
          ...indication.metadata,
          connectionId: this.connectionId,
          symbol: canonicalSymbol,
          direction,
          strategyType,
          riskLevel,
          ...(sourceSetKey && { sourceSetKey }),
        })
        const conservativeCoordinate = scaleMainTradePfCoordinate(profitFactor, 0.95)
        if (confidence > 0.45 && profitFactor > 0.9 && conservativeCoordinate >= 1) {
          batches.base[direction].push({
            strategy: {
              profitFactor: conservativeCoordinate,
              confidence,
              metadata: strategyMetadata("base", "low"),
            },
            indicationType,
            sourceSetKey,
          })
        }
        if (confidence > 0.62 && profitFactor > 1.2) {
          batches.main[direction].push({
            strategy: {
              profitFactor,
              confidence,
              metadata: strategyMetadata("main", "medium"),
            },
            indicationType,
            sourceSetKey,
          })
        }
        if (confidence > 0.78 && profitFactor > 1.45) {
          batches.real[direction].push({
            strategy: {
              profitFactor: scaleMainTradePfCoordinate(profitFactor, 1.1),
              confidence,
              metadata: strategyMetadata("real", "high"),
            },
            indicationType,
            sourceSetKey,
          })
        }
        if (profitFactor >= 1) {
          batches.live[direction].push({
            strategy: {
              profitFactor,
              confidence,
              metadata: strategyMetadata("live", "variable"),
            },
            indicationType,
            sourceSetKey,
          })
        }
      }

      await Promise.all(
        STRATEGY_SET_TYPES.flatMap((type) =>
          STRATEGY_DIRECTIONS.map((direction) =>
            this.saveBatchToSet(
              `strategy_set:${this.connectionId}:${canonicalSymbol}:${type}:${direction}`,
              batches[type][direction],
              type,
              canonicalSymbol,
              direction,
            ),
          ),
        ),
      )
      const resultFor = (type: StrategySetType) => this.toStageResult(
        type,
        rawTotal,
        selectedTotal,
        batches[type].long.length + batches[type].short.length,
        {
          long: batches[type].long.length,
          short: batches[type].short.length,
        },
      )
      const baseResults = resultFor("base")
      const mainResults = resultFor("main")
      const realResults = resultFor("real")
      const liveResults = resultFor("live")

      const duration = Date.now() - startTime
      const totalQualified =
        (baseResults?.qualified || 0) +
        (mainResults?.qualified || 0) +
        (realResults?.qualified || 0) +
        (liveResults?.qualified || 0)

      if (totalQualified > 0) {
        console.log(
          `[v0] [StrategySets] ${canonicalSymbol}: ${selectedTotal}/${rawTotal} directional indications evaluated in ${duration}ms | Total qualified=${totalQualified} | Long=${baseResults.byDirection.long + mainResults.byDirection.long + realResults.byDirection.long + liveResults.byDirection.long} Short=${baseResults.byDirection.short + mainResults.byDirection.short + realResults.byDirection.short + liveResults.byDirection.short}`
        )

        await logProgressionEvent(this.connectionId, "strategies_sets", "info", `All strategy types evaluated for ${canonicalSymbol}`, {
          symbol: canonicalSymbol,
          selectedTotal,
          rejectedDirectionTotal,
          totalQualified,
          base: baseResults,
          main: mainResults,
          real: realResults,
          live: liveResults,
          duration,
        })
      }
    } catch (error) {
      console.error(`[v0] [StrategySets] Failed to process sets for ${symbol}:`, error)
    }
  }

  /**
   * Base Strategy Set - Conservative, low-risk signals only
   */
  private toStageResult(
    type: "base" | "main" | "real" | "live",
    rawTotal: number,
    selectedTotal: number,
    qualified: number,
    byDirection: Record<StrategyDirection, number>,
  ): any {
    return { type, rawTotal, selectedTotal, qualified, byDirection }
  }

  /**
   * Batch-save multiple qualifying strategies to the same set pool in
   * ONE read-merge-compact-write transaction.
   *
   * The original `saveStrategyToSet` was called once per qualifying
   * indication in a sequential loop, paying the read-modify-write cost
   * per entry. With ~hundreds of qualifying indications per symbol
   * that was the dominant CPU + Redis cost of the strategy-sets stage.
   *
   * Parallelising the individual `saveStrategyToSet` calls would
   * RACE because they all read-modify-write the SAME `setKey`. This
   * batch path avoids the race AND collapses the I/O.
   */
  private async saveBatchToSet(
    setKey: string,
    strategies: StrategyBatchEntry[],
    strategyType: StrategySetType,
    symbol: string,
    direction: StrategyDirection,
  ): Promise<void> {
    if (strategies.length === 0) return
    // Serialize per setKey so overlapping cycles cannot clobber each other's
    // read-modify-write of the same set. See `withSetKeyLock`.
    await withSetKeyLock(setKey, async () => {
      try {
        const client = await getCachedClient()
        let entries: any[] = []
        const existing = await client.get(setKey)
        if (existing) {
          try { entries = JSON.parse(existing) } catch { entries = [] }
        }

        const baseTs = Date.now()
        for (let i = 0; i < strategies.length; i++) {
          const { strategy, indicationType, sourceSetKey } = strategies[i]
          entries.push({
            id: `${strategyType}_${direction}_${baseTs}_${i}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: new Date().toISOString(),
            connectionId: this.connectionId,
            symbol,
            direction,
            profitFactor: strategy.profitFactor,
            confidence: strategy.confidence,
            indicationType,
            strategyType,
            ...(sourceSetKey && { sourceSetKey }),
            metadata: strategy.metadata,
          })
        }

        const cfg = await this.resolveCompaction(strategyType as keyof StrategySetLimits)
        entries = compact(entries, cfg, "best")

        // Pipeline the writes — the set value and its stats are
        // independent keys so they can flow concurrently.
        const statsKey = `${setKey}:stats`
        const [_, prevStatsRaw] = await Promise.all([
          client.set(setKey, JSON.stringify(entries)),
          getSettings(statsKey),
        ])
        const prevStats = prevStatsRaw || {}
        const stats = {
          connectionId: this.connectionId,
          symbol,
          direction,
          strategyType,
          maxEntries: cfg.floor,
          currentEntries: entries.length,
          totalCalculated: (prevStats.totalCalculated || 0) + strategies.length,
          totalQualified: (prevStats.totalQualified || 0) + strategies.length,
          avgProfitFactor:
            entries.length > 0
              ? entries.reduce((sum: number, e: any) => sum + e.profitFactor, 0) / entries.length
              : 0,
          lastCalculated: new Date().toISOString(),
        }
        await setSettings(statsKey, stats)

        // Single broadcast per batch — dashboard observers debounce
        // their own re-fetches so emitting N times per cycle would just
        // flood without value.
        if (entries.length > 0) {
          emitStrategyUpdate(this.connectionId, {
            id: entries[0].id,
            symbol,
            direction,
            profit_factor: stats.avgProfitFactor || 0,
            win_rate: strategies[0].strategy?.confidence || 0,
            active_positions: entries.length,
          })
        }
      } catch (error) {
        console.error(`[v0] [StrategySets] Failed to batch-save ${strategies.length} entries to ${setKey}:`, error)
      }
    })
  }

  /**
   * Get direction-specific stats, or aggregate both independent directional
   * lanes when no direction is requested. Legacy directionless data is read
   * only as an upgrade fallback and is never mixed into a directional lane.
   */
  async getSetStats(symbol: string, type: string, direction?: string): Promise<any> {
    try {
      const canonicalSymbol = canonicalStrategySymbol(symbol)
      if (!canonicalSymbol) return null
      if (direction !== undefined) {
        const canonicalDirection = normalizeTradeDirection(direction)
        if (!canonicalDirection) return null
        return await getSettings(
          `strategy_set:${this.connectionId}:${canonicalSymbol}:${type}:${canonicalDirection}:stats`,
        )
      }

      const [long, short] = await Promise.all(STRATEGY_DIRECTIONS.map((dir) =>
        getSettings(`strategy_set:${this.connectionId}:${canonicalSymbol}:${type}:${dir}:stats`),
      ))
      if (!long && !short) {
        return await getSettings(`strategy_set:${this.connectionId}:${canonicalSymbol}:${type}:stats`)
      }
      const rows = [long, short].filter(Boolean)
      const currentEntries = rows.reduce((sum, row) => sum + Number(row.currentEntries || 0), 0)
      const weightedProfit = rows.reduce(
        (sum, row) => sum + Number(row.avgProfitFactor || 0) * Number(row.currentEntries || 0),
        0,
      )
      return {
        connectionId: this.connectionId,
        symbol: canonicalSymbol,
        direction: "all",
        strategyType: type,
        maxEntries: rows.reduce((sum, row) => sum + Number(row.maxEntries || 0), 0),
        currentEntries,
        totalCalculated: rows.reduce((sum, row) => sum + Number(row.totalCalculated || 0), 0),
        totalQualified: rows.reduce((sum, row) => sum + Number(row.totalQualified || 0), 0),
        avgProfitFactor: currentEntries > 0 ? weightedProfit / currentEntries : 0,
        lastCalculated: rows.map((row) => row.lastCalculated).filter(Boolean).sort().at(-1) || null,
        byDirection: { long, short },
      }
    } catch (error) {
      console.error(`[v0] [StrategySets] Failed to get stats for ${type}:`, error)
      return null
    }
  }

  /**
   * Get all entries from a specific strategy type set
   */
  async getSetEntries(symbol: string, type: string, limit = 50, direction?: string): Promise<any[]> {
    try {
      const client = await getCachedClient()
      const canonicalSymbol = canonicalStrategySymbol(symbol)
      if (!canonicalSymbol) return []
      const requestedDirection = direction === undefined ? null : normalizeTradeDirection(direction)
      if (direction !== undefined && !requestedDirection) return []
      const keys = requestedDirection
        ? [`strategy_set:${this.connectionId}:${canonicalSymbol}:${type}:${requestedDirection}`]
        : STRATEGY_DIRECTIONS.map((dir) =>
            `strategy_set:${this.connectionId}:${canonicalSymbol}:${type}:${dir}`,
          )
      const data = await Promise.all(keys.map((key) => client.get(key)))
      let entries: any[] = data.flatMap((raw) => {
        if (!raw) return []
        try {
          const parsed = JSON.parse(raw)
          return Array.isArray(parsed) ? parsed : []
        } catch {
          return []
        }
      })
      if (direction === undefined && entries.length === 0) {
        const legacy = await client.get(`strategy_set:${this.connectionId}:${canonicalSymbol}:${type}`)
        if (legacy) {
          try {
            const parsed = JSON.parse(legacy)
            entries = Array.isArray(parsed) ? parsed : []
          } catch { /* malformed legacy pool */ }
        }
      }
      // Always return in best-performance-first order
      entries.sort((a: any, b: any) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0))
      return entries.slice(0, limit)
    } catch (error) {
      console.error(`[v0] [StrategySets] Failed to get entries for ${type}:`, error)
      return []
    }
  }
}
