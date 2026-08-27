import {
  DEFAULT_BASE_MIN_STEP,
  DEFAULT_VOLUME_STEP_RATIO,
  normalizeBaseMinStep,
  normalizeBaseVolumeFactor,
} from "@/lib/constants"
import { NextResponse } from "next/server"
import {
  getAppSettings,
  setAppSettings,
  initRedis,
  getAllConnections,
  withSharedPersistenceLease,
} from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { invalidateCompactionCache } from "@/lib/sets-compaction"
import { notifySettingsChanged } from "@/lib/settings-coordinator"
import { changedSettingKeys, settingsValuesEqual } from "@/lib/settings-diff"
import { DEFAULT_DCA_PROFILE } from "@/lib/dca-strategy"
import { DEFAULT_TRAILING_VARIANTS } from "@/lib/trailing-settings"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import {
  normalizePositionCostPercent,
  POSITION_COST_PERCENT_DEFAULT,
} from "@/lib/position-cost"
import { normalizeTrendTimeframesMinutes } from "@/lib/trend-indication"
import {
  MAIN_TRADE_BASE_PF_RATIO_DEFAULT,
  MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
  normalizeMainTradePfRatio,
} from "@/lib/main-trade-profit-factor"
import { POS_COUNT_VOLUME_RATIO_DEFAULT } from "@/lib/pos-count-volume-ratio"
import { REALIZED_PROFIT_FACTOR_MIN_DEFAULT } from "@/lib/profit-factor-defaults"
import { mapWithConcurrency } from "@/lib/bounded-concurrency"
import { BLOCK_COUNT_MAX } from "@/lib/block-count-state"
import {
  ACTIVE_MARKET_EXIT_SITUATIONS,
  DEFAULT_ACTIVE_OUTBREAK_RANGES,
  DEFAULT_ACTIVE_STOP_LOSS_POSITION_COST_RATIOS,
  DEFAULT_ACTIVE_TAKE_PROFIT_MULTIPLIERS,
} from "@/lib/active-outbreak-indication"
import {
  canonicalForcedBaseSymbols,
  canonicalForcedSymbols,
} from "@/lib/forced-symbols"
import {
  DEFAULT_SPECIAL_STRATEGY_SETTINGS,
  specialSettingsFromAppSettings,
} from "@/lib/special-strategy"
import { defaultStrategyIndicationVariantSettings } from "@/lib/strategy-indication-policy"

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
    const activeConnections = (connections || []).filter((c: any) =>
      isTruthyFlag(
        c.is_enabled_dashboard
        ?? c.is_enabled
        ?? c.active_inserted
        ?? c.inserted
        ?? c.enabled,
      ),
    )

    const coordinator = await import("@/lib/trade-engine")
      .then(({ getGlobalTradeEngineCoordinator }) => getGlobalTradeEngineCoordinator())
      .catch(() => null)

    // Complete fan-out with bounded work in flight. This preserves every
    // active connection while preventing a large installation from opening
    // an unbounded burst of Redis/log/reload promises on one API request.
    await mapWithConcurrency(activeConnections, 4, async (conn: any) => {
      await Promise.allSettled([
        logProgressionEvent(
          conn.id,
          "settings_changed",
          "info",
          `Operator saved ${keyCount} setting${keyCount === 1 ? "" : "s"} — recoordinating engine`,
          { keyCount, fields: changedKeys },
        ),
        notifySettingsChanged(
          conn.id,
          changedKeys.length > 0 ? changedKeys : ["app_settings"],
        ).then(() => coordinator?.applyPendingChangesNow(conn.id)),
      ])
    })
  } catch {
    /* non-critical */
  }
}

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const POSITION_COST_KEYS = ["positionCost", "exchangePositionCost", "exchange_position_cost"] as const
const BASE_VOLUME_FACTOR_KEYS = [
  "base_volume_factor",
  "volume_factor",
  "baseVolumeFactor",
] as const
const CHANNEL_VOLUME_FACTOR_KEYS = [
  "live_volume_factor",
  "volume_factor_live",
  "mainTradeVolumeFactor",
  "main_trade_volume_factor",
  "preset_volume_factor",
  "volume_factor_preset",
  "presetTradeVolumeFactor",
  "preset_trade_volume_factor",
  "signal_volume_factor",
  "volume_factor_signal",
  "signalTradeVolumeFactor",
  "signal_trade_volume_factor",
  "signalVolumeFactor",
] as const
const BLOCK_STACK_KEYS = ["blockMaxStack", "blockRowLiveMaxStack", "presetBlockMaxStack"] as const
const POSITION_COST_PF_SELECTION_KEYS = [
  "profitFactorMinPreset",
  "strategyRealMinProfitFactor",
  "indication_min_profit_factor",
  "strategy_min_profit_factor",
] as const

