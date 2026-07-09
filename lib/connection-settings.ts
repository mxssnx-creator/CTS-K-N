/**
 * Connection-specific settings management
 * Each connection has its own isolated settings configuration
 * Defaults are applied when connection is first used
 */

// Deep-merge nested objects so partial updates don't clobber unrelated
// nested fields. Returns a new object with recursively merged nested
// sub-objects (strategy, indication, trading, advanced).
import { getConnection, getRedisClient, initRedis, updateConnection } from "./redis-db"
import { notifySettingsChanged } from "./settings-coordinator"
import { recoordinateAfterSettingsChange } from "./connection-recoordinator"
import { toRedisFlag } from "./boolean-utils"

function deepMergeSettings(
  current: ConnectionSettings,
  updates: Partial<ConnectionSettings>,
): ConnectionSettings {
  const result = { ...current }
  for (const key of Object.keys(updates) as Array<keyof ConnectionSettings>) {
    const val = updates[key]
    if (val && typeof val === "object" && typeof result[key] === "object") {
      result[key] = { ...(result[key] as any), ...val }
    } else if (val !== undefined) {
      ;(result as any)[key] = val
    }
  }
  return result
}

export interface ConnectionSettings {
  connectionId: string
  
  // Strategy settings
  strategy: {
    takeProfit: number
    stopLoss: number
    leverage: number
    volumeMultiplier: number
  }
  
  // Indication settings
  indication: {
    mainType: string
    commonType: string
    autoType: string
    optimalType: string
  }
  
  // Trading settings
  trading: {
    maxPositions: number
    riskPerTrade: number
    dailyLossLimit: number
    autoStopAfterLoss: boolean
  }
  
  // Advanced settings
  advanced: {
    slippageTolerance: number
    executionSpeed: "fast" | "normal" | "slow"
    useTrailingStop: boolean
    enableAutoExit: boolean
  }
}

export const DEFAULT_CONNECTION_SETTINGS: Omit<ConnectionSettings, "connectionId"> = {
  strategy: {
    takeProfit: 8,
    stopLoss: 0.5,
    leverage: 5,
    volumeMultiplier: 1,
  },
  indication: {
    mainType: "Direction",
    commonType: "Momentum",
    autoType: "Volatility",
    optimalType: "Mean Reversion",
  },
  trading: {
    maxPositions: 10,
    riskPerTrade: 2,
    dailyLossLimit: 5,
    autoStopAfterLoss: true,
  },
  advanced: {
    slippageTolerance: 0.0006,
    executionSpeed: "normal",
    useTrailingStop: true,
    enableAutoExit: false,
  },
}

function stringifyHashValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) return JSON.stringify(value)
  return String(value)
}

function extractEngineSettingsMirror(settings: Record<string, unknown>): Record<string, string> {
  const flat: Record<string, string> = {}

  const liveVolume = Number(settings.live_volume_factor ?? settings.volume_factor_live)
  if (Number.isFinite(liveVolume) && liveVolume > 0) {
    const value = String(Math.max(0.1, Math.min(10, liveVolume)))
    flat.live_volume_factor = value
    flat.volume_factor_live = value
  }

  const presetVolume = Number(settings.preset_volume_factor ?? settings.volume_factor_preset)
  if (Number.isFinite(presetVolume) && presetVolume > 0) {
    const value = String(Math.max(0.1, Math.min(10, presetVolume)))
    flat.preset_volume_factor = value
    flat.volume_factor_preset = value
  }

  const volumeStep = Number(settings.volume_step_ratio ?? settings.volumeStepRatio)
  if (Number.isFinite(volumeStep) && volumeStep > 0) {
    flat.volume_step_ratio = String(Math.max(0.2, Math.min(1.8, volumeStep)))
  }

  const symbolCount = Number(settings.symbol_count ?? settings.symbolCount)
  if (Number.isFinite(symbolCount) && symbolCount > 0) {
    flat.symbol_count = String(Math.floor(symbolCount))
  }

  const forceSymbols = settings.force_symbols ?? settings.symbols
  const forceSymbolsValue = stringifyHashValue(forceSymbols)
  if (forceSymbolsValue !== undefined) {
    flat.force_symbols = forceSymbolsValue
    if (settings.symbols !== undefined) flat.symbols = forceSymbolsValue
    if (Array.isArray(forceSymbols) && forceSymbols.length > 0) flat.symbol_count = String(forceSymbols.length)
  }

  if (settings.is_live_trade !== undefined) flat.is_live_trade = toRedisFlag(settings.is_live_trade)

  const positionMode = stringifyHashValue(settings.position_mode)
  if (positionMode !== undefined) flat.position_mode = positionMode

  const marginType = stringifyHashValue(settings.margin_type ?? settings.margin_mode)
  if (marginType !== undefined) {
    flat.margin_type = marginType
    if (settings.margin_mode !== undefined) flat.margin_mode = marginType
  }

  return flat
}

