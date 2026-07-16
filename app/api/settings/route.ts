import { DEFAULT_VOLUME_STEP_RATIO } from "@/lib/constants"
import { NextResponse } from "next/server"
import {
  getAppSettings,
  setAppSettings,
  initRedis,
  getAllConnections,
} from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { invalidateCompactionCache } from "@/lib/sets-compaction"
import { notifySettingsChanged } from "@/lib/settings-coordinator"
import { changedSettingKeys } from "@/lib/settings-diff"
import { DEFAULT_DCA_PROFILE } from "@/lib/dca-strategy"
import { DEFAULT_TRAILING_VARIANTS } from "@/lib/trailing-settings"
import { isTruthyFlag } from "@/lib/connection-state-utils"

/**
 * Fan out a "settings_changed" progression log event AND a settings-
 * coordinator reload signal to every active connection. The coordinator
 * signal causes each running engine to call `applyPendingChangesNow`
 * immediately — new values (positionCost, leverage, TP/SL, etc.) take
 * effect within milliseconds rather than waiting for the next 3 s watcher
 * tick. Log emission is best-effort; coordinator failures are swallowed
 * so a log/signal failure never causes the settings save to 500.
 */
async function emitSettingsChanged(keyCount: number, changedKeys: string[]): Promise<void> {
  if (keyCount <= 0 || changedKeys.length === 0) return
  try {
    const connections = await getAllConnections().catch(() => [])
    const activeConnections = (connections || []).filter((c: any) => isTruthyFlag(c.is_enabled))

    await Promise.all([
      // Progression log fan-out (operator visibility)
      ...activeConnections.map((conn: any) =>
        logProgressionEvent(
          conn.id,
          "settings_changed",
          "info",
          `Operator saved ${keyCount} setting${keyCount === 1 ? "" : "s"} — recoordinating engine`,
          { keyCount, fields: changedKeys.slice(0, 20) },
        ).catch(() => { /* non-critical */ }),
      ),
      // Settings-coordinator reload signal — causes engine to immediately
      // consume the new app-settings values (volume, leverage, TP/SL, etc.)
      // without waiting for the periodic 3 s watcher.
      ...activeConnections.map((conn: any) =>
        notifySettingsChanged(conn.id, changedKeys.length > 0 ? changedKeys : ["app_settings"])
          .then(async () => {
            try {
              const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
              await getGlobalTradeEngineCoordinator().applyPendingChangesNow(conn.id)
            } catch { /* coordinator may not be running in this process; watcher will pick it up */ }
          })
          .catch(() => { /* non-critical */ }),
      ),
    ])
  } catch {
    /* non-critical */
  }
}

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const POSITION_COST_MIN_PERCENT = 0.02
const POSITION_COST_MAX_PERCENT = 1.0
const POSITION_COST_KEYS = ["positionCost", "exchangePositionCost", "exchange_position_cost"] as const

function normalizePositionCostSettings<T extends Record<string, any>>(settings: T): T {
  const normalized: Record<string, any> = { ...settings }

  for (const key of POSITION_COST_KEYS) {
    if (normalized[key] === undefined || normalized[key] === null || normalized[key] === "") continue

    const value = Number(normalized[key])
    if (Number.isFinite(value)) {
      normalized[key] = Math.max(POSITION_COST_MIN_PERCENT, Math.min(POSITION_COST_MAX_PERCENT, value))
    }
  }

  return normalized as T
}