function flattenSpecialSettings(settings: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).map(([key, value]) => [
    `special${key.charAt(0).toUpperCase()}${key.slice(1)}`,
    value,
  ]))
}

function normalizePositionCostSettings<T extends Record<string, any>>(settings: T): T {
  const normalized: Record<string, any> = { ...settings }
  // The operator-required base basket is immutable across old/new setting
  // aliases. Dynamic and connection-local symbols may extend it elsewhere,
  // but settings writes can never remove or reorder these four symbols.
  normalized.forcedSymbols = canonicalForcedBaseSymbols()
  normalized.forced_symbols = canonicalForcedSymbols()
  if (Object.prototype.hasOwnProperty.call(normalized, "minStep")) {
    normalized.minStep = normalizeBaseMinStep(normalized.minStep)
  }

  for (const key of POSITION_COST_KEYS) {
    if (normalized[key] === undefined || normalized[key] === null || normalized[key] === "") continue

    const value = Number(normalized[key])
    if (Number.isFinite(value)) {
      normalized[key] = normalizePositionCostPercent(value)
    }
  }
  for (const key of BASE_VOLUME_FACTOR_KEYS) {
    if (normalized[key] === undefined || normalized[key] === null || normalized[key] === "") continue
    normalized[key] = normalizeBaseVolumeFactor(normalized[key])
  }
  for (const key of CHANNEL_VOLUME_FACTOR_KEYS) {
    if (normalized[key] === undefined || normalized[key] === null || normalized[key] === "") continue
    const value = Number(normalized[key])
    normalized[key] = Number.isFinite(value)
      ? Math.max(1, Math.min(10, value))
      : 1
  }
  for (const key of BLOCK_STACK_KEYS) {
    if (normalized[key] === undefined || normalized[key] === null || normalized[key] === "") continue
    const value = Number(normalized[key])
    normalized[key] = Number.isFinite(value)
      ? Math.max(1, Math.min(BLOCK_COUNT_MAX, Math.floor(value)))
      : BLOCK_COUNT_MAX
  }
  for (const key of POSITION_COST_PF_SELECTION_KEYS) {
    if (normalized[key] === undefined || normalized[key] === null || normalized[key] === "") continue
    normalized[key] = normalizeMainTradePfRatio(normalized[key])
  }
  if (normalized.trendTimeframesMinutes !== undefined) {
    normalized.trendTimeframesMinutes = normalizeTrendTimeframesMinutes(
      normalized.trendTimeframesMinutes,
    )
  }
  if (
    Object.keys(normalized).some((key) => key.startsWith("special")) ||
    normalized.special !== undefined
  ) {
    Object.assign(normalized, flattenSpecialSettings(specialSettingsFromAppSettings(normalized)))
  }

  return normalized as T
}