function extractConnectionTopLevelMirror(flat: Record<string, string>): Record<string, string> {
  const patch: Record<string, string> = {}
  for (const key of [
    "live_volume_factor",
    "preset_volume_factor",
    "volume_step_ratio",
    "force_symbols",
    "symbol_count",
    "is_live_trade",
    "position_mode",
    "margin_type",
  ]) {
    if (flat[key] !== undefined) patch[key] = flat[key]
  }
  return patch
}

async function mirrorEngineSettingsStores(
  connectionId: string,
  previousSettings: Record<string, unknown>,
  updatedSettings: Record<string, unknown>,
  changedFields: string[],
): Promise<void> {
  const flat = extractEngineSettingsMirror(updatedSettings)
  const topLevelPatch = extractConnectionTopLevelMirror(flat)
  const beforeConnection = await getConnection(connectionId).catch(() => null)
  let afterConnection = beforeConnection ? { ...beforeConnection } : null

  if (Object.keys(flat).length > 0) {
    const client = await getRedisClient()
    await Promise.all([
      client.hset(`connection_settings:${connectionId}`, flat),
      client.hset(`settings:connection_settings:${connectionId}`, flat).catch(() => 0),
    ])
  }

  if (beforeConnection && Object.keys(topLevelPatch).length > 0) {
    afterConnection = (await updateConnection(connectionId, topLevelPatch)) || {
      ...beforeConnection,
      ...topLevelPatch,
      updated_at: new Date().toISOString(),
    }
  }

  const notifyFields = Array.from(new Set([
    ...changedFields,
    ...Object.keys(flat),
    ...(Object.keys(flat).length > 0 ? ["connection_settings"] : []),
  ]))

  if (beforeConnection && afterConnection) {
    await recoordinateAfterSettingsChange(
      connectionId,
      { ...beforeConnection, connection_settings: previousSettings },
      { ...afterConnection, connection_settings: updatedSettings },
      {
        logTag: "legacy connection-settings",
        changedFieldsOverride: notifyFields,
      },
    )
  } else if (notifyFields.length > 0) {
    await notifySettingsChanged(connectionId, notifyFields, previousSettings, updatedSettings)
  }
}

/**
 * Get settings for a specific connection
 * Returns defaults if connection settings don't exist
 */
export async function getConnectionSettings(connectionId: string): Promise<ConnectionSettings> {
  try {
    await initRedis()
    const client = await getRedisClient()
    const key = `settings:connection:${connectionId}`
    
    const existing = await client.get(key)
    if (existing) {
      return JSON.parse(existing)
    }

    // Initialize with defaults for this connection
    const newSettings: ConnectionSettings = {
      connectionId,
      ...DEFAULT_CONNECTION_SETTINGS,
    }
    
    await client.set(key, JSON.stringify(newSettings))
    return newSettings
  } catch (error) {
    console.error(`Failed to get connection settings for ${connectionId}:`, error)
    return {
      connectionId,
      ...DEFAULT_CONNECTION_SETTINGS,
    }
  }
}

/**
 * Update settings for a specific connection
 * Also invalidates caches and notifies processors to reload configuration
 */
export async function updateConnectionSettings(
  connectionId: string,
  settings: Partial<ConnectionSettings> & Record<string, unknown>
): Promise<ConnectionSettings> {
  const lockKey = `settings:lock:${connectionId}`
  const LOCK_TTL = 5
  try {
    await initRedis()
    const client = await getRedisClient()
    const key = `settings:connection:${connectionId}`
    // Acquire a short-lived write lock to prevent two concurrent saves
    // from reading the same current value and losing each other's changes.
    const locked = await client.set(lockKey, String(Date.now()), { NX: true, EX: LOCK_TTL })
    if (!locked) {
      // Another save is in-flight; retry once after a brief yield
      await new Promise(r => setTimeout(r, 100))
      const retryLocked = await client.set(lockKey, String(Date.now()), { NX: true, EX: LOCK_TTL })
      if (!retryLocked) throw new Error("Another settings save is in progress")
    }
    try {
      // Get current settings
      const current = await getConnectionSettings(connectionId)

      // Deep-merge to preserve nested sub-objects when partial updates arrive
      const updated = deepMergeSettings(current, settings)

      // Save to Redis
      await client.set(key, JSON.stringify(updated))
      // Mirror engine-consumed settings into the same Redis stores and
      // connection top-level fields used by /api/settings/connections/[id]/settings.
      const changed: string[] = []
      for (const k of Object.keys(settings) as Array<keyof typeof settings>) {
        if (settings[k] !== undefined) changed.push(k as string)
      }
      if (changed.length > 0) {
        await mirrorEngineSettingsStores(connectionId, current as any, updated as any, changed)
      }

      // ── CRITICAL: Invalidate all related caches ──────────────────────────────
      // When settings change, we need to:
      // 1. Clear any cached config in strategy processors
      // 2. Notify the engine to reload settings
      // 3. Force a config refresh on next tick

      try {
        // Mark settings as dirty - processors should reload on next cycle
        await client.set(`settings:dirty:${connectionId}`, "1", { EX: 300 }) // 5 min TTL

        // Clear any cached advanced configs for this connection
        await client.del(`cached_config:${connectionId}`)

        // Invalidate strategy processor cache
        await client.del(`strategy_processor_cache:${connectionId}`)

        // Force engine to reload connection state
        const connKey = `connection:${connectionId}`
        const connData = await client.hgetall(connKey)
        if (connData && Object.keys(connData).length > 0) {
          // Update last_settings_update timestamp to trigger engine refresh
          await client.hset(connKey, {
            last_settings_update: new Date().toISOString(),
          })
        }

        console.log(
          `[v0] [Settings] Invalidated caches and marked dirty for ${connectionId} - processors will reload on next cycle`
        )
      } catch (cacheErr) {
        console.warn(
          `[v0] [Settings] Cache invalidation warning for ${connectionId}:`,
          cacheErr instanceof Error ? cacheErr.message : String(cacheErr)
        )
        // Non-fatal - settings are saved even if cache invalidation fails
      }

      return updated
    } finally {
      await client.del(lockKey).catch(() => {})
    }
  } catch (error) {
    console.error(`Failed to update connection settings for ${connectionId}:`, error)
    throw error
  }
}

