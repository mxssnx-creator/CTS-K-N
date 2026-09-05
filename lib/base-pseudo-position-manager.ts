/**
 * Base pseudo-position Set registry.
 *
 * Every complete `(connection, symbol, indication type + configuration,
 * direction)` tuple owns one independent Base Set. The registry is a directly
 * indexed Redis hash, so admitting or updating one configuration never reads
 * or rewrites the complete (potentially very large) Cartesian Set list.
 *
 * Legacy `base_positions:{connection}` arrays are migrated lazily once and
 * remain readable for rollback. Status (`failed` / `paused`) is diagnostic;
 * it never permanently suppresses Base enumeration. Open-position uniqueness
 * and the three-second post-close cooldown are enforced by
 * `PseudoPositionManager` on the same exact lane identity.
 */

import { getSettings, getRedisClient, setSettings } from "@/lib/redis-db"
import type { PerformanceThresholds } from "./types"
import { logProgressionEvent } from "./engine-progression-logs"
import {
  DEFAULT_MAX_STOP_LOSS_RATIO,
  normalizeMaxStopLossRatio,
} from "@/lib/stoploss-ratio-range"

export type BaseIndicationType =
  | "direction"
  | "move"
  | "active"
  | "optimal"
  | "active_advanced"
  | "signal"
  | "trend" | "break"
  | "common"

export interface BasePositionConfig {
  symbol: string
  indicationType: BaseIndicationType
  /** Exact indicator/source name inside a broad type such as Common. */
  indicationName?: string
  /** Canonical full upstream configuration/Set identity when available. */
  configSetKey?: string
  range: number
  direction: "long" | "short"
  tpFactor: number
  slRatio: number
  trailingEnabled: boolean
  trailStart: number | null
  trailStop: number | null
  drawdownRatio?: number
  marketChangeRange?: number
  lastPartRatio?: number
  activeSituationRatio?: number
}

type BasePositionRecord = {
  id: string
  connection_id: string
  symbol: string
  indication_type: BaseIndicationType
  indication_name?: string
  indication_range: number
  direction: "long" | "short"
  takeprofit_factor: number
  stoploss_ratio: number
  trailing_enabled: boolean
  trail_start: number | null
  trail_stop: number | null
  drawdown_ratio: number | null
  market_change_range: number | null
  last_part_ratio: number | null
  active_situation_ratio: number | null
  config_key: string
  status: "evaluating" | "active" | "paused" | "failed" | "open"
  evaluation_count: number
  total_positions: number
  winning_positions: number
  losing_positions: number
  total_profit_loss: number
  gross_profit: number
  gross_loss: number
  max_drawdown: number
  win_rate: number
  avg_profit: number
  avg_loss: number
  created_at: string
  updated_at: string
}

// Serialises mutations across manager instances in this process. Redis hash
// fields use the exact config key, so independent server processes remain
// idempotent as well.
const BASE_POSITION_MUTATION_QUEUES = new Map<string, Promise<unknown>>()

async function queueBasePositionMutation<T>(
  connectionId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = BASE_POSITION_MUTATION_QUEUES.get(connectionId) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(mutation)
  BASE_POSITION_MUTATION_QUEUES.set(connectionId, operation)
  try {
    return await operation
  } finally {
    if (BASE_POSITION_MUTATION_QUEUES.get(connectionId) === operation) {
      BASE_POSITION_MUTATION_QUEUES.delete(connectionId)
    }
  }
}

function unwrapPipelineValue(value: any): any {
  if (Array.isArray(value) && value.length === 2) return value[1]
  return value
}

function parseRecord(raw: unknown): BasePositionRecord | null {
  if (!raw) return null
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw
    return value && typeof value === "object" ? value as BasePositionRecord : null
  } catch {
    return null
  }
}

