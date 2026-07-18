type FingerprintInput = {
  connectionId: string
  engineType?: string | null
  connData?: Record<string, unknown> | null
  tradeEngineState?: Record<string, unknown> | null
  connectionSettings?: Record<string, unknown> | null
}

export const progressionFingerprintFields = [
  "force_symbols", "symbols", "active_symbols",
  "baseProfitFactor", "mainProfitFactor", "realProfitFactor", "liveProfitFactor", "profitFactorMin",
  "maxDrawdownTimeMainHours", "maxDrawdownTimeRealHours", "maxDrawdownTimeLiveHours",
  "stageMinPosCountBase", "stageMinPosCountMain", "stageMinPosCountReal",
  "variantTrailingEnabled", "variantBlockEnabled", "variantDcaEnabled",
  "strategyBaseTrailingEnabled", "strategyBaseTrailingVariants", "trailingMinStep",
  "axisPrevEnabled", "axisLastEnabled", "axisContEnabled", "axisPauseEnabled",
  "axisPrevMaxWindow", "axisLastMaxWindow", "axisContMaxWindow", "axisPauseMaxWindow",
  "blockVolumeRatio", "blockProfitFactorRatio", "blockMaxStack", "blockPauseCountRatio",
  "minimal_step_count", "minimalStepCount", "minStep", "maxStopLossRatio", "max_stoploss_ratio",
  "prevPosWindow", "prevPosMinCount", "mainEvalPosCount", "realEvalPosCount",
  "live_volume_factor", "preset_volume_factor", "volume_factor_live", "volume_factor_preset",
  "volume_step_ratio", "volume_factor", "leveragePercentage", "useMaximalLeverage", "maxLeverage",
  "margin_type", "position_mode",
  "useSystemCloseOnly", "use_system_close_only", "useSystemClose", "system_close_enabled",
  "controlOrdersEnabled", "control_orders_enabled", "useControlOrders", "use_control_orders",
  "coordination_settings", "strategies", "indications", "active_indications",
]

function parseSymbols(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean)
  if (typeof value !== "string") return []
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed.map(String).map((s) => s.trim()).filter(Boolean)
  } catch {}
  return trimmed.split(",").map((s) => s.trim()).filter(Boolean)
}

function normalizeScalar(value: unknown): unknown {
  if (value === undefined || value === null) return ""
  if (typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true"
  if (/^-?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) {
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) return numeric
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try { return normalizeValue(JSON.parse(trimmed)) } catch {}
  }
  return trimmed
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, normalizeValue(val)]))
  }
  return normalizeScalar(value)
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeValue(value))
}

export function buildProgressionFingerprint(input: FingerprintInput): string {
  const connData = input.connData || {}
  const state = input.tradeEngineState || {}
  const settings = input.connectionSettings || {}
  const get = (key: string, fallback: unknown = "") =>
    (settings as any)[key] ?? (state as any)[key] ?? (connData as any)[key] ?? fallback

  let symbols = parseSymbols(get("force_symbols"))
  if (symbols.length === 0) symbols = parseSymbols(get("active_symbols"))
  if (symbols.length === 0) symbols = parseSymbols(get("symbols"))
  symbols = Array.from(new Set(symbols)).sort()

  return stableStringify({
    connectionId: input.connectionId,
    symbols,
    engineType: input.engineType || "main",
    is_live_trade: get("is_live_trade", "0"),
    is_testnet: get("is_testnet", "0"),
    is_preset_trade: get("is_preset_trade", "0"),
    connection_method: get("connection_method", "library"),
    margin_type: get("margin_type", "cross"),
    position_mode: get("position_mode", "hedge"),
    settings: Object.fromEntries(progressionFingerprintFields.map((field) => [field, get(field)])),
  })
}

export function buildProgressionFingerprintSettings(input: Omit<FingerprintInput, "connectionId">): Record<string, unknown> {
  const connData = input.connData || {}
  const state = input.tradeEngineState || {}
  const settings = input.connectionSettings || {}
  const get = (key: string, fallback: unknown = "") => normalizeValue((settings as any)[key] ?? (state as any)[key] ?? (connData as any)[key] ?? fallback)
  return Object.fromEntries(progressionFingerprintFields.map((field) => [field, get(field)]))
}
