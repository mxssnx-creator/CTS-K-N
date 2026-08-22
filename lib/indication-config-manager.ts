/**
 * Indication Config Manager
 * Manages independent indication configuration sets
 * Each combination of parameters = an independent Redis Set. Stored history
 * retention never limits which configurations calculate.
 */

import { initRedis, getRedisClient } from "@/lib/redis-db"
import { appendUniqueListEntries } from "@/lib/redis-idempotent-list"
import { COMMON_INDICATOR_DEFINITIONS } from "@/lib/common-indicator-config"
import { getCanonicalConnectionSettingsOverlay } from "@/lib/connection-settings-overlay"
import { MAX_BASE_STEP, normalizeBaseMinStep } from "@/lib/constants"

export interface IndicationConfig {
  id: string
  connectionId: string
  steps: number // 2-30
  drawdown_ratio: number // 0.01-0.5
  active_ratio: number // 0.5-0.9
  last_part_ratio: number // 0.1-0.5
  type: "SMA" | "EMA" | "RSI" | "MACD" | "Bollinger" | "SAR" | string
  enabled: boolean
  createdAt: string
}

export interface IndicationResult {
  timestamp: string
  symbol: string
  value: number
  signal: "buy" | "sell" | "neutral"
  confidence?: number
}

const MAX_RESULTS = 250

// Inline Redis completes a resolved Promise in the current microtask turn.
// A legacy recovery scan or a full default-config write can therefore run for
// many pages without giving HTTP requests a chance to enter the event loop.
// Keep each storage batch intact, then yield between batches/pages.
async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

export class IndicationConfigManager {
  private connectionId: string

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  private getConfigKey(configId: string): string {
    return `indication:${this.connectionId}:config:${configId}`
  }

  private getResultsKey(configId: string): string {
    return `indication:${this.connectionId}:config:${configId}:results`
  }

  private getResultsReferenceKey(configId: string): string {
    return `${this.getResultsKey(configId)}:ref`
  }

  private async resolveResultsConfigId(configId: string): Promise<string> {
    await initRedis()
    const client = getRedisClient()
    let current = configId
    const visited = new Set<string>([current])
    // References are written as a one-hop star around a deterministic leader.
    // Follow a few hops as a recovery guard for an interrupted leader change,
    // but never allow malformed data to create an unbounded loop.
    for (let depth = 0; depth < 4; depth++) {
      const next = String(await client.get(this.getResultsReferenceKey(current)).catch(() => "") || "").trim()
      if (!next || next === current || visited.has(next)) break
      visited.add(next)
      current = next
    }
    return current
  }

  private getConfigIndexKey(): string {
    return `indication:${this.connectionId}:configs:index`
  }

  private async scanConfigKeys(client: any): Promise<string[]> {
    // Startup/repair fallback only: this bounded SCAN backfills the maintained
    // config index for legacy data created before the index existed. Normal
    // dashboard/hot-path reads use SMEMBERS on getConfigIndexKey().
    const pattern = `indication:${this.connectionId}:config:*`
    const keys: string[] = []
    if (typeof client.scan !== "function") return keys
    let cursor = "0"
    do {
      const result = await client.scan(cursor, "MATCH", pattern, "COUNT", 100).catch(() => null)
      if (!result) break
      cursor = String(result[0] ?? "0")
      const batch = (result[1] || []).filter((k: string) => !k.includes(":results"))
      keys.push(...batch)
      if (cursor !== "0") await yieldToEventLoop()
    } while (cursor !== "0")
    return keys
  }

  async createConfig(config: Omit<IndicationConfig, "connectionId" | "createdAt">): Promise<IndicationConfig> {
    await initRedis()
    const client = getRedisClient()

    const fullConfig: IndicationConfig = {
      ...config,
      connectionId: this.connectionId,
      createdAt: new Date().toISOString(),
    }

    const key = this.getConfigKey(config.id)
    const pipeline = client.multi()
    pipeline.set(key, JSON.stringify(fullConfig))
    pipeline.sadd(this.getConfigIndexKey(), key)
    await pipeline.exec()

    console.log(`[v0] [IndicationConfigManager] Created config ${config.id} for ${this.connectionId}`)
    return fullConfig
  }

  async getConfig(configId: string): Promise<IndicationConfig | null> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getConfigKey(configId)
    const data = await client.get(key)