export class BasePseudoPositionManager {
  private readonly connectionId: string
  private readonly thresholds: PerformanceThresholds
  // Retention limit is intentionally not an admission ceiling. Consumers may
  // use it to bound per-Set result history while lifetime aggregates continue.
  private databaseSizeLimit = 250
  private migrationReady: Promise<void> | null = null

  constructor(connectionId: string, databaseSizeLimit?: number) {
    this.connectionId = connectionId
    if (Number.isFinite(databaseSizeLimit) && Number(databaseSizeLimit) > 0) {
      this.databaseSizeLimit = Math.floor(Number(databaseSizeLimit))
    }
    this.thresholds = {
      initial_min_win_rate: 0.4,
      expanded_min_win_rate: 0.45,
      expanded_min_profit_ratio: 1.2,
      production_min_win_rate: 0.42,
      production_max_drawdown: 0.3,
      pause_threshold_win_rate: 0.38,
      resume_threshold_win_rate: 0.43,
    }
  }

  private positionsHashKey(): string {
    return `base_positions_v2:${this.connectionId}`
  }

  private idIndexHashKey(): string {
    return `base_positions_v2:${this.connectionId}:by_id`
  }

  private migrationMarkerKey(): string {
    return `base_positions_v2:${this.connectionId}:migrated`
  }

  private deterministicPositionId(configKey: string): string {
    // encodeURIComponent is one-to-one for strings and avoids probabilistic
    // hashes/collisions while producing the same ID in concurrent processes.
    return `base:${this.connectionId}:v2:${encodeURIComponent(configKey)}`
  }

  /**
   * Production Redis adapters expose hash reads/writes and a real pipeline.
   * Keep the old settings-array implementation as a small compatibility path
   * for minimal adapters (and old persisted installs) instead of treating a
   * missing optional Redis command as a failed Base admission.
   */
  private supportsHashRegistry(client: any): boolean {
    return Boolean(
      client &&
        typeof client.hget === "function" &&
        typeof client.hset === "function" &&
        typeof client.multi === "function",
    )
  }

  private legacySettingsKey(): string {
    return `base_positions:${this.connectionId}`
  }

  private async readLegacyRecords(): Promise<BasePositionRecord[]> {
    const raw = await getSettings(this.legacySettingsKey())
    return Array.isArray(raw)
      ? raw.filter((candidate): candidate is BasePositionRecord =>
          Boolean(candidate && typeof candidate === "object"),
        )
      : []
  }

  private async getOrCreateLegacyBasePositions(
    configs: BasePositionConfig[],
    maxStopLossRatio: number,
  ): Promise<Array<string | null>> {
    const records = await this.readLegacyRecords()
    const now = new Date().toISOString()
    let changed = false
    const results = configs.map((config) => {
      if (Number(config.slRatio) > maxStopLossRatio) return null
      const configKey = this.generateConfigKey(config)
      let record = records.find((candidate) => candidate.config_key === configKey)
      if (!record) {
        record = this.buildBasePositionRecord(config, configKey, now)
        records.push(record)
        changed = true
      }
      return record.id
    })
    if (changed) await setSettings(this.legacySettingsKey(), records)
    return results
  }

