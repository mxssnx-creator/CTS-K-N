import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { initRedis, getConnection, getRedisClient, getSettings } from "@/lib/redis-db"
import { RedisTrades, RedisPositions } from "@/lib/redis-operations"
import { applyMainConnectionSettingsChange } from "@/lib/connection-recoordinator"
import { getTradeEngine } from "@/lib/trade-engine"
import { fetchTopSymbols, normaliseSort } from "@/lib/top-symbols"
import { toRedisFlag } from "@/lib/boolean-utils"
import { mergeConnectionSettings } from "@/lib/connection-settings-merge"
import {
  DEFAULT_TRAILING_VARIANTS,
  normalizeTrailingVariants,
  parseStoredBoolean,
} from "@/lib/trailing-settings"
import { normalizeDcaProfile } from "@/lib/dca-strategy"
import {
  DEFAULT_MAIN_INDICATION_PROFILE,
  DEFAULT_PRESET_INDICATION_PROFILE,
  indicationProfilesToFlat,
  normalizeIndicationProfile,
  readStoredIndicationProfile,
} from "@/lib/active-indication-profile"
import { changedSettingKeys, settingsValuesEqual } from "@/lib/settings-diff"
import { maskConnectionSecrets, maskConnectionSettings } from "@/lib/connection-secrets"
import { normalizeStrategyAxes } from "@/lib/strategy-axis-settings"

const FALLBACK_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "ATOMUSDT", "LTCUSDT", "UNIUSDT", "NEARUSDT", "MATICUSDT",
  "OPUSDT", "ARBUSDT", "APTUSDT", "SUIUSDT", "INJUSDT",
  "TIAUSDT", "SEIUSDT", "WLDUSDT", "PYTHUSDT", "JUPUSDT",
]

// Recoordination is intentionally centralized in recoordinateAfterSettingsChange() below.
export const dynamic = "force-dynamic"
export const maxDuration = 30

function serializeConnectionSettingsHash(settings: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined || value === null) continue
    if (typeof value === "string") out[key] = value
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value)
    else out[key] = JSON.stringify(value)
  }
  return out
}

function normalizeCoordinationAxesInSettings(settings: Record<string, any>): void {
  const rawCoord = settings.coordination_settings ?? settings.coordinationSettings
  if (!rawCoord || typeof rawCoord !== "object") return
  const normalized = {
    ...rawCoord,
    axes: normalizeStrategyAxes(
      rawCoord.axes && typeof rawCoord.axes === "object" ? rawCoord.axes : undefined,
      settings,
    ),
  }
  settings.coordination_settings = normalized
  settings.coordinationSettings = normalized
}

const PROGRESSION_VISIBLE_SETTING_KEYS = new Set([
  "symbols",
  "active_symbols",
  "force_symbols",
  "symbol_order",
  "symbol_count",
  "is_live_trade",
  "is_testnet",
  "is_preset_trade",
  "connection_method",
  "position_mode",
  "margin_mode",
  "volume_factor_live",
  "live_volume_factor",
  "volume_factor_preset",
  "preset_volume_factor",
  "volume_step_ratio",
  "block_volume_step_ratio",
  "control_orders",
  "variantTrailingEnabled",
  "variantBlockEnabled",
  "variantDcaEnabled",
  "axisPrevEnabled",
  "axisLastEnabled",
  "axisContEnabled",
  "axisPauseEnabled",
  "axisPrevMaxWindow",
  "axisLastMaxWindow",
  "axisContMaxWindow",
  "axisPauseMaxWindow",
  "blockVolumeRatio",
  "blockProfitFactorRatio",
  "blockMaxStack",
  "blockPauseCountRatio",
  "posCountsVolumeRatio",
  "blockActiveRealEnabled",
  "blockActiveLiveEnabled",
  "strategyBaseTrailingEnabled",
  "strategyBaseTrailingVariants",
  "dcaMaxSteps",
  "dcaStepVolumeMultipliers",
  "dcaStepDistancesPct",
  "dcaTakeProfitMode",
  "dcaBreakevenProfitPct",
  "dcaCooldownSeconds",
  "useSystemCloseOnly",
  "use_system_close_only",
  "leveragePercentage",
  "useMaximalLeverage",
])