function getDefaultSettings(): Record<string, any> {
  return {
    mainEngineIntervalMs: 700,
    presetEngineIntervalMs: 120000,
    strategyUpdateIntervalMs: 10000,
    realtimeIntervalMs: 300,
    mainEngineEnabled: true,
    presetEngineEnabled: true,
    minimum_connect_interval: 200,
    theme: "dark",
    language: "en",
    notifications_enabled: true,
    default_leverage: 0, // 0 = resolved from exchange predefinition at order time
    useMaximalLeverage: true,
    leveragePercentage: 100,
    default_volume: 100,
    volume_step_ratio: DEFAULT_VOLUME_STEP_RATIO,
    max_open_positions: 10,
    max_drawdown_percent: 20,
    daily_loss_limit: 1000,
    main_symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
    forced_symbols: [],
    database_type: "redis",
    // Canonical prehistoric range (1-50h, step 1, default 8). Must be seeded
    // here so fresh installs pick it up on first GET /api/settings — otherwise
    // the Settings UI would fall back to its own client default of 8 while
    // the engine read would find no value and use its internal default,
    // causing a brief off-by-one between what the UI shows and what the
    // engine actually applies until the user hits Save.
    prehistoric_range_hours: 8,
    // Prehistoric progression timeout minutes (5-25, default 10)
    prehistoric_progression_timeout_minutes: 10,
    // P0-4 spec cap — hard cap on concurrent pseudo positions per direction
    // (Long / Short). Kept in the defaults so fresh installs boot with the
    // spec-mandated value instead of an undefined sentinel.
    maxActiveBasePseudoPositionsPerDirection: 1,
    // Strategy pipeline ceilings. Seeded here so fresh installs expose the
    // same limits the coordinator enforces in production.
    strategyMaxEntriesPerSet: 250,
    strategyMainAxisSetsCeiling: 20,
    strategyRealSetsSafetyCeiling: 25,
    maxRealSets: 25,
    strategyLiveSetsCeiling: 90,
    strategyBaseTrailingEnabled: true,
    strategyBaseTrailingVariants: DEFAULT_TRAILING_VARIANTS,
    blockAdjustment: true,
    variantBlockEnabled: true,
    blockVolumeRatio: 1,
    blockMaxStack: 10,
    blockPauseCountRatio: 1,
    blockActiveRealEnabled: true,
    blockActiveLiveEnabled: true,
    profitFactorMinPreset: 0.7,
    drawdownTimePreset: 5,
    presetHistoryDays: 14,
    presetCountPerSymbol: 4,
    presetTpMin: 3,
    presetTpMax: 30,
    presetTpStep: 1,
    presetSlMin: 0.25,
    presetSlMax: 2,
    presetSlStep: 0.25,
    presetTrailingEnabled: true,
    presetTrailingIndependent: true,
    presetTrailStartMin: 0.5,
    presetTrailStartMax: 1.5,
    presetTrailStartStep: 0.1,
    presetTrailStopMin: 0.2,
    presetTrailStopMax: 0.4,
    presetTrailStopStep: 0.1,
    presetTrailStepRatio: 0.5,
    presetAutoGenerate: true,
    presetAutoSelect: true,
    presetIndicatorTypes: ["rsi", "macd", "bollinger", "ema", "sma", "stochastic", "adx", "atr", "sar"],
    presetMaxIndicatorVariants: 4,
    presetMaxSignalsPerVariant: 48,
    presetMaxCandlesPerRun: 6000,
    presetBlockEnabled: true,
    presetBlockVolumeRatio: 1,
    presetBlockMaxStack: 10,
    presetBlockPauseCountRatio: 1,
    presetBlockActiveRealEnabled: true,
    presetBlockActiveLiveEnabled: true,
    dcaAdjustment: false,
    dcaMaxSteps: DEFAULT_DCA_PROFILE.maxSteps,
    dcaStepVolumeMultipliers: DEFAULT_DCA_PROFILE.stepVolumeMultipliers,
    dcaStepDistancesPct: DEFAULT_DCA_PROFILE.stepDistancesPct,
    dcaTakeProfitMode: DEFAULT_DCA_PROFILE.takeProfitMode,
    dcaBreakevenProfitPct: DEFAULT_DCA_PROFILE.breakevenProfitPct,
    dcaCooldownSeconds: DEFAULT_DCA_PROFILE.cooldownSeconds,
    positionCost: POSITION_COST_MIN_PERCENT,
    exchangePositionCost: POSITION_COST_MIN_PERCENT,
  }
  }