  private async ensureMigrated(): Promise<void> {
    if (this.migrationReady) return this.migrationReady
    this.migrationReady = (async () => {
      const client = getRedisClient()
      if (!this.supportsHashRegistry(client)) return
      if (await client.get(this.migrationMarkerKey()).catch(() => null)) return

      const lockKey = `${this.migrationMarkerKey()}:lock`
      const token = `${Date.now()}:${Math.random()}`
      const acquired = await client.set(lockKey, token, { NX: true, PX: 30_000 } as any)
        .catch(() => null)
      if (!acquired) return

      try {
        const raw = await getSettings(this.legacySettingsKey())
        const legacy = Array.isArray(raw) ? raw : []
        const pipeline = client.multi()
        for (const candidate of legacy) {
          if (!candidate || typeof candidate !== "object") continue
          const record = candidate as BasePositionRecord
          const configKey = String(record.config_key || "")
          if (!configKey) continue
          const normalized: BasePositionRecord = {
            ...record,
            id: String(record.id || this.deterministicPositionId(configKey)),
            config_key: configKey,
            gross_profit: Math.max(0, Number(record.gross_profit) || 0),
            gross_loss: Math.max(0, Number(record.gross_loss) || 0),
          }
          pipeline.hset(this.positionsHashKey(), configKey, JSON.stringify(normalized))
          pipeline.hset(this.idIndexHashKey(), normalized.id, configKey)
          pipeline.sadd(`base_pseudo:${this.connectionId}`, normalized.id)
          pipeline.sadd(
            `base_pseudo:${this.connectionId}:${normalized.indication_type}`,
            normalized.id,
          )
        }
        pipeline.set(this.migrationMarkerKey(), "1")
        await pipeline.exec()
      } finally {
        const current = await client.get(lockKey).catch(() => null)
        if (current === token) await client.del(lockKey).catch(() => 0)
      }
    })().catch((error) => {
      this.migrationReady = null
      throw error
    })
    return this.migrationReady
  }

  private async getMaxStopLossRatio(): Promise<number> {
    try {
      const settings = (await getSettings(`connection_settings:${this.connectionId}`)) || {}
      return normalizeMaxStopLossRatio(
        (settings as any).maxStopLossRatio ?? (settings as any).max_stoploss_ratio,
        DEFAULT_MAX_STOP_LOSS_RATIO,
      )
    } catch {
      return DEFAULT_MAX_STOP_LOSS_RATIO
    }
  }

  setDatabaseSizeLimit(limit: number): void {
    if (Number.isFinite(limit) && limit > 0) this.databaseSizeLimit = Math.floor(limit)
  }

  private buildBasePositionRecord(
    config: BasePositionConfig,
    configKey: string,
    now: string,
  ): BasePositionRecord {
    return {
      id: this.deterministicPositionId(configKey),
      connection_id: this.connectionId,
      symbol: config.symbol,
      indication_type: config.indicationType,
      ...(config.indicationName && { indication_name: config.indicationName }),
      indication_range: config.range,
      direction: config.direction,
      takeprofit_factor: config.tpFactor,
      stoploss_ratio: config.slRatio,
      trailing_enabled: config.trailingEnabled,
      trail_start: config.trailStart,
      trail_stop: config.trailStop,
      drawdown_ratio: config.drawdownRatio ?? null,
      market_change_range: config.marketChangeRange ?? null,
      last_part_ratio: config.lastPartRatio ?? null,
      active_situation_ratio: config.activeSituationRatio ?? null,
      config_key: configKey,
      status: "evaluating",
      evaluation_count: 0,
      total_positions: 0,
      winning_positions: 0,
      losing_positions: 0,
      total_profit_loss: 0,
      gross_profit: 0,
      gross_loss: 0,
      max_drawdown: 0,
      win_rate: 0,
      avg_profit: 0,
      avg_loss: 0,
      created_at: now,
      updated_at: now,
    }
  }