function pickProgressionVisibleSettings(settings: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (PROGRESSION_VISIBLE_SETTING_KEYS.has(key)) out[key] = value
  }
  return out
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    await initRedis()
    const client = getRedisClient()

    const [connection, trades, positions, connSettingsHashRaw, connSettingsPrefixedRaw, tradeEngineStateRaw] = await Promise.all([
      getConnection(id),
      RedisTrades.getTradesByConnection(id).catch(() => []),
      RedisPositions.getPositionsByConnection(id).catch(() => []),
      // The PATCH route mirrors flat fields (symbol_order, symbol_count,
      // leveragePercentage, useMaximalLeverage, etc.) into the separate
      // `connection_settings:{id}` Redis hash so the engine can read them
      // cheaply. The connection.connection_settings JSON blob only carries
      // the nested coordination/strategy structure saved before this hash
      // mirror existed. We must merge both sources so the dialog can hydrate
      // all saved values on open.
      client.hgetall(`connection_settings:${id}`).catch(() => null),
      // ensureBaseConnections and migrations seed into `settings:connection_settings:{id}`
      // (settings:-prefixed). Fall back to this key when the bare key is empty
      // so the dialog always shows the seeded defaults on first boot.
      client.hgetall(`settings:connection_settings:${id}`).catch(() => null),
      // Migrations 055/057/059 and ensureBaseConnections seed symbol_count,
      // live_volume_factor, symbol_order etc. into settings:trade_engine_state:{id}.
      // Read this as an additional source for fields the other hashes may not have yet.
      client.hgetall(`settings:trade_engine_state:${id}`).catch(() => null),
    ])

    // Merge all three hashes: bare key wins over settings:-prefixed wins over trade_engine_state.
    // This ensures symbol_count and live_volume_factor are always available from the
    // migration-seeded trade_engine_state hash even before the user opens the settings dialog.
    const connSettingsHash: Record<string, string> = {
      ...(tradeEngineStateRaw ?? {}),
      ...(connSettingsPrefixedRaw ?? {}),
      ...(connSettingsHashRaw ?? {}),
    }

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Base: parse the nested JSON blob stored on the connection object.
    const jsonSettings = typeof connection.connection_settings === "string"
      ? (() => { try { return JSON.parse(connection.connection_settings) } catch { return {} } })()
      : connection.connection_settings || {}

    // Overlay the flat hash fields on top of the JSON blob. The hash is the
    // authoritative source for any field the PATCH has mirrored there
    // (prevPosMinCount, leveragePercentage, symbol_order, etc.) because the
    // PATCH always writes both stores. Fields that were only ever saved in the
    // JSON blob (coordination_settings, strategies, profitFactorMin) are
    // carried by the JSON blob and not overwritten by the hash overlay.
    const hashSettings: Record<string, unknown> = {}
    if (connSettingsHash && typeof connSettingsHash === "object") {
      for (const [k, v] of Object.entries(connSettingsHash as Record<string, string>)) {
        // Parse numeric strings back to numbers for fields the dialog expects.
        if ([
          "symbol_count", "symbolCount", "leveragePercentage",
          "prevPosMinCount", "prevPosWindow", "mainEvalPosCount",
          "realEvalPosCount", "minStep", "maxStopLossRatio", "max_stoploss_ratio", "trailingMinStep",
          // Volume / live trading factors
          "live_volume_factor", "volume_factor_live", "preset_volume_factor",
          "volume_step_ratio", "block_volume_step_ratio",
          // Axis max-window values
          "axisPrevMaxWindow", "axisLastMaxWindow", "axisContMaxWindow", "axisPauseMaxWindow",
          // Block strategy tuning
          "blockVolumeRatio", "blockProfitFactorRatio", "blockMaxStack", "blockPauseCountRatio",
          "posCountsVolumeRatio", "dcaMaxSteps", "dcaBreakevenProfitPct", "dcaCooldownSeconds",
          // PF / DDT / stage thresholds
          "baseProfitFactor", "mainProfitFactor", "realProfitFactor", "liveProfitFactor",
          "maxDrawdownTimeMainHours", "maxDrawdownTimeRealHours", "maxDrawdownTimeLiveHours",
          "stageMinPosCountBase", "stageMinPosCountMain", "stageMinPosCountReal",
        ].includes(k)) {
          const n = Number(v)
          hashSettings[k] = Number.isFinite(n) ? n : v
        } else if ([
          "useMaximalLeverage",
          "useSystemCloseOnly", "use_system_close_only",
          // Coordination variant toggles
          "variantTrailingEnabled", "variantBlockEnabled",
          "variantDcaEnabled",
          "blockActiveRealEnabled", "blockActiveLiveEnabled",
          "strategyBaseTrailingEnabled",
          // Axis enable flags
          "axisPrevEnabled", "axisLastEnabled", "axisContEnabled", "axisPauseEnabled",
        ].includes(k)) {
          // Store as boolean so dialog toggle/checkbox checks work correctly.
          hashSettings[k] = v === "true"
        } else if ([
          "symbols", "active_symbols", "force_symbols",
          "strategyBaseTrailingVariants", "dcaStepVolumeMultipliers", "dcaStepDistancesPct",
        ].includes(k)) {
          // Symbols are stored as JSON strings in the hash.
          try { hashSettings[k] = JSON.parse(v) } catch { hashSettings[k] = v }
        } else {
          hashSettings[k] = v
        }
      }
    }

    // Merge: hash fields override JSON blob fields (hash is more recent).
    // Include defaults for newer coordination knobs so existing production
    // connections expose stable values before the first save after upgrade.
    const settings: Record<string, any> = {
      minStep: 5,
      maxStopLossRatio: 2.5,
      trailingMinStep: 6,
      ...jsonSettings,
      ...hashSettings,
    }

    // Rehydrate the canonical nested coordination object from both storage
    // forms. Quick Start and migrations may only have flat HASH fields while
    // the Settings UI consumes `coordination_settings`; without this merge an
    // explicitly saved Block toggle could appear reset on reconnect.
    //
    // The PATCH route mirrors nested objects into the `connection_settings:{id}`
    // hash via serializeConnectionSettingsHash(), which JSON-stringifies them
    // (coordination_settings => "{...}"). That string must be parsed to an
    // object BEFORE spreading: spreading a raw string splays it into a
    // char-indexed object ({'0':'{','1':'"',...}) which breaks
    // coordination.variants.* reads and makes the dialog save throw.
    const parseIfString = (value: unknown): any => {
      if (typeof value === "string") {
        try { return JSON.parse(value) } catch { return undefined }
      }
      return value
    }
    const rawCoord = parseIfString(settings.coordination_settings) ?? parseIfString(settings.coordinationSettings)
    const storedCoord = (rawCoord && typeof rawCoord === "object" ? rawCoord : {}) as Record<string, any>
    const storedVariants = (storedCoord.variants || {}) as Record<string, any>
    const firstDefined = (...values: unknown[]): unknown =>
      values.find((value) => value !== undefined && value !== null && value !== "")
    const asBoolean = (value: unknown, fallback: boolean): boolean => {
      if (value === true || value === "true" || value === 1 || value === "1") return true
      if (value === false || value === "false" || value === 0 || value === "0") return false
      return fallback
    }
    const asBoundedNumber = (value: unknown, fallback: number, min: number, max: number): number => {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
    }
    const dca = normalizeDcaProfile({ ...settings, ...storedCoord })
    const trailingVariants = normalizeTrailingVariants(firstDefined(
      storedCoord.trailingVariants,
      settings.strategyBaseTrailingVariants,
      DEFAULT_TRAILING_VARIANTS,
    ))
    const coordinationSettings = {
      ...storedCoord,
      axes: normalizeStrategyAxes(
        storedCoord.axes && typeof storedCoord.axes === "object" ? storedCoord.axes : undefined,
        settings,
      ),
      variants: {
        ...storedVariants,
        trailing: asBoolean(firstDefined(
          storedVariants.trailing,
          settings.strategyBaseTrailingEnabled,
          settings.variantTrailingEnabled,
          settings.variant_trailing,
          connection.variant_trailing,
        ), true),
        block: asBoolean(firstDefined(
          storedVariants.block,
          settings.variantBlockEnabled,
          settings.variant_block,
          connection.variant_block,
        ), true),
        dca: asBoolean(firstDefined(
          storedVariants.dca,
          settings.variantDcaEnabled,
          settings.variant_dca,
          connection.variant_dca,
        ), false),
      },
      blockVolumeRatio: asBoundedNumber(
        firstDefined(storedCoord.blockVolumeRatio, settings.blockVolumeRatio),
        1.0,
        0.25,
        3.0,
      ),
      blockProfitFactorRatio: asBoundedNumber(
        firstDefined(
          storedCoord.blockProfitFactorRatio,
          storedCoord.blockProfitFactor,
          settings.blockProfitFactorRatio,
          settings.blockProfitFactor,
       ),
        0.8,
        0.2,
        5.0,
      ),
      blockMaxStack: Math.floor(asBoundedNumber(
        firstDefined(storedCoord.blockMaxStack, settings.blockMaxStack),
        10,
        1,
        10,
      )),
      blockPauseCountRatio: Math.round(asBoundedNumber(
        firstDefined(storedCoord.blockPauseCountRatio, settings.blockPauseCountRatio),
        1.0,
        1,
        4,
      ) * 2) / 2,
      blockActiveRealEnabled: asBoolean(firstDefined(
        storedCoord.blockActiveRealEnabled,
        settings.blockActiveRealEnabled,
      ), true),
      blockActiveLiveEnabled: asBoolean(firstDefined(
        storedCoord.blockActiveLiveEnabled,
        settings.blockActiveLiveEnabled,
      ), true),
      posCountsVolumeRatio: asBoundedNumber(
        firstDefined(storedCoord.posCountsVolumeRatio, settings.posCountsVolumeRatio),
        0.05,
        0.01,
        0.25,
      ),
      trailingVariants,
      dcaMaxSteps: dca.maxSteps,
      dcaStepVolumeMultipliers: dca.stepVolumeMultipliers,
      dcaStepDistancesPct: dca.stepDistancesPct,
      dcaTakeProfitMode: dca.takeProfitMode,
      dcaBreakevenProfitPct: dca.breakevenProfitPct,
      dcaCooldownSeconds: dca.cooldownSeconds,
    }
    settings.coordination_settings = coordinationSettings
    settings.coordinationSettings = coordinationSettings

    return NextResponse.json({
      connection: maskConnectionSecrets(connection),
      settings: maskConnectionSettings(settings),
      statistics: {
        active_trades: trades?.length || 0,
        active_positions: positions?.length || 0,
        created_at: connection.created_at,
        updated_at: connection.updated_at,
      },
    })
  } catch (error) {
    console.error("[v0] [Settings] GET error:", error)
    await SystemLogger.logError(error, "api", "GET /api/settings/connections/[id]/settings")
    return NextResponse.json(
      { error: "Failed to fetch settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()

    await initRedis()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Merge settings with existing (like PATCH does)
    const currentSettings: Record<string, any> = typeof connection.connection_settings === "string"
      ? JSON.parse(connection.connection_settings)
      : connection.connection_settings || {}
    const incomingSettings = body.settings && typeof body.settings === "object" ? body.settings : {}
    const mergedSettings = mergeConnectionSettings(currentSettings, incomingSettings)
    normalizeCoordinationAxesInSettings(mergedSettings)
    const hasSymbols = Array.isArray(body.symbols)
    if (hasSymbols) {
      const symbols = body.symbols.map(String).map((symbol: string) => symbol.trim()).filter(Boolean)
      mergedSettings.symbols = symbols
      mergedSettings.force_symbols = symbols
      mergedSettings.active_symbols = symbols
      mergedSettings.symbol_count = symbols.length
    }

    const connectionPatch: Record<string, unknown> = {}
    for (const key of [
      "name", "api_type", "connection_method", "connection_library", "margin_type",
      "position_mode", "is_testnet", "is_enabled", "is_active", "volume_factor",
    ] as const) {
      if (body[key] !== undefined) connectionPatch[key] = body[key]
    }
    if (Object.keys(incomingSettings).length > 0 || hasSymbols) {
      connectionPatch.connection_settings = mergedSettings
    }
    if (hasSymbols) {
      const symbols = mergedSettings.symbols as string[]
      connectionPatch.force_symbols = JSON.stringify(symbols)
      connectionPatch.active_symbols = JSON.stringify(symbols)
      connectionPatch.symbol_count = String(symbols.length)
    }

    const changedFields = Array.from(new Set([
      ...changedSettingKeys(
        connection as Record<string, unknown>,
        { ...connection, ...connectionPatch },
        Object.keys(connectionPatch).filter((key) => key !== "connection_settings"),
      ),
      ...changedSettingKeys(
        currentSettings,
        mergedSettings,
        [...Object.keys(incomingSettings), ...(hasSymbols ? ["symbols", "force_symbols", "active_symbols", "symbol_count"] : [])],
      ),
    ]))

    if (changedFields.length === 0) {
      return NextResponse.json({ success: true, unchanged: true, connection: maskConnectionSecrets(connection) })
    }

    const settingsVersion = `${id}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
    const updatedAt = new Date().toISOString()
    connectionPatch.settings_version = settingsVersion
    connectionPatch.updated_at = updatedAt

    const settingsPatch = Object.keys(incomingSettings).length > 0 || hasSymbols
      ? {
          ...serializeConnectionSettingsHash(mergedSettings),
          settings_version: settingsVersion,
        }
      : {}
    const tradeEngineStatePatch = {
      ...pickProgressionVisibleSettings(settingsPatch),
      ...(hasSymbols ? {
        symbols: JSON.stringify(mergedSettings.symbols),
        force_symbols: JSON.stringify(mergedSettings.symbols),
        active_symbols: JSON.stringify(mergedSettings.symbols),
        symbol_count: String((mergedSettings.symbols as string[]).length),
        config_set_symbols_total: String((mergedSettings.symbols as string[]).length),
      } : {}),
      settings_version: settingsVersion,
      updated_at: updatedAt,
    }

    // One ordered writer persists the connection, flat settings mirrors, and
    // progression-visible state before emitting a single reload envelope.
    const { connection: effectiveConnection, completion: recoordination } =
      await applyMainConnectionSettingsChange(id, connection, {
        connectionPatch,
        settingsPatch,
        tradeEngineStatePatch,
        changedFieldsOverride: changedFields,
        settingsVersion,
        logTag: "PUT /settings",
      })

    await SystemLogger.logConnection(`Updated settings`, id, "info")

    return NextResponse.json({
      success: true,
      connection: maskConnectionSecrets(effectiveConnection),
      recoordination,
    })
  } catch (error) {
    console.error("[v0] [Settings] PUT error:", error)
    await SystemLogger.logError(error, "api", "PUT /api/settings/connections/[id]/settings")
    return NextResponse.json(
      { error: "Failed to update settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const requestSettings = await request.json() as Record<string, any>
    const incomingIndicationChannels = requestSettings.indication_channels
    const settings: Record<string, any> = { ...requestSettings }
    delete settings.indication_channels
    const settingsVersion = `${id}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
    const updatedAt = new Date().toISOString()

    await initRedis()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const current = typeof connection.connection_settings === "string"
      ? JSON.parse(connection.connection_settings)
      : connection.connection_settings || {}

    const merged = mergeConnectionSettings(current, settings)
    normalizeCoordinationAxesInSettings(merged)
    // Keep the canonical nested coordination object in sync with the top-level
    // knob. The Settings UI may send `posCountsVolumeRatio` either at the top
    // level or inside `coordinationSettings`; GET re-derives the value from the
    // nested object, so whichever form arrives must propagate to both stores.
    // Clamp at the source (top-level AND nested) so an out-of-range value can
    // never be persisted into the connection settings or the recoordination
    // snapshot.
    const rawPcvr = Number(merged.posCountsVolumeRatio)
    if (Number.isFinite(rawPcvr) && rawPcvr > 0) {
      const clampedPcvr = Math.max(0.01, Math.min(0.25, rawPcvr))
      merged.posCountsVolumeRatio = clampedPcvr
      const coord = (merged.coordination_settings && typeof merged.coordination_settings === "object"
        ? merged.coordination_settings
        : merged.coordinationSettings) as Record<string, unknown> | undefined
      if (coord && typeof coord === "object") {
        coord.posCountsVolumeRatio = clampedPcvr
      }
    }
    let activeIndicationPatch: Record<string, string> | undefined
    let activeIndicationsChanged = false
    if (incomingIndicationChannels && typeof incomingIndicationChannels === "object") {
      const existingIndications = (await getSettings(`active_indications:${id}`).catch(() => null)) || {}
      const existingMain = readStoredIndicationProfile(
        existingIndications,
        "",
        DEFAULT_MAIN_INDICATION_PROFILE,
      )
      const existingPreset = readStoredIndicationProfile(
        existingIndications,
        "_preset",
        DEFAULT_PRESET_INDICATION_PROFILE,
      )
      const nextMain = normalizeIndicationProfile(incomingIndicationChannels.main, existingMain)
      const nextPreset = normalizeIndicationProfile(incomingIndicationChannels.preset, existingPreset)
      const nextFlat = indicationProfilesToFlat(nextMain, nextPreset)
      activeIndicationsChanged = Object.entries(nextFlat).some(
        ([key, value]) => !settingsValuesEqual((existingIndications as Record<string, unknown>)[key], value),
      )
      activeIndicationPatch = {
        ...nextFlat,
        updated_at: updatedAt,
      }
    }

    const incomingSymbolSource = typeof (settings as Record<string, unknown>).symbol_source === "string"
      ? String((settings as Record<string, unknown>).symbol_source)
      : undefined
    const incomingSymbolsAreFallback = incomingSymbolSource === "fallback"
    const operatorConfirmedSymbols =
      (merged as Record<string, unknown>).symbol_order === "manual" ||
      (settings as Record<string, unknown>).symbols_confirmed === true
    const shouldPreserveActiveSymbols = incomingSymbolsAreFallback && !operatorConfirmedSymbols
    let symbolResolutionWarning: string | undefined

    const updated = {
      ...connection,
      connection_settings: merged,
      // Position mode & margin are first-class connection fields that the
      // engine applies to the exchange connector at startup. Mirror them
      // onto the connection object when the dialog sends them so the next
      // (re)start uses the operator's choice.
      ...(typeof settings.position_mode === "string" ? { position_mode: settings.position_mode } : {}),
      ...(typeof settings.margin_mode === "string" ? { margin_type: settings.margin_mode } : {}),
      // MODE FLAGS (CRITICAL): is_live_trade / is_testnet / is_preset_trade are
      // first-class connection flags read by the engine's live-stage on every
      // cycle (connection.is_live_trade), NOT from connection_settings. The
      // previous code stored them only inside the nested settings JSON, so
      // saving Live Trade through this dialog claimed success but the engine
      // never saw it. Mirror them top-level exactly like position_mode.
      ...(settings.is_live_trade !== undefined ? { is_live_trade: toRedisFlag(settings.is_live_trade) } : {}),
      ...(settings.is_testnet !== undefined ? { is_testnet: toRedisFlag(settings.is_testnet) } : {}),
      ...(settings.is_preset_trade !== undefined ? { is_preset_trade: toRedisFlag(settings.is_preset_trade) } : {}),
      // Mirror symbol_count and force_symbols onto the connection hash so
      // getAllConnections() (and the UI card) always shows the current count.
      ...(settings.symbol_count !== undefined ? { symbol_count: String(Number(settings.symbol_count)) } : {}),
      ...(!shouldPreserveActiveSymbols && Array.isArray(settings.symbols) && settings.symbols.length > 0
        // Non-empty explicit symbol list → write as force_symbols so getSymbols()
        // uses the operator's resolved / auto-selected list immediately.
        ? { force_symbols: JSON.stringify(settings.symbols), symbol_count: String(settings.symbols.length) }
        // Empty or absent symbols + non-manual order → CLEAR force_symbols so
        // getSymbols() falls through to the exchange auto-resolve path.
        // This lets "volatility_1h" / "volume_24h" etc. re-rank on each start.
        : (Array.isArray(settings.symbols) && settings.symbols.length === 0 &&
           typeof settings.symbol_order === "string" && settings.symbol_order !== "manual")
          ? { force_symbols: "" }
          : {}),
      updated_at: new Date().toISOString(),
    }

    // Defer all Redis writes to the single ordered applyMainConnectionSettingsChange() call below.
    // This prevents a running engine from observing partial settings, then falling
    // back to older scoped/legacy mirrors during hot reload or coordinator restart.
    let effectiveConnection = updated

    // ── Symbols → engine symbol source (auto-resolve top-N on save) ─────
    // The dialog saves `symbols` (manual list), `symbol_order` (volume /
    // volatility / newest / manual) and `symbol_count` into
    // `connection_settings`. But the engine's `getSymbols()` reads the
    // ACTIVE list from the connection object's `active_symbols` (and the
    // `trade_engine_state:{id}` hash) — it never looks at
    // `connection_settings.symbols`. So without this bridge a saved symbol
    // selection silently never reached the engine.
    //
    // Behaviour:
    //   • symbol_order === "manual" (or a non-empty `symbols` array with that
    //     order): use the operator's explicit list, truncated to symbol_count.
    //   • otherwise: AUTO-RESOLVE the top-N by the chosen order from the public
    //     exchange ticker API (volume / volatility), N = symbol_count.
    // The resolved list is written to BOTH `active_symbols` on the connection
    // and the `trade_engine_state:{id}` hash, then the live engine's symbol
    // cache is invalidated so the next tick (≤ TTL) picks it up without a
    // restart.
    const normalizeSymbolList = (raw: unknown): string[] => {
      if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean)
      if (typeof raw !== "string") return []
      const s = raw.trim()
      if (!s) return []
      if (s.startsWith("[")) {
        try {
          const parsed = JSON.parse(s)
          return Array.isArray(parsed) ? parsed.map(String).map((x) => x.trim()).filter(Boolean) : []
        } catch { /* fall through to delimiter parsing */ }
      }
      return s.split(/[,|]/).map((x) => x.trim()).filter(Boolean)
    }
    const stableSymbolKey = (symbols: string[]) => symbols.map((s) => s.trim()).filter(Boolean).sort().join("|")
    const beforeForcedSymbols = normalizeSymbolList((connection as Record<string, unknown>).force_symbols)
    const beforeActiveSymbols = normalizeSymbolList((connection as Record<string, unknown>).active_symbols)
    const beforeActiveSymbolKey = stableSymbolKey(beforeForcedSymbols.length > 0 ? beforeForcedSymbols : beforeActiveSymbols)

    const touchedSymbols =
      Array.isArray((settings as Record<string, unknown>).symbols) ||
      typeof (settings as Record<string, unknown>).symbol_order === "string" ||
      (settings as Record<string, unknown>).symbol_count !== undefined

    let resolvedSymbolsForSettings: string[] | null = null
    let finalSymbolOrder = typeof merged.symbol_order === "string" && merged.symbol_order.length > 0
      ? merged.symbol_order
      : "volume_24h"

    if (touchedSymbols) {
      try {
        const rawCount = Number(merged.symbol_count)
        const count = Number.isFinite(rawCount) && rawCount > 0 ? Math.max(1, Math.min(32, Math.floor(rawCount))) : 15
        const manualList = Array.isArray(merged.symbols)
          ? (merged.symbols as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0)
          : []

        let resolved: string[] = []
        let resolutionSource: "live" | "fallback" | "manual" = incomingSymbolsAreFallback ? "fallback" : "live"
        if (operatorConfirmedSymbols && manualList.length > 0) {
          resolved = manualList.length > count ? manualList.slice(0, count) : manualList
          resolutionSource = incomingSymbolsAreFallback ? "fallback" : "manual"
        } else {
          const exchange = String((connection as Record<string, unknown>).exchange || "bingx").toLowerCase()
          const sort = normaliseSort(finalSymbolOrder)
          try {
            const { symbols: topSymbols } = await fetchTopSymbols(exchange, count, sort)
            resolved = topSymbols
              .map((s) => s.symbol)
              .filter((s): s is string => typeof s === "string" && s.length > 0)
              .slice(0, count)
          } catch (fetchErr) {
            console.warn(
              "[v0] [Settings] top-symbols auto-resolve failed:",
              fetchErr instanceof Error ? fetchErr.message : fetchErr,
            )
          }
          // Keep the submitted preview only as a non-destructive fallback.
          // Auto ranking modes must re-query the venue instead of silently
          // becoming a fixed manual list after the first dialog save.
          if (resolved.length === 0 && manualList.length > 0) {
            resolved = manualList.slice(0, count)
            resolutionSource = "fallback"
          }
          if (resolved.length === 0) {
            resolved = FALLBACK_SYMBOLS.slice(0, count)
            resolutionSource = "fallback"
          }
        }

        if (resolutionSource === "fallback" && !operatorConfirmedSymbols) {
          symbolResolutionWarning = "Live symbol ranking failed; the prior active symbol set was preserved. The requested symbol order and count were saved for the next successful recoordination."
          ;(merged as Record<string, unknown>).symbol_source = "fallback"
        } else if (resolved.length > 0) {
          resolvedSymbolsForSettings = resolved
          merged.active_symbols = resolved
          merged.force_symbols = resolved
          merged.symbols = resolved
          merged.symbol_count = resolved.length
          merged.symbol_order = finalSymbolOrder
          console.log(`[v0] [Settings] Resolved ${resolved.length} symbol(s) for ${id} (order=${finalSymbolOrder}): ${resolved.join(", ")}`)
          // Do not persist resolved symbols here. Settings saves must stay
          // single-writer/ordered: the connection hash, settings hashes, and
          // trade-engine state hashes are patched together by
          // applyMainConnectionSettingsChange() below. Writing any one of them
          // early lets the running engine observe a partial snapshot and then
          // fall back to older scoped/legacy settings, which is what made saved
          // settings appear to reset during recoordination.
          ;(merged as Record<string, unknown>).active_symbols = resolved
          ;(merged as Record<string, unknown>).force_symbols = resolved
          ;(merged as Record<string, unknown>).symbol_count = resolved.length
          ;(merged as Record<string, unknown>).symbol_source = resolutionSource
          // 3. Invalidate the running engine's in-memory symbol cache so the
          //    change takes effect on the next tick without a restart.
          try {
            getTradeEngine()?.getEngineManager(id)?.invalidateSymbolsCache()
          } catch { /* engine may not be running yet — state above is enough */ }
          // The authoritative writes above are synchronous. Do not schedule
          // delayed re-assert timers from a settings route: a second dialog save
          // can happen before those timers fire, and the old delayed closure
          // would then overwrite the newer active_symbols/trade_engine_state,
          // making progression appear to switch between old and new settings.
        }
      } catch (symErr) {
        console.error("[v0] [Settings] symbol auto-resolve failed:", symErr)
      }
    }

    merged.settings_version = settingsVersion

    const connectionPatch: Record<string, unknown> = {
      connection_settings: merged,
      settings_version: settingsVersion,
      updated_at: updatedAt,
      ...(typeof settings.position_mode === "string" ? { position_mode: settings.position_mode } : {}),
      ...(typeof settings.margin_mode === "string" ? { margin_type: settings.margin_mode } : {}),
      ...(settings.is_live_trade !== undefined ? { is_live_trade: toRedisFlag(settings.is_live_trade) } : {}),
      ...(settings.is_testnet !== undefined ? { is_testnet: toRedisFlag(settings.is_testnet) } : {}),
      ...(settings.is_preset_trade !== undefined ? { is_preset_trade: toRedisFlag(settings.is_preset_trade) } : {}),
    }

    if (resolvedSymbolsForSettings && resolvedSymbolsForSettings.length > 0) {
      const resolvedSymbolsJson = JSON.stringify(resolvedSymbolsForSettings)
      Object.assign(connectionPatch, {
        active_symbols: resolvedSymbolsJson,
        force_symbols: resolvedSymbolsJson,
        symbol_count: String(resolvedSymbolsForSettings.length),
        symbol_order: finalSymbolOrder,
      })
    } else if (settings.symbol_count !== undefined) {
      const count = Number(settings.symbol_count)
      if (Number.isFinite(count)) connectionPatch.symbol_count = String(count)
    }

    const flatKnobs: Record<string, string> = {}
    const knobKeys = [
      "prevPosMinCount", "prevPosWindow", "mainEvalPosCount", "realEvalPosCount",
      "minStep", "maxStopLossRatio", "trailingMinStep", "posCountsVolumeRatio",
    ] as const
    for (const k of knobKeys) {
      const v = merged[k]
      if (typeof v === "number" && Number.isFinite(v)) {
        flatKnobs[k] = String(v)
        const snake = k.replace(/([A-Z])/g, (m) => "_" + m.toLowerCase())
        if (snake !== k) flatKnobs[snake] = String(v)
      }
    }

    if (typeof merged.symbol_order === "string" && merged.symbol_order.length > 0) flatKnobs.symbol_order = merged.symbol_order
    if (Number.isFinite(Number(merged.symbol_count)) && Number(merged.symbol_count) > 0) {
      flatKnobs.symbol_count = String(Math.floor(Number(merged.symbol_count)))
    }
    for (const key of ["symbols", "active_symbols", "force_symbols"] as const) {
      const value = merged[key]
      if (Array.isArray(value) && value.length > 0) flatKnobs[key] = JSON.stringify(value)
    }
    for (const key of ["position_mode", "margin_mode", "volume_type"] as const) {
      const value = merged[key]
      if (typeof value === "string") flatKnobs[key] = value
    }

    const sco = merged.useSystemCloseOnly ?? merged.use_system_close_only
    if (typeof sco === "boolean") {
      flatKnobs.useSystemCloseOnly = sco ? "true" : "false"
      flatKnobs.use_system_close_only = sco ? "true" : "false"
    }

    const coord = merged.coordination_settings as Record<string, unknown> | undefined
    if (coord && typeof coord === "object") {
      const variantsObj = coord.variants as Record<string, unknown> | undefined
      if (variantsObj && typeof variantsObj === "object") {
        for (const [vk, vv] of Object.entries(variantsObj)) {
          if (typeof vv === "boolean" && ["trailing", "block", "dca"].includes(vk)) {
            flatKnobs[`variant${vk.charAt(0).toUpperCase() + vk.slice(1)}Enabled`] = vv ? "true" : "false"
          }
        }
      }
      const axesObj = coord.axes as Record<string, Record<string, unknown>> | undefined
      if (axesObj && typeof axesObj === "object") {
        for (const [axisKey, axisVal] of Object.entries(axesObj)) {
          if (axisVal && typeof axisVal === "object") {
            const cap = axisKey.charAt(0).toUpperCase() + axisKey.slice(1)
            if (typeof axisVal.enabled === "boolean") flatKnobs[`axis${cap}Enabled`] = axisVal.enabled ? "true" : "false"
            const mw = Number(axisVal.maxWindow)
            if (Number.isFinite(mw) && mw >= 0) flatKnobs[`axis${cap}MaxWindow`] = String(mw)
          }
        }
      }
      const bvr = Number(coord.blockVolumeRatio)
      if (Number.isFinite(bvr) && bvr > 0) flatKnobs.blockVolumeRatio = String(Math.max(0.25, Math.min(3.0, bvr)))
      const bpfr = Number(coord.blockProfitFactorRatio ?? coord.blockProfitFactor)
      if (Number.isFinite(bpfr) && bpfr > 0) flatKnobs.blockProfitFactorRatio = String(Math.max(0.2, Math.min(5.0, bpfr)))
      const bms = Number(coord.blockMaxStack)
      if (Number.isFinite(bms) && bms >= 1) flatKnobs.blockMaxStack = String(Math.min(10, Math.max(1, Math.floor(bms))))
      const bpcr = Number(coord.blockPauseCountRatio)
      if (Number.isFinite(bpcr) && bpcr > 0) flatKnobs.blockPauseCountRatio = String(Math.max(1, Math.min(4, Math.round(bpcr * 2) / 2)))
      if (typeof coord.blockActiveRealEnabled === "boolean") flatKnobs.blockActiveRealEnabled = String(coord.blockActiveRealEnabled)
      if (typeof coord.blockActiveLiveEnabled === "boolean") flatKnobs.blockActiveLiveEnabled = String(coord.blockActiveLiveEnabled)
      const pvr = Number(coord.posCountsVolumeRatio)
      if (Number.isFinite(pvr) && pvr > 0) flatKnobs.posCountsVolumeRatio = String(Math.max(0.01, Math.min(0.25, pvr)))

      const normalizedTrailing = normalizeTrailingVariants(
        coord.trailingVariants ?? merged.strategyBaseTrailingVariants ?? DEFAULT_TRAILING_VARIANTS,
      )
      flatKnobs.strategyBaseTrailingVariants = JSON.stringify(normalizedTrailing)
      const trailingEnabled = parseStoredBoolean(
        (coord.variants as Record<string, unknown> | undefined)?.trailing ?? merged.strategyBaseTrailingEnabled,
        true,
      )
      flatKnobs.strategyBaseTrailingEnabled = trailingEnabled ? "true" : "false"

      const dca = normalizeDcaProfile({ ...merged, ...coord })
      flatKnobs.dcaMaxSteps = String(dca.maxSteps)
      flatKnobs.dcaStepVolumeMultipliers = JSON.stringify(dca.stepVolumeMultipliers)
      flatKnobs.dcaStepDistancesPct = JSON.stringify(dca.stepDistancesPct)
      flatKnobs.dcaTakeProfitMode = dca.takeProfitMode
      flatKnobs.dcaBreakevenProfitPct = String(dca.breakevenProfitPct)
      flatKnobs.dcaCooldownSeconds = String(dca.cooldownSeconds)
    }

    const vfl = Number(merged.volume_factor_live ?? merged.live_volume_factor)
    if (Number.isFinite(vfl) && vfl > 0) {
      flatKnobs.volume_factor_live = String(Math.max(0.1, Math.min(10, vfl)))
      flatKnobs.live_volume_factor = flatKnobs.volume_factor_live
      connectionPatch.live_volume_factor = flatKnobs.volume_factor_live
    }
    const vfp = Number(merged.volume_factor_preset ?? merged.preset_volume_factor)
    if (Number.isFinite(vfp) && vfp > 0) {
      flatKnobs.volume_factor_preset = String(Math.max(0.1, Math.min(10, vfp)))
      flatKnobs.preset_volume_factor = flatKnobs.volume_factor_preset
      connectionPatch.preset_volume_factor = flatKnobs.volume_factor_preset
    }
    const vsr = Number(merged.volume_step_ratio ?? merged.volumeStepRatio)
    if (Number.isFinite(vsr) && vsr > 0) {
      flatKnobs.volume_step_ratio = String(Math.max(0.2, Math.min(1.8, vsr)))
      connectionPatch.volume_step_ratio = flatKnobs.volume_step_ratio
    }
    if (merged.control_orders !== undefined && merged.control_orders !== null) {
      flatKnobs.control_orders = merged.control_orders === true || merged.control_orders === "1" || merged.control_orders === "true" ? "1" : "0"
    }
    const lev = Number(merged.leveragePercentage)
    if (Number.isFinite(lev) && lev > 0) flatKnobs.leveragePercentage = String(Math.max(1, Math.min(100, lev)))
    if (typeof merged.useMaximalLeverage === "boolean") flatKnobs.useMaximalLeverage = merged.useMaximalLeverage ? "true" : "false"

    const strat = merged.strategies as Record<string, Record<string, { min_profit_factor?: number; max_drawdown_time?: number; max_positions?: number }>> | undefined
    const chan = strat?.main
    if (chan) {
      const pf = (raw: unknown): string | null => {
        const n = Number(raw)
        return Number.isFinite(n) && n > 0 ? String(Math.max(0, Math.min(5, n))) : null
      }
      const ddtMinToHr = (raw: unknown): string | null => {
        const n = Number(raw)
        return Number.isFinite(n) && n > 0 ? String(Math.max(1, Math.min(72, n / 60))) : null
      }
      const posCount = (raw: unknown): string | null => {
        const n = Number(raw)
        return Number.isFinite(n) && n > 0 ? String(Math.floor(n)) : null
      }
      for (const [k, v] of [
        ["baseProfitFactor", pf(chan.base?.min_profit_factor)],
        ["mainProfitFactor", pf(chan.main?.min_profit_factor)],
        ["realProfitFactor", pf(chan.real?.min_profit_factor)],
        ["maxDrawdownTimeMainHours", ddtMinToHr(chan.main?.max_drawdown_time)],
        ["maxDrawdownTimeRealHours", ddtMinToHr(chan.real?.max_drawdown_time)],
        ["stageMinPosCountBase", posCount(chan.base?.max_positions)],
        ["stageMinPosCountMain", posCount(chan.main?.max_positions)],
        ["stageMinPosCountReal", posCount(chan.real?.max_positions)],
      ] as Array<[string, string | null]>) if (v !== null) flatKnobs[k] = v
    }

    flatKnobs.settings_version = settingsVersion
    const settingsPatch = {
      ...serializeConnectionSettingsHash(merged),
      ...flatKnobs,
      settings_version: settingsVersion,
    }
    const tradeEngineStatePatch = {
      ...pickProgressionVisibleSettings(settingsPatch),
      ...(resolvedSymbolsForSettings && resolvedSymbolsForSettings.length > 0 ? {
        symbols: JSON.stringify(resolvedSymbolsForSettings),
        active_symbols: JSON.stringify(resolvedSymbolsForSettings),
        force_symbols: JSON.stringify(resolvedSymbolsForSettings),
        symbol_count: String(resolvedSymbolsForSettings.length),
        symbol_order: finalSymbolOrder,
        config_set_symbols_total: String(resolvedSymbolsForSettings.length),
      } : {}),
      settings_version: settingsVersion,
      updated_at: updatedAt,
    }

    const beforeSettings = current as Record<string, unknown>
    const afterSettings = merged as Record<string, unknown>
    const scalarChanged = (key: string, beforeFallback?: unknown, afterFallback?: unknown) => {
      if (!Object.prototype.hasOwnProperty.call(settings, key)) return false
      const beforeValue = beforeSettings[key] ?? beforeFallback ?? ""
      const afterValue = afterSettings[key] ?? afterFallback ?? ""
      return JSON.stringify(beforeValue) !== JSON.stringify(afterValue)
    }
    const symbolListChanged = resolvedSymbolsForSettings !== null && stableSymbolKey(resolvedSymbolsForSettings) !== beforeActiveSymbolKey
    const manualSymbolsChanged =
      Array.isArray((settings as Record<string, unknown>).symbols) &&
      stableSymbolKey(normalizeSymbolList(beforeSettings.symbols).length > 0
        ? normalizeSymbolList(beforeSettings.symbols)
        : (beforeForcedSymbols.length > 0 ? beforeForcedSymbols : beforeActiveSymbols)) !== stableSymbolKey(normalizeSymbolList(afterSettings.symbols))
    const symbolsModeChanged =
      symbolListChanged ||
      manualSymbolsChanged ||
      scalarChanged("symbol_order", (connection as Record<string, unknown>).symbol_order) ||
      scalarChanged("symbol_count", (connection as Record<string, unknown>).symbol_count) ||
      scalarChanged("is_live_trade", (connection as Record<string, unknown>).is_live_trade, connectionPatch.is_live_trade) ||
      scalarChanged("is_testnet", (connection as Record<string, unknown>).is_testnet, connectionPatch.is_testnet) ||
      scalarChanged("is_preset_trade", (connection as Record<string, unknown>).is_preset_trade, connectionPatch.is_preset_trade) ||
      scalarChanged("connection_method", (connection as Record<string, unknown>).connection_method, connectionPatch.connection_method)
    if (symbolsModeChanged) {
      const nextEpoch = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
      Object.assign(connectionPatch, { symbol_selection_epoch: nextEpoch })
      Object.assign(settingsPatch, { symbol_selection_epoch: nextEpoch })
      Object.assign(tradeEngineStatePatch, {
        symbol_selection_epoch: nextEpoch,
        quickstart_symbol_generation: nextEpoch,
        settings_change_marker: updatedAt,
      })
    }

    // Only report fields whose effective values actually changed. The dialog
    // sends a full snapshot; treating every supplied field as changed meant an
    // unchanged `symbols` array triggered a destructive prehistoric reset on
    // every Save. Nested objects are compared canonically (object key order and
    // Redis scalar strings do not create false changes).
    const changedFieldsOverride = changedSettingKeys(
      current as Record<string, unknown>,
      merged as Record<string, unknown>,
      Object.keys(settings),
    )
    if (activeIndicationsChanged) {
      changedFieldsOverride.push("active_indications", "indications")
    }

    const { connection: appliedConnection, completion: recoordination } = await applyMainConnectionSettingsChange(
      id,
      { ...connection, connection_settings: current },
      {
        connectionPatch,
        settingsPatch,
        tradeEngineStatePatch,
        changedFieldsOverride,
        settingsVersion,
        logTag: "PATCH /settings",
        additionalSettingsPatches: activeIndicationPatch && activeIndicationsChanged
          ? [{
              settingsKey: `active_indications:${id}`,
              settingsPatch: activeIndicationPatch,
              mirrorSettingsKey: false,
            }]
          : undefined,
      },
    )
    effectiveConnection = appliedConnection || { ...connection, connection_settings: merged }

    try {
      getTradeEngine()?.getEngineManager(id)?.invalidateSymbolsCache()
    } catch { /* engine may not be running yet — persisted state is enough */ }

    await SystemLogger.logConnection(`Patched settings`, id, "info")

    return NextResponse.json({
      success: true,
      settings: maskConnectionSettings(
        (effectiveConnection as Record<string, unknown>).connection_settings || merged,
      ),
      settingsVersion,
      recoordinationId: settingsVersion,
      progressionEpoch: recoordination.completedAt,
      recoordination,
      refreshQueued: recoordination.refreshQueued === true,
      refreshStatus: recoordination.refreshStatus,
      warning: symbolResolutionWarning,
    })
  } catch (error) {
    console.error("[v0] [Settings] PATCH error:", error)
    await SystemLogger.logError(error, "api", "PATCH /api/settings/connections/[id]/settings")
    return NextResponse.json(
      { error: "Failed to update settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