function getDefaultSettings(): Record<string, any> {
  return {
    ...flattenSpecialSettings(DEFAULT_SPECIAL_STRATEGY_SETTINGS),
    ...defaultStrategyIndicationVariantSettings(),
    mainEngineIntervalMs: 700,
    presetEngineIntervalMs: 120000,
    strategyUpdateIntervalMs: 10000,
    realtimeIntervalMs: 300,
    mainEngineEnabled: true,
    presetEngineEnabled: true,
    minimum_connect_interval: 200,
    theme: "blackwhiteblue",
    language: "en",
    notifications_enabled: true,
    default_leverage: 0, // 0 = resolved from exchange predefinition at order time
    useMaximalLeverage: true,
    leveragePercentage: 100,
    default_volume: 100,
    // Live sizing ratios are dimensionless and identity-based.  Ratio 1 is
    // exactly one venue-minimum order; channel-specific factors are composed
    // once at the Live boundary.
    mainTradeVolumeFactor: 1,
    presetTradeVolumeFactor: 1,
    signalTradeVolumeFactor: 1,
    volume_step_ratio: DEFAULT_VOLUME_STEP_RATIO,
    max_open_positions: 10,
    max_drawdown_percent: 20,
    daily_loss_limit: 1000,
    main_symbols: canonicalForcedSymbols(),
    forcedSymbols: canonicalForcedBaseSymbols(),
    forced_symbols: canonicalForcedSymbols(),
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
    // Exact-lane timing. The 250 ms indication cooldown is keyed by
    // connection + symbol + type + name + complete config + direction; Base
    // re-entry is independently keyed at 3 seconds after that exact Set closes.
    validationTimeoutSeconds: 0.25,
    indicationTimeoutMs: 250,
    positionCooldownMs: 3000,
    maxPositionsPerConfigDirection: 1,
    maxPositionsLong: 1,
    maxPositionsShort: 1,
    // P0-4 spec cap — hard cap on concurrent pseudo positions per direction
    // (Long / Short). Kept in the defaults so fresh installs boot with the
    // spec-mandated value instead of an undefined sentinel.
    maxActiveBasePseudoPositionsPerDirection: 1,
    minStep: DEFAULT_BASE_MIN_STEP,
    // Strategy retention/scheduling controls. Main batching never truncates
    // the exhaustive position-count configuration space.
    strategyMaxEntriesPerSet: 250,
    strategyMainAxisBatchSize: 32,
    strategyBlockMaterializationBatchSize: 1024,
    strategyRealSetsSafetyCeiling: 0,
    maxRealSets: 0,
    strategyLiveSetsCeiling: 0,
    baseProfitFactor: MAIN_TRADE_BASE_PF_RATIO_DEFAULT,
    mainProfitFactor: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
    realProfitFactor: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
    liveProfitFactor: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
    maxDrawdownTimeMainHours: 4,
    maxDrawdownTimeRealHours: 4,
    maxDrawdownTimeLiveHours: 4,
    mainEvalPosCount: 25,
    realEvalPosCount: 20,
    blockRowRealEvalPosCount: 20,
    liveEvalPosCount: 15,
    posCountsVolumeRatio: POS_COUNT_VOLUME_RATIO_DEFAULT,
    strategyBaseTrailingEnabled: true,
    strategyBaseTrailingVariants: DEFAULT_TRAILING_VARIANTS,
    normalEnabled: true,
    blockAdjustment: true,
    variantBlockEnabled: true,
    blockVolumeRatio: 1,
    blockProfitFactorRatio: 0.8,
    presetBlockProfitFactorRatio: 0.8,
    blockMaxStack: 12,
    blockPauseCountRatio: 1,
    blockActiveRealEnabled: true,
    blockActiveLiveEnabled: true,
    blockRowLiveEnabled: true,
    blockRowLiveVolumeRatio: 1,
    blockRowLiveProfitFactorRatio: 0.8,
    blockRowLiveMaxStack: 12,
    blockRowLivePauseCountRatio: 1,
    directionEnabled: true,
    moveEnabled: true,
    activeEnabled: true,
    activeAdvancedEnabled: true,
    optimalEnabled: true,
    autoEnabled: true,
    // Exhaustive inclusive range grids. Bounded concurrency controls runtime
    // pressure; the configured indicator space itself is never sampled.
    indicationSampleRanges: Array.from({ length: 29 }, (_, index) => index + 2),
    optimalSampleRanges: Array.from({ length: 29 }, (_, index) => index + 2),
    indicationDrawdownRatios: [0.5, 1, 1.5],
    indicationLastPartRatios: [0.25, 0.5],
    indicationFactorMultipliers: [0.9, 1, 1.1],
    activeThresholds: [0.5, 1, 1.5, 2, 2.5],
    activeTimeRatios: [0.5, 1],
    activeOutbreakRanges: [...DEFAULT_ACTIVE_OUTBREAK_RANGES],
    activeNoiseFilter: 0.05,
    activeVolatilityWeight: 0.3,
    activeStopLossPositionCostRatios: [...DEFAULT_ACTIVE_STOP_LOSS_POSITION_COST_RATIOS],
    activeTakeProfitMultipliers: [...DEFAULT_ACTIVE_TAKE_PROFIT_MULTIPLIERS],
    activeMarketExitSituations: [...ACTIVE_MARKET_EXIT_SITUATIONS],
    activeAdvancedActivityRatios: [0.5, 1, 1.5, 2, 2.5, 3],
    activeAdvancedMinPositions: 3,
    activeAdvancedContinuationRatio: 0.6,
    defaultCoordinationEnabled: true,
    defaultCoordinationRanges: [2, 5, 10, 20, 30],
    defaultCoordinationRangeSteps: [2, 2.5, 3],
    defaultCoordinationDrawdownRatios: [1, 1.5, 2],
    defaultCoordinationHigherRangeDrawdownScale: 0.5,
    defaultCoordinationMinAgreement: 0.6,
    defaultCoordinationMinimumSignals: 3,
    defaultCoordinationShortDifferenceRatio: 0.1,
    directionPostChangeOnly: true,
    profitFactorMinPreset: REALIZED_PROFIT_FACTOR_MIN_DEFAULT,
    drawdownTimePreset: 5,
    presetHistoryDays: 14,
    presetCountPerSymbol: 4,
    presetTpMin: 3,
    presetTpMax: 30,
    presetTpStep: 5,
    presetSlMin: 0.25,
    presetSlMax: 2,
    presetSlStep: 0.25,
    presetTrailingEnabled: true,
    presetTrailingIndependent: true,
    presetTrailStartMin: 0.5,
    presetTrailStartMax: 1.5,
    presetTrailStartStep: 0.1,
    presetTrailStopMin: 0.2,
    presetTrailStopStep: 0.1,
    presetTrailStepRatio: 0.5,
    presetAutoGenerate: true,
    presetAutoSelect: true,
    presetIndicatorTypes: [
      "ma", "rsi", "macd", "bollinger", "ema", "sma", "stochastic", "adx", "atr",
      "psar", "cci", "adl", "fibonacci", "roc", "williamsR", "obv", "vwap",
    ],
    presetMaxIndicatorVariants: 4,
    presetMaxSignalsPerVariant: 48,
    presetMaxCandlesPerRun: 6000,
    presetBlockEnabled: true,
    presetBlockVolumeRatio: 1,
    presetBlockMaxStack: 12,
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
    dcaMaxPositionVolumeRatio: DEFAULT_DCA_PROFILE.maxPositionVolumeRatio,
    positionCost: POSITION_COST_PERCENT_DEFAULT,
    exchangePositionCost: POSITION_COST_PERCENT_DEFAULT,
    trendEnabled: true,
    trendTimeframesMinutes: [1, 5, 15, 30],
    trendDrawdownValues: [-1, -2, -3],
    trendLastSituationRatios: [0.5, 1],
    trendActiveSituationRatios: [0.5, 1],
    trendMinAgreement: 0.6,
    trendCombinedEnabled: true,
    trendRangeSteps: [2, 2.5, 3],
    trendHigherRangeDrawdownScale: 0.5,
    trendTpMinMultiplier: 2,
    trendTpMaxFactor: 10,
    trendTpStep: 1,
    databaseSizeTrend: 250,
  }
}