  /**
   * Resolve a complete Base grid with pipelined O(N) field reads and one
   * batched write. No slice/top-K/global cap is applied.
   */
  async getOrCreateEligibleBasePositions(
    configs: BasePositionConfig[],
  ): Promise<Array<string | null>> {
    if (configs.length === 0) return []
    return queueBasePositionMutation(this.connectionId, async () => {
      try {
        await this.ensureMigrated()
        const maxStopLossRatio = await this.getMaxStopLossRatio()
        const client = getRedisClient()
        if (!this.supportsHashRegistry(client)) {
          return this.getOrCreateLegacyBasePositions(configs, maxStopLossRatio)
        }
        const configKeys = configs.map((config) => this.generateConfigKey(config))
        const read = client.multi()
        for (const configKey of configKeys) read.hget(this.positionsHashKey(), configKey)
        const rawRows = await read.exec()
        const now = new Date().toISOString()
        const writes = client.multi()
        const created: BasePositionRecord[] = []

        const results = configs.map((config, index) => {
          if (Number(config.slRatio) > maxStopLossRatio) return null
          const configKey = configKeys[index]
          let record = parseRecord(unwrapPipelineValue(rawRows?.[index]))
          if (!record) {
            record = this.buildBasePositionRecord(config, configKey, now)
            created.push(record)
            writes.hset(this.positionsHashKey(), configKey, JSON.stringify(record))
            writes.hset(this.idIndexHashKey(), record.id, configKey)
            writes.sadd(`base_pseudo:${this.connectionId}`, record.id)
            writes.sadd(
              `base_pseudo:${this.connectionId}:${record.indication_type}`,
              record.id,
            )
          }
          // failed/paused statuses intentionally remain eligible for a later
          // independent sample; downstream promotion still uses performance.
          return record.id
        })

        if (created.length > 0) {
          await writes.exec()
          await logProgressionEvent(
            this.connectionId,
            "base_pseudo_created",
            "info",
            `Created ${created.length} independently indexed Base configuration Sets`,
            {
              createdCount: created.length,
              indicationTypes: Array.from(
                new Set(created.map((record) => record.indication_type)),
              ),
              retentionPerSet: this.databaseSizeLimit,
            },
          ).catch(() => {})
        }
        return results
      } catch (error) {
        console.error("[v0] Error preparing Base position batch:", error)
        return configs.map(() => null)
      }
    })
  }

  async getOrCreateBasePosition(
    symbol: string,
    indicationType: BaseIndicationType,
    range: number,
    direction: "long" | "short",
    tpFactor: number,
    slRatio: number,
    trailingEnabled: boolean,
    trailStart: number | null,
    trailStop: number | null,
    drawdownRatio?: number,
    marketChangeRange?: number,
    lastPartRatio?: number,
    activeSituationRatio?: number,
  ): Promise<string | null> {
    const [result] = await this.getOrCreateEligibleBasePositions([{
      symbol,
      indicationType,
      range,
      direction,
      tpFactor,
      slRatio,
      trailingEnabled,
      trailStart,
      trailStop,
      drawdownRatio,
      marketChangeRange,
      lastPartRatio,
      activeSituationRatio,
    }])
    return result ?? null
  }

  private async readById(basePositionId: string): Promise<BasePositionRecord | null> {
    await this.ensureMigrated()
    const client = getRedisClient()
    if (!this.supportsHashRegistry(client)) {
      return (await this.readLegacyRecords()).find(
        (record) => record.id === basePositionId,
      ) ?? null
    }
    const configKey = await client.hget(this.idIndexHashKey(), basePositionId).catch(() => null)
    if (!configKey) return null
    return parseRecord(
      await client.hget(this.positionsHashKey(), String(configKey)).catch(() => null),
    )
  }

  async canCreatePosition(basePositionId: string): Promise<boolean> {
    // Status is not an admission gate. A Set must keep sampling so a weak
    // historical window can recover; exact active/cooldown gates live in the
    // position manager.
    return Boolean(await this.readById(basePositionId))
  }