/**
 * Get strategy-specific settings for a connection
 */
export async function getConnectionStrategySettings(connectionId: string) {
  const settings = await getConnectionSettings(connectionId)
  return settings.strategy
}

/**
 * Get indication-specific settings for a connection
 */
export async function getConnectionIndicationSettings(connectionId: string) {
  const settings = await getConnectionSettings(connectionId)
  return settings.indication
}

/**
 * Get trading-specific settings for a connection
 */
export async function getConnectionTradingSettings(connectionId: string) {
  const settings = await getConnectionSettings(connectionId)
  return settings.trading
}

/**
 * Reset connection settings to defaults
 */
export async function resetConnectionSettings(connectionId: string): Promise<ConnectionSettings> {
  const lockKey = `settings:lock:${connectionId}`
  const LOCK_TTL = 5
  const newSettings: ConnectionSettings = {
    connectionId,
    ...DEFAULT_CONNECTION_SETTINGS,
  }
  try {
    await initRedis()
    const client = await getRedisClient()
    const key = `settings:connection:${connectionId}`
    const locked = await client.set(lockKey, String(Date.now()), { NX: true, EX: LOCK_TTL })
    if (!locked) {
      await new Promise(r => setTimeout(r, 100))
      const retryLocked = await client.set(lockKey, String(Date.now()), { NX: true, EX: LOCK_TTL })
      if (!retryLocked) throw new Error("Another settings save is in progress")
    }

    try {
      const previousSettings = await getConnectionSettings(connectionId).catch(() => ({ connectionId, ...DEFAULT_CONNECTION_SETTINGS }))
      await client.set(key, JSON.stringify(newSettings))
      // Notify running engines — reset is a full config change. Await this
      // before releasing the settings lock so API success means the durable
      // settings_change and dirty signals have also been written.
      await mirrorEngineSettingsStores(connectionId, previousSettings as any, newSettings as any, ["strategy", "indication", "trading", "advanced", "connection_settings"])
    } finally {
      await client.del(lockKey).catch(() => {})
    }
  } catch (error) {
    console.error(`Failed to reset connection settings for ${connectionId}:`, error)
    throw error
  }
  return newSettings
}

/**
 * Delete all settings for a connection
 */
export async function deleteConnectionSettings(connectionId: string): Promise<void> {
  try {
    await initRedis()
    const client = await getRedisClient()
    const key = `settings:connection:${connectionId}`
    await client.del(key)
    // Notify running engines so they fall back to defaults immediately
    await client.set(`settings:dirty:${connectionId}`, "1", { EX: 300 }).catch(() => {})
    notifySettingsChanged(connectionId, ["settings_deleted"]).catch(() => {})
  } catch (error) {
    console.error(`Failed to delete connection settings for ${connectionId}:`, error)
    throw error
  }
}

/**
 * Validate connection settings
 */
export function validateConnectionSettings(settings: Partial<ConnectionSettings>): boolean {
  if (settings.strategy) {
    const s = settings.strategy
    if (
      !Number.isFinite(s.takeProfit) || !Number.isFinite(s.stopLoss) || !Number.isFinite(s.leverage) ||
      s.takeProfit <= 0 || s.takeProfit > 100 ||
      s.stopLoss <= 0 || s.stopLoss > 100 ||
      s.leverage <= 0 || s.leverage > 125
    ) {
      return false
    }
    if (s.takeProfit <= s.stopLoss) return false
  }
  if (settings.trading) {
    const t = settings.trading
    if (
      !Number.isFinite(t.maxPositions) || !Number.isFinite(t.riskPerTrade) ||
      t.maxPositions <= 0 || t.maxPositions > 500 ||
      t.riskPerTrade <= 0 || t.riskPerTrade > 100
    ) {
      return false
    }
  }
  if (settings.advanced) {
    const a = settings.advanced
    if (
      !Number.isFinite(a.slippageTolerance) ||
      a.slippageTolerance < 0 || a.slippageTolerance > 1
    ) {
      return false
    }
  }
  return true
}