export async function GET() {
  try {
    await initRedis()

    // Mirror-aware read: merges `app_settings` (canonical / UI-facing) and
    // `all_settings` (legacy — still read by several trade-engine modules).
    // This unifies the view so the UI always shows what the engine will
    // actually apply, regardless of which key a setting happens to live in.
    let settings = await getAppSettings({ bypassCache: true })

    if (!settings || Object.keys(settings).length === 0) {
      // Auto-seed defaults when BOTH keys are empty. `setAppSettings` writes
      // to canonical + legacy in one go so legacy consumers also boot with
      // the defaults applied.
      const defaults = getDefaultSettings()
      await setAppSettings(defaults)
      settings = defaults
      console.log("[v0] Settings auto-seeded with", Object.keys(defaults).length, "default keys")
    } else {
      // Merge in newly-added defaults for existing installations. Without this
      // the Settings UI shows fallback values that never get persisted, while
      // engine code reading Redis sees undefined and falls back independently.
      // Persisting the missing keys keeps System ceilings and runtime ceilings
      // in lock-step after deploys.
      const defaults = getDefaultSettings()
      const missingDefaults: Record<string, any> = {}
      for (const [key, value] of Object.entries(defaults)) {
        if ((settings as Record<string, any>)[key] === undefined) {
          missingDefaults[key] = value
        }
      }
      if (Object.keys(missingDefaults).length > 0) {
        settings = { ...defaults, ...(settings as Record<string, any>) }
        await setAppSettings(settings)
      }
    }

    return NextResponse.json({ settings })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Failed to get settings from Redis:", errorMsg)
    // Return defaults even on error so the UI always has data
    return NextResponse.json({ settings: getDefaultSettings() })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()

    console.log("[v0] Saving settings to Redis (POST):", Object.keys(body).length, "keys")

    await initRedis()

    // Mirror-write: writes to BOTH `app_settings` and `all_settings` so the
    // Settings UI and every trade-engine module (strategy-processor,
    // pseudo-position-manager, market-data-cache, indication-processor-fixed,
    // indication-sets-processor — all of which read `all_settings`) see the
    // same snapshot on the next cycle.
    const existingSettings = (await getAppSettings({ bypassCache: true })) || {}
    // POST is accepted as a partial compatibility write. Preserve the full
    // canonical snapshot in both Redis and the in-process cache; caching only
    // the submitted fields made unrelated settings appear to reset until the
    // next bypass-cache read.
    const normalizedBody = normalizePositionCostSettings(body)
    const mergedSettings = normalizePositionCostSettings({ ...existingSettings, ...normalizedBody })
    const changedKeys = changedSettingKeys(existingSettings, mergedSettings, Object.keys(normalizedBody))
    if (changedKeys.length > 0) {
      await setAppSettings(mergedSettings)
      // Bust the in-process compaction config cache only for a real change.
      invalidateCompactionCache()
    }
    // Fan out a progression event AND a coordinator reload signal so the
    // running engine immediately picks up new positionCost / leverage /
    // TP/SL values without waiting for the 3 s watcher tick.
    await emitSettingsChanged(changedKeys.length, changedKeys)

    console.log("[v0] Settings saved successfully to Redis (canonical + legacy mirror)")

    return NextResponse.json({ success: true, settings: mergedSettings })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Failed to save settings to Redis:", errorMsg)

    return NextResponse.json(
      { error: "Failed to update settings", details: errorMsg },
      { status: 500 },
    )
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json()
    const incoming = body.settings || body

    console.log("[v0] Saving settings to Redis (PUT):", Object.keys(incoming).length, "keys")

    await initRedis()

    // Merge with the FULL current view (canonical + legacy merged) so PUT
    // semantics stay correct even if a setting currently lives only in the
    // legacy hash.
    const existingSettings = (await getAppSettings({ bypassCache: true })) || {}
    const mergedSettings = normalizePositionCostSettings({ ...existingSettings, ...incoming })

    const putChangedKeys = changedSettingKeys(existingSettings, mergedSettings, Object.keys(incoming || {}))
    if (putChangedKeys.length > 0) {
      await setAppSettings(mergedSettings)
      invalidateCompactionCache()
    }
    await emitSettingsChanged(putChangedKeys.length, putChangedKeys)

    console.log("[v0] Settings updated successfully in Redis (canonical + legacy mirror)")

    return NextResponse.json({ success: true, settings: mergedSettings })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Failed to update settings in Redis:", errorMsg)

    return NextResponse.json(
      { error: "Failed to update settings", details: errorMsg },
      { status: 500 },
    )
  }
}