    if (!data) return null
    return JSON.parse(typeof data === "string" ? data : JSON.stringify(data))
  }

  async getAllConfigs(): Promise<IndicationConfig[]> {
    await initRedis()
    const client = getRedisClient()

    let keys = ((await client.smembers(this.getConfigIndexKey()).catch(() => [])) || []) as string[]
    if (keys.length === 0) {
      keys = await this.scanConfigKeys(client)
      if (keys.length > 0) await client.sadd(this.getConfigIndexKey(), ...keys).catch(() => 0)
    }
    if (keys.length === 0) return []

    const configs: IndicationConfig[] = []
    // Bound pipeline size without omitting any indexed configuration.
    for (let offset = 0; offset < keys.length; offset += 500) {
      const batch = keys.slice(offset, offset + 500)
      const pipeline = client.multi()
      for (const key of batch) pipeline.get(key)
      const values = await pipeline.exec()
      for (const raw of values || []) {
        const data = Array.isArray(raw) ? raw[1] : raw
        if (!data) continue
        try {
          configs.push(JSON.parse(typeof data === "string" ? data : JSON.stringify(data)))
        } catch { /* skip malformed */ }
      }
      await yieldToEventLoop()
    }
    return configs
  }

  async updateConfig(configId: string, updates: Partial<IndicationConfig>): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const config = await this.getConfig(configId)
    if (!config) {
      throw new Error(`Config ${configId} not found`)
    }

    const updated = { ...config, ...updates }
    const key = this.getConfigKey(configId)
    const pipeline = client.multi()
    pipeline.set(key, JSON.stringify(updated))
    pipeline.sadd(this.getConfigIndexKey(), key)
    await pipeline.exec()

    console.log(`[v0] [IndicationConfigManager] Updated config ${configId}`)
  }

  async deleteConfig(configId: string): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const configKey = this.getConfigKey(configId)
    const resultsKey = this.getResultsKey(configId)

    const pipeline = client.multi()
    pipeline.del(configKey)
    pipeline.del(resultsKey)
    pipeline.del(this.getResultsReferenceKey(configId))
    pipeline.srem(this.getConfigIndexKey(), configKey)
    await pipeline.exec()

    console.log(`[v0] [IndicationConfigManager] Deleted config ${configId}`)
  }

  async addResult(configId: string, result: IndicationResult): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getResultsKey(await this.resolveResultsConfigId(configId))
    const entry = `${result.timestamp}|${result.symbol}|${result.value}|${result.signal}`

    await client.lpush(key, entry)
    await client.ltrim(key, 0, MAX_RESULTS - 1)
  }

  /**
   * Batch variant — pushes many results for a config with a single lpush and
   * a single ltrim. Used by the prehistoric processor to cut per-result
   * Redis round-trips by a factor of N.
   */
  async addResults(
    configId: string,
    results: IndicationResult[],
    dedupeScope?: string,
  ): Promise<number> {
    if (!results || results.length === 0) return 0
    await initRedis()
    const client = getRedisClient()

    const key = this.getResultsKey(await this.resolveResultsConfigId(configId))
    const entries = results.map(
      (r) => `${r.timestamp}|${r.symbol}|${r.value}|${r.signal}`,
    )
    if (dedupeScope) {
      // A scalar completion marker is sufficient for this complete batch.
      // Keeping one Redis Set member per historic result made memory grow
      // with the full matrix while the visible result list is bounded.
      const dedupeKey = `${key}:historic_complete:${dedupeScope.replace(/[^A-Za-z0-9._:-]/g, "_")}`
      const acceptedIndexes = await appendUniqueListEntries(
        client,
        key,
        dedupeKey,
        entries,
        MAX_RESULTS,
        90_000,
      )
      return acceptedIndexes.length
    }

    const pipeline = client.multi()
    pipeline.lpush(key, ...entries)
    pipeline.ltrim(key, 0, MAX_RESULTS - 1)
    await pipeline.exec()
    return entries.length
  }

  async getResults(configId: string, limit = 50): Promise<IndicationResult[]> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getResultsKey(await this.resolveResultsConfigId(configId))
    const rawResults = await client.lrange(key, 0, limit - 1)

    return rawResults.map((entry: string) => {
      const [timestamp, symbol, valueStr, signal] = entry.split("|")
      return {
        timestamp,
        symbol,
        value: parseFloat(valueStr),
        signal: signal as "buy" | "sell" | "neutral",
      }
    })
  }

  async getResultCount(configId: string): Promise<number> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getResultsKey(await this.resolveResultsConfigId(configId))
    return await client.llen(key)
  }

  /**
   * Share immutable historic result rows between configurations whose current
   * calculator inputs are exactly identical. Config objects, enablement,
   * aggregate counters and progression identities remain independent; only
   * the bounded detail LIST is referenced. This prevents the legacy generic
   * calculator from persisting the same rows once per display/type label.
   */
  async setResultReferences(
    references: ReadonlyArray<{ configId: string; referenceConfigId: string }>,
  ): Promise<void> {
    if (references.length === 0) return
    await initRedis()
    const client = getRedisClient()
    for (let offset = 0; offset < references.length; offset += 500) {
      const pipeline = client.multi()
      for (const reference of references.slice(offset, offset + 500)) {
        const configId = String(reference.configId || "").trim()
        const referenceConfigId = String(reference.referenceConfigId || "").trim()
        if (!configId || !referenceConfigId) continue
        const referenceKey = this.getResultsReferenceKey(configId)
        if (configId === referenceConfigId) {
          pipeline.del(referenceKey)
          continue
        }
        pipeline.set(referenceKey, referenceConfigId)
        // A previous release may already have materialised an identical list
        // under this alias. The deterministic leader now owns that immutable
        // detail history, so removing the duplicate does not remove any unique
        // calculation, aggregate, Set identity or configuration state.
        pipeline.del(this.getResultsKey(configId))
      }
      await pipeline.exec()
      await yieldToEventLoop()
    }
  }

  async enableConfig(configId: string): Promise<void> {
    await this.updateConfig(configId, { enabled: true })
  }

  async disableConfig(configId: string): Promise<void> {
    await this.updateConfig(configId, { enabled: false })
  }

  async getEnabledConfigs(): Promise<IndicationConfig[]> {
    const allConfigs = await this.getAllConfigs()
    return allConfigs.filter((c) => c.enabled)
  }

  async generateDefaultConfigs(): Promise<IndicationConfig[]> {
    const types = COMMON_INDICATOR_DEFINITIONS.map((definition) => definition.label)
    await initRedis()
    const connectionSettings = await getCanonicalConnectionSettingsOverlay(this.connectionId)
      .catch(() => ({} as Record<string, string>))
    const minStep = normalizeBaseMinStep(connectionSettings.minStep)
    const stepsOptions = Array.from(
      { length: MAX_BASE_STEP - minStep + 1 },
      (_, index) => index + minStep,
    )
    const drawdownOptions = [0.05, 0.1, 0.15]
    const activeRatioOptions = [0.6, 0.7, 0.8]
    const lastPartRatioOptions = [0.2, 0.3, 0.4]

    const pending: Array<Omit<IndicationConfig, "connectionId" | "createdAt">> = []
    for (const type of types) {
      for (const steps of stepsOptions) {
        for (const drawdownRatio of drawdownOptions) {
          for (const activeRatio of activeRatioOptions) {
            for (const lastPartRatio of lastPartRatioOptions) {
              const fingerprint = [
                type,
                steps,
                drawdownRatio,
                activeRatio,
                lastPartRatio,
              ].join("_").replace(/[^A-Za-z0-9_-]/g, "-")
              pending.push({
                id: `ind_${this.connectionId}_${fingerprint}`,
                steps,
                drawdown_ratio: drawdownRatio,
                active_ratio: activeRatio,
                last_part_ratio: lastPartRatio,
                type,
                enabled: true,
              })
            }
          }
        }
      }
    }

    const now = new Date().toISOString()
    const client = getRedisClient()
    const configs: IndicationConfig[] = pending.map((cfg) => {
      return { ...cfg, connectionId: this.connectionId, createdAt: now }
    })
    // Hand the current HTTP/control turn back before the first large Redis
    // pipeline. This makes a cold production bootstrap observable instead of
    // making the dashboard's first status read wait behind config creation.
    await yieldToEventLoop()
    for (let offset = 0; offset < configs.length; offset += 500) {
      const batch = configs.slice(offset, offset + 500)
      const pipeline = client.multi()
      for (const config of batch) {
        const key = this.getConfigKey(config.id)
        pipeline.set(key, JSON.stringify(config))
        pipeline.sadd(this.getConfigIndexKey(), key)
      }
      await pipeline.exec()
      await yieldToEventLoop()
    }

    return configs
  }

  async clearAllResults(): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const configs = await this.getAllConfigs()
    for (let offset = 0; offset < configs.length; offset += 500) {
      const pipeline = client.multi()
      for (const config of configs.slice(offset, offset + 500)) {
        pipeline.del(this.getResultsKey(config.id))
        pipeline.del(this.getResultsReferenceKey(config.id))
      }
      await pipeline.exec()
      await yieldToEventLoop()
    }

    console.log(`[v0] [IndicationConfigManager] Cleared all results for ${this.connectionId}`)
  }
}
