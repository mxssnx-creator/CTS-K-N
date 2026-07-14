const SYMBOL_AFFECTING_SETTING_FIELDS = new Set([
  "active_symbols",
  "activeSymbols",
  "symbols",
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
  "blockMaxStack",
  "blockPauseCountRatio",
  "blockActiveRealEnabled",
  "blockActiveLiveEnabled",
  "dcaMaxSteps",
  "dcaStepVolumeMultipliers",
  "dcaStepDistancesPct",
  "dcaTakeProfitMode",
  "dcaBreakevenProfitPct",
  "dcaCooldownSeconds",
  "minimal_step_count",
  "minimalStepCount",
  "minStep",
  "trailingMinStep",
  "prevPosWindow",
  "prevPosMinCount",
  "mainEvalPosCount",
  "realEvalPosCount",
  "volume_factor",
  "volume_factor_live",
  "volume_factor_preset",
  "volume_step_ratio",
  "leveragePercentage",
  "useMaximalLeverage",
  "maxLeverage",
  "useSystemCloseOnly",
  "use_system_close_only",
  "margin_type",
  "position_mode",
])

export function isGenericConnectionSettingsReload(fields: readonly string[]): boolean {
  return fields.length === 0 || fields.some((field) => field === "connection_settings")
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