  async updatePerformance(
    basePositionId: string,
    profitLoss: number,
    isWin: boolean,
    currentDrawdown: number,
  ): Promise<void> {
    await queueBasePositionMutation(this.connectionId, async () => {
      try {
        const basePos = await this.readById(basePositionId)
        if (!basePos) return

        const pnl = Number.isFinite(Number(profitLoss)) ? Number(profitLoss) : 0
        const totalPositions = Number(basePos.total_positions || 0) + 1
        const winningPositions = Number(basePos.winning_positions || 0) + (isWin ? 1 : 0)
        const losingPositions = Number(basePos.losing_positions || 0) + (isWin ? 0 : 1)
        const totalProfitLoss = Number(basePos.total_profit_loss || 0) + pnl
        const grossProfit = Number(basePos.gross_profit || 0) + Math.max(0, pnl)
        const grossLoss = Number(basePos.gross_loss || 0) + Math.max(0, -pnl)
        const winRate = totalPositions > 0 ? winningPositions / totalPositions : 0
        const maxDrawdown = Math.max(
          Number(basePos.max_drawdown || 0),
          Number(currentDrawdown) || 0,
        )
        const avgProfit = winningPositions > 0 ? grossProfit / winningPositions : 0
        const avgLoss = losingPositions > 0 ? grossLoss / losingPositions : 0

        const status = this.resolveDiagnosticStatus(basePos.status, {
          totalPositions,
          winRate,
          avgProfit,
          avgLoss,
          maxDrawdown,
        })
        const updated: BasePositionRecord = {
          ...basePos,
          status,
          evaluation_count: Number(basePos.evaluation_count || 0) + 1,
          total_positions: totalPositions,
          winning_positions: winningPositions,
          losing_positions: losingPositions,
          total_profit_loss: totalProfitLoss,
          gross_profit: grossProfit,
          gross_loss: grossLoss,
          max_drawdown: maxDrawdown,
          win_rate: winRate,
          avg_profit: avgProfit,
          avg_loss: avgLoss,
          updated_at: new Date().toISOString(),
        }
        const client = getRedisClient()
        if (this.supportsHashRegistry(client)) {
          await client.hset(
            this.positionsHashKey(),
            basePos.config_key,
            JSON.stringify(updated),
          )
        } else {
          const records = await this.readLegacyRecords()
          const index = records.findIndex((record) => record.id === basePositionId)
          if (index >= 0) {
            records[index] = updated
            await setSettings(this.legacySettingsKey(), records)
          }
        }
      } catch (error) {
        console.error("[v0] Error updating Base position performance:", error)
      }
    })
  }

  private resolveDiagnosticStatus(
    current: BasePositionRecord["status"],
    metrics: {
      totalPositions: number
      winRate: number
      avgProfit: number
      avgLoss: number
      maxDrawdown: number
    },
  ): BasePositionRecord["status"] {
    if (metrics.totalPositions < 10) return "evaluating"
    if (metrics.totalPositions < 50) {
      return metrics.winRate >= this.thresholds.initial_min_win_rate
        ? "evaluating"
        : "failed"
    }
    const profitRatio = metrics.avgLoss > 0
      ? metrics.avgProfit / metrics.avgLoss
      : metrics.avgProfit > 0 ? Number.POSITIVE_INFINITY : 0
    if (
      metrics.winRate < this.thresholds.pause_threshold_win_rate ||
      metrics.maxDrawdown > this.thresholds.production_max_drawdown
    ) return "paused"
    if (
      metrics.winRate >= this.thresholds.expanded_min_win_rate &&
      profitRatio >= this.thresholds.expanded_min_profit_ratio
    ) return "active"
    return current === "failed" ? "failed" : "paused"
  }

  private generateConfigKey(config: BasePositionConfig): string {
    const legacyKey =
      `${config.symbol}:${config.indicationType}:${config.range}:${config.direction}:` +
      `${config.tpFactor}:${config.slRatio}:${config.trailingEnabled}:${config.trailStart}:` +
      `${config.trailStop}:${config.drawdownRatio}:${config.marketChangeRange}:${config.lastPartRatio}`

    // Preserve pre-v74 keys when no exact upstream name/Set identity exists.
    // New Common/Signal-style callers use v2 so two names or complete configs
    // can never share the same one-open-position Base lane.
    if (config.indicationName || config.configSetKey) {
      return `v2:${JSON.stringify([
        config.symbol,
        config.indicationType,
        config.indicationName || config.indicationType,
        config.configSetKey || legacyKey,
        config.direction,
      ])}`
    }
    // Trend appends the independent active-situation dimension.
    return config.activeSituationRatio === undefined || config.activeSituationRatio === null
      ? legacyKey
      : `${legacyKey}:${config.activeSituationRatio}`
  }
}