async function handleGet() {
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
      const normalizedTrendTimeframes = normalizeTrendTimeframesMinutes(
        (settings as Record<string, any>).trendTimeframesMinutes,
      )
      if (
        JSON.stringify((settings as Record<string, any>).trendTimeframesMinutes) !==
        JSON.stringify(normalizedTrendTimeframes)
      ) {
        settings = {
          ...(settings as Record<string, any>),
          trendTimeframesMinutes: normalizedTrendTimeframes,
        }
        await setAppSettings(settings)
      }
    }

    const canonicalSettings = normalizePositionCostSettings(settings as Record<string, any>)
    if (JSON.stringify(settings) !== JSON.stringify(canonicalSettings)) {
      settings = canonicalSettings
      await setAppSettings(canonicalSettings)
    }

    return NextResponse.json({ settings })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Failed to get settings from Redis:", errorMsg)
    // Return defaults even on error so the UI always has data
    return NextResponse.json({ settings: getDefaultSettings() })
  }
}

async function handlePost(request: Request) {
  try {
    const parsedBody = await request.json()
    const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
      ? parsedBody as Record<string, any>
      : {}

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
    const changedKeys = changedSettingKeys(
      existingSettings,
      mergedSettings,
      [...new Set([...Object.keys(normalizedBody), "forcedSymbols", "forced_symbols"])],
    )
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

    const persistedSettings = await getAppSettings({ bypassCache: true })
    const persistenceVerified = Object.keys(normalizedBody).every(
      (key) => settingsValuesEqual(persistedSettings[key], mergedSettings[key]),
    )
    if (!persistenceVerified) throw new Error("Settings persistence verification failed")
    return NextResponse.json({ success: true, settings: persistedSettings, persistenceVerified, changedKeys })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Failed to save settings to Redis:", errorMsg)

    return NextResponse.json(
      { error: "Failed to update settings", details: errorMsg },
      { status: 500 },
    )
  }
}

