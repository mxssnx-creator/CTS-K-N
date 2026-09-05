const SYMBOL_AFFECTING_SETTING_FIELDS = new Set([
  "active_symbols",
  "activeSymbols",
  "selected_symbols",
  "symbols",
  "symbol_selection_epoch",
  "symbol_mode",
  "symbolMode",
  "exchange_order_by",
  "exchangeOrderBy",
  "symbol_limit",
  "symbolLimit",
  "symbol_count",
  "symbolCount",
  "symbol_order",
  "force_symbols",
  "useMainSymbols",
  "mainSymbols",
])

const STRATEGY_AFFECTING_SETTING_FIELDS = new Set([
  "profitFactorMin",
  "baseProfitFactor",
  "mainProfitFactor",
  "realProfitFactor",
  "liveProfitFactor",
  "maxDrawdownTimeMainHours",
  "maxDrawdownTimeRealHours",
  "maxDrawdownTimeLiveHours",
  "stageMinPosCountBase",
  "stageMinPosCountMain",
  "stageMinPosCountReal",
  "variantTrailingEnabled",
  "variantBlockEnabled",
  "normalEnabled",
  "blockOnlyEnabled",
  "variantDcaEnabled",
  "strategyBaseTrailingEnabled",
  "strategyBaseTrailingVariants",
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
  "blockIncrementSteps",
  "blockMaxStack",
  "blockPauseCountRatio",
  "blockActiveRealEnabled",
  "blockActiveLiveEnabled",
  "blockRowLiveEnabled",
  "blockRowLiveVolumeRatio",
  "blockRowLiveProfitFactorRatio",
  "blockRowLiveIncrementSteps",
  "blockRowLiveMaxStack",
  "blockRowLivePauseCountRatio",
  "blockRowRealEvalPosCount",
  "dcaMaxSteps",
  "dcaStepVolumeMultipliers",
  "dcaStepDistancesPct",
  "dcaTakeProfitMode",
  "dcaBreakevenProfitPct",
  "dcaCooldownSeconds",
  "dcaMaxPositionVolumeRatio",
  "minimal_step_count",
  "minimalStepCount",
  "minStep",
  "trailingMinStep",
  "prevPosWindow",
  "prevPosMinCount",
  "mainEvalPosCount",
  "realEvalPosCount",
  "liveEvalPosCount",
  "volume_factor",
  "live_volume_factor",
  "preset_volume_factor",
  "signal_volume_factor",
  "volume_factor_live",
  "volume_factor_preset",
  "volume_factor_signal",
  "mainTradeVolumeFactor",
  "main_trade_volume_factor",
  "presetTradeVolumeFactor",
  "preset_trade_volume_factor",
  "signalTradeVolumeFactor",
  "signal_trade_volume_factor",
  "signalVolumeFactor",
  "signal_indication",
  "volume_step_ratio",
  "leveragePercentage",
  "useMaximalLeverage",
  "maxLeverage",
  "useSystemCloseOnly",
  "use_system_close_only",
  "margin_type",
  "position_mode",
  "control_orders",
  "control_orders_enabled",
  "controlOrdersEnabled",
  "defaultCoordinationEnabled",
  "defaultCoordinationRanges",
  "defaultCoordinationRangeSteps",
  "defaultCoordinationDrawdownRatios",
  "defaultCoordinationHigherRangeDrawdownScale",
  "defaultCoordinationMinAgreement",
  "defaultCoordinationMinimumSignals",
  "defaultCoordinationShortDifferenceRatio",
  "directionPostChangeOnly",
  "ctsGTrendEnabled", "ctsGTrendMinimumSpreadRatio", "ctsGMinimumConfidence",
  "breakEnabled", "breakRange", "breakNoisePct", "dcaTrendBreakPriority",
  "trendEnabled",
  "trendTimeframesMinutes",
  "trendDrawdownValues",
  "trendDrawdownFactors",
  "trendLastSituationRatios",
  "trendActiveSituationRatios",
  "trendMinAgreement",
  "trendCombinedEnabled",
  "trendRangeSteps",
  "trendHigherRangeDrawdownScale",
  "trendTpMinMultiplier",
  "trendTpMaxFactor",
  "trendTpStep",
  "databaseSizeTrend",
  "positionCost",
  "system_settings",
])

// These fields alter how a future exchange order is sized or protected, but
// they do not change the historic indication/strategy graph.  A hot reload
// must still invalidate the relevant caches immediately; scheduling a whole
// ind+strat pass while that graph is bootstrapping, however, can monopolise a
// single-process production server and make a simple volume-slider save look
// stuck.  Keep the classification deliberately narrow: mixed changes retain
// the normal immediate strategy re-evaluation path.
const LIVE_SIZING_ONLY_SETTING_FIELDS = new Set([
  "volume_factor",
  "live_volume_factor",
  "preset_volume_factor",
  "signal_volume_factor",
  "volume_factor_live",
  "volume_factor_preset",
  "volume_factor_signal",
  "mainTradeVolumeFactor",
  "main_trade_volume_factor",
  "presetTradeVolumeFactor",
  "preset_trade_volume_factor",
  "signalTradeVolumeFactor",
  "signal_trade_volume_factor",
  "signalVolumeFactor",
  "volume_step_ratio",
])

function normalizeNestedConnectionSettingField(field: string): string {
  return field.startsWith("connection_settings.")
    ? field.slice("connection_settings.".length)
    : field
}

export function isGenericConnectionSettingsReload(fields: readonly string[]): boolean {
  return fields.length === 0 || fields.some((field) => field === "connection_settings" || field === "system_settings")
}

export function hasSymbolAffectingChange(fields: readonly string[]): boolean {
  return fields.some((field) => {
    if (SYMBOL_AFFECTING_SETTING_FIELDS.has(field)) return true
    if (field.startsWith("connection_settings.")) {
      const nested = field.slice("connection_settings.".length)
      return SYMBOL_AFFECTING_SETTING_FIELDS.has(nested)
    }
    return false
  })
}

export function hasStrategyAffectingChange(fields: readonly string[]): boolean {
  return fields.some((field) => {
    if (field === "strategies" || field === "coordination_settings") return true
    if (STRATEGY_AFFECTING_SETTING_FIELDS.has(field)) return true
    if (field.startsWith("connection_settings.")) {
      const nested = field.slice("connection_settings.".length)
      return nested === "strategies" || nested === "coordination_settings" || STRATEGY_AFFECTING_SETTING_FIELDS.has(nested)
    }
    return false
  })
}

/**
 * True only when every changed field is an execution-sizing value.  This is
 * intentionally separate from `hasStrategyAffectingChange`: sizing is a
 * strategy input, but it is not a reason to run a heavyweight immediate
 * historic/Main re-evaluation before the normal next cycle.
 */
export function isLiveSizingOnlyChange(fields: readonly string[]): boolean {
  return fields.length > 0 && fields.every((field) =>
    LIVE_SIZING_ONLY_SETTING_FIELDS.has(normalizeNestedConnectionSettingField(field)),
  )
}