async function handlePut(request: Request) {
  try {
    const parsedBody = await request.json()
    const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
      ? parsedBody as Record<string, any>
      : {}
    const incoming = body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
      ? body.settings as Record<string, any>
      : body

    console.log("[v0] Saving settings to Redis (PUT):", Object.keys(incoming).length, "keys")

    await initRedis()

    // Merge with the FULL current view (canonical + legacy merged) so PUT
    // semantics stay correct even if a setting currently lives only in the
    // legacy hash.
    const existingSettings = (await getAppSettings({ bypassCache: true })) || {}
    const mergedSettings = normalizePositionCostSettings({ ...existingSettings, ...incoming })

    const putChangedKeys = changedSettingKeys(
      existingSettings,
      mergedSettings,
      [...new Set([...Object.keys(incoming || {}), "forcedSymbols", "forced_symbols"])],
    )
    if (putChangedKeys.length > 0) {
      await setAppSettings(mergedSettings)
      invalidateCompactionCache()
    }
    await emitSettingsChanged(putChangedKeys.length, putChangedKeys)

    console.log("[v0] Settings updated successfully in Redis (canonical + legacy mirror)")

    const persistedSettings = await getAppSettings({ bypassCache: true })
    const persistenceVerified = Object.keys(incoming).every(
      (key) => settingsValuesEqual(persistedSettings[key], mergedSettings[key]),
    )
    if (!persistenceVerified) throw new Error("Settings persistence verification failed")
    return NextResponse.json({ success: true, settings: persistedSettings, persistenceVerified, changedKeys: putChangedKeys })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Failed to update settings in Redis:", errorMsg)

    return NextResponse.json(
      { error: "Failed to update settings", details: errorMsg },
      { status: 500 },
    )
  }
}

export async function GET() {
  if (typeof withSharedPersistenceLease !== "function") return handleGet()
  return withSharedPersistenceLease("api:settings:read-seed", handleGet)
}

export async function POST(request: Request) {
  if (typeof withSharedPersistenceLease !== "function") return handlePost(request)
  return withSharedPersistenceLease("api:settings:post", () => handlePost(request))
}

export async function PUT(request: Request) {
  if (typeof withSharedPersistenceLease !== "function") return handlePut(request)
  return withSharedPersistenceLease("api:settings:put", () => handlePut(request))
}
