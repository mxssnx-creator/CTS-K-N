/**
 * Canonical common-indicator catalogue shared by Settings, the Main engine,
 * and the Preset optimizer. Keeping one catalogue prevents a newly supported
 * indicator from appearing in only one execution path.
 */

export const COMMON_INDICATOR_TYPES = [
  "ma",
  "sma",
  "ema",
  "macd",
  "rsi",
  "bollinger",
  "stochastic",
  "adx",
  "atr",
  "psar",
  "cci",
  "adl",
  "fibonacci",
  "roc",
  "williamsR",
  "obv",
  "vwap",
] as const

export type CommonIndicatorType = (typeof COMMON_INDICATOR_TYPES)[number]

export interface CommonNumericRange {
  from: number
  to: number
  step: number
}

export interface CommonIndicatorSettings {
  enabled: boolean
  interval: number
  timeout: number
  [parameter: string]: boolean | number | CommonNumericRange
}

export interface CommonCoordinationSettings {
  enabled: boolean
  timeframesMinutes: number[]
  rangeSteps: number[]
  drawdownRatios: number[]
  higherRangeDrawdownScale: number
  minAgreement: number
  minimumSignals: number
  shortDifferenceRatio: number
}

export interface CommonIndicationSettingsDocument {
  coordination: CommonCoordinationSettings
  [indicator: string]: CommonCoordinationSettings | CommonIndicatorSettings
}

export interface ParameterDefinition {
  label: string
  default: CommonNumericRange
  min: number
  max: number
  minimumStep: number
}

export interface CommonIndicatorDefinition {
  type: CommonIndicatorType
  storageKey: string
  label: string
  description: string
  enabled: boolean
  parameters: Record<string, ParameterDefinition>
}

const range = (
  label: string,
  from: number,
  to: number,
  step: number,
  min: number,
  max: number,
  minimumStep = step,
): ParameterDefinition => ({
  label,
  default: { from, to, step },
  min,
  max,
  minimumStep,
})

export const COMMON_INDICATOR_DEFINITIONS: readonly CommonIndicatorDefinition[] = [
  {
    type: "ma",
    storageKey: "ma",
    label: "MA",
    description: "Generic moving-average crossover with short and long period ranges.",
    enabled: true,
    parameters: {
      shortPeriod: range("Short period", 3, 15, 2, 2, 100, 1),
      longPeriod: range("Long period", 20, 80, 10, 3, 300, 1),
    },
  },
  {
    type: "sma",
    storageKey: "sma",
    label: "SMA",
    description: "Simple moving-average crossover for stable medium/long-range structure.",
    enabled: true,
    parameters: {
      shortPeriod: range("Short period", 5, 15, 2, 2, 100, 1),
      longPeriod: range("Long period", 25, 75, 10, 3, 300, 1),
    },
  },
  {
    type: "ema",
    storageKey: "ema",
    label: "EMA",
    description: "Exponential moving-average crossover weighted toward recent prices.",
    enabled: true,
    parameters: {
      shortPeriod: range("Short period", 5, 13, 2, 2, 100, 1),
      longPeriod: range("Long period", 18, 34, 4, 3, 300, 1),
    },
  },
  {
    type: "macd",
    storageKey: "macd",
    label: "MACD",
    description: "Fast/slow EMA momentum with an independently ranged signal line.",
    enabled: true,
    parameters: {
      fastPeriod: range("Fast period", 8, 14, 2, 2, 100, 1),
      slowPeriod: range("Slow period", 21, 30, 3, 3, 300, 1),
      signalPeriod: range("Signal period", 7, 11, 2, 2, 100, 1),
    },
  },
  {
    type: "rsi",
    storageKey: "rsi",
    label: "RSI",
    description: "Relative-strength reversals across short and wide oscillator ranges.",
    enabled: true,
    parameters: {
      period: range("Period", 7, 21, 2, 2, 100, 1),
      oversold: range("Oversold", 20, 40, 5, 1, 49, 1),
      overbought: range("Overbought", 60, 80, 5, 51, 99, 1),
    },
  },
  {
    type: "bollinger",
    storageKey: "bollinger",
    label: "Bollinger",
    description: "Mean-reversion bands using ranged periods and standard deviations.",
    enabled: true,
    parameters: {
      period: range("Period", 14, 28, 2, 3, 200, 1),
      stdDev: range("Standard deviation", 1.5, 2.5, 0.25, 0.25, 6, 0.05),
    },
  },
  {
    type: "stochastic",
    storageKey: "stochastic",
    label: "Stochastic",
    description: "Close location inside the recent high/low range.",
    enabled: true,
    parameters: {
      kPeriod: range("%K period", 7, 21, 2, 3, 100, 1),
      dPeriod: range("%D period", 2, 5, 1, 1, 30, 1),
      oversold: range("Oversold", 15, 35, 5, 1, 49, 1),
      overbought: range("Overbought", 65, 85, 5, 51, 99, 1),
    },
  },
  {
    type: "adx",
    storageKey: "adx",
    label: "ADX / ADI",
    description: "Directional movement and trend strength (+DI, -DI, ADX).",
    enabled: true,
    parameters: {
      period: range("Period", 7, 21, 2, 3, 100, 1),
      threshold: range("Trend threshold", 15, 35, 5, 1, 80, 1),
    },
  },
  {
    type: "atr",
    storageKey: "atr",
    label: "ATR",
    description: "Volatility breakout distance normalized by average true range.",
    enabled: true,
    parameters: {
      period: range("Period", 7, 21, 2, 3, 100, 1),
      multiplier: range("Multiplier", 1, 3, 0.5, 0.1, 10, 0.1),
    },
  },
  {
    type: "psar",
    storageKey: "parabolicSAR",
    label: "PSAR",
    description: "Parabolic stop-and-reverse trend with acceleration and maximum ranges.",
    enabled: true,
    parameters: {
      acceleration: range("Acceleration", 0.01, 0.03, 0.005, 0.001, 0.5, 0.001),
      maximum: range("Maximum", 0.1, 0.3, 0.05, 0.01, 1, 0.01),
    },
  },
  {
    type: "cci",
    storageKey: "cci",
    label: "CCI / CCX",
    description: "Commodity Channel Index deviations from the typical-price mean.",
    enabled: true,
    parameters: {
      period: range("Period", 10, 30, 5, 3, 200, 1),
      threshold: range("Absolute threshold", 80, 160, 20, 20, 400, 5),
    },
  },
  {
    type: "adl",
    storageKey: "adl",
    label: "ADL",
    description: "Accumulation/distribution flow using close location and volume.",
    enabled: true,
    parameters: {
      shortPeriod: range("Short smoothing", 3, 10, 1, 2, 100, 1),
      longPeriod: range("Long smoothing", 15, 40, 5, 3, 300, 1),
    },
  },
  {
    type: "fibonacci",
    storageKey: "fibonacci",
    label: "Fibonacci",
    description: "Retracement proximity over configurable lookback and tolerance ranges.",
    enabled: true,
    parameters: {
      lookback: range("Lookback", 13, 55, 7, 3, 500, 1),
      tolerancePct: range("Tolerance %", 0.1, 0.5, 0.1, 0.01, 5, 0.01),
    },
  },
  {
    type: "roc",
    storageKey: "roc",
    label: "ROC",
    description: "Rate-of-change momentum with short-difference thresholds.",
    enabled: true,
    parameters: {
      period: range("Period", 3, 20, 1, 1, 200, 1),
      thresholdPct: range("Threshold %", 0.1, 1, 0.1, 0.01, 20, 0.01),
    },
  },
  {
    type: "williamsR",
    storageKey: "williamsR",
    label: "Williams %R",
    description: "Fast overbought/oversold location across recent high/low ranges.",
    enabled: true,
    parameters: {
      period: range("Period", 7, 21, 2, 3, 100, 1),
      oversold: range("Oversold", -90, -70, 5, -100, -50, 1),
      overbought: range("Overbought", -30, -10, 5, -50, 0, 1),
    },
  },
  {
    type: "obv",
    storageKey: "obv",
    label: "OBV",
    description: "On-balance volume trend with short/long smoothing.",
    enabled: true,
    parameters: {
      shortPeriod: range("Short smoothing", 3, 10, 1, 2, 100, 1),
      longPeriod: range("Long smoothing", 15, 40, 5, 3, 300, 1),
    },
  },
  {
    type: "vwap",
    storageKey: "vwap",
    label: "VWAP",
    description: "Volume-weighted price deviation across short and wide windows.",
    enabled: true,
    parameters: {
      period: range("Period", 5, 30, 5, 2, 300, 1),
      deviationPct: range("Deviation %", 0.1, 1, 0.1, 0.01, 20, 0.01),
    },
  },
] as const

export const DEFAULT_COMMON_COORDINATION_SETTINGS: CommonCoordinationSettings = {
  enabled: true,
  timeframesMinutes: [1, 5, 15, 30],
  rangeSteps: [2, 2.5, 3],
  drawdownRatios: [1, 1.5, 2],
  higherRangeDrawdownScale: 0.5,
  minAgreement: 0.6,
  minimumSignals: 3,
  shortDifferenceRatio: 0.1,
}

export const DEFAULT_COMMON_INDICATION_SETTINGS: CommonIndicationSettingsDocument = {
  coordination: DEFAULT_COMMON_COORDINATION_SETTINGS,
  ...Object.fromEntries(COMMON_INDICATOR_DEFINITIONS.map((definition) => [
    definition.storageKey,
    {
      enabled: definition.enabled,
      interval: 60,
      timeout: 3,
      ...Object.fromEntries(Object.entries(definition.parameters).map(([key, value]) => [key, value.default])),
    },
  ])),
}

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 1 || value === "1" || value === "true") return true
  if (value === false || value === 0 || value === "0" || value === "false") return false
  return fallback
}

function numericList(
  value: unknown,
  fallback: readonly number[],
  min: number,
  max: number,
): number[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,|]+/)
      : []
  const result = [...new Set(raw
    .map(Number)
    .filter(Number.isFinite)
    .map((item) => clamp(item, min, max)))]
  return result.length > 0 ? result : [...fallback]
}

export function expandCommonNumericRange(range: CommonNumericRange): number[] {
  const from = Number(range.from)
  const to = Number(range.to)
  const step = Number(range.step)
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(step) || step <= 0) {
    return []
  }
  const lower = Math.min(from, to)
  const upper = Math.max(from, to)
  const values: number[] = []
  for (let value = lower; value <= upper + Number.EPSILON; value += step) {
    values.push(Number(value.toFixed(8)))
  }
  return values
}

/**
 * Full parameter Cartesian product for one Common indicator. Invalid logical
 * tuples (for example short >= long or oversold >= overbought) are excluded;
 * no representative sampling or top-K ceiling is applied.
 */
export function commonIndicatorParameterConfigurations(
  definition: CommonIndicatorDefinition,
  settings: CommonIndicatorSettings,
): Array<Record<string, number>> {
  const entries = Object.keys(definition.parameters).map((key) => {
    const configured = settings?.[key] as CommonNumericRange | undefined
    const values = expandCommonNumericRange(
      configured || definition.parameters[key].default,
    )
    return [key, values] as const
  })
  let combinations: Array<Record<string, number>> = [{}]
  for (const [key, values] of entries) {
    combinations = combinations.flatMap((combination) =>
      values.map((value) => ({ ...combination, [key]: value })),
    )
  }
  return combinations.filter((parameters) => {
    const short = parameters.shortPeriod
    const long = parameters.longPeriod
    if (Number.isFinite(short) && Number.isFinite(long) && short >= long) return false
    const fast = parameters.fastPeriod
    const slow = parameters.slowPeriod
    if (Number.isFinite(fast) && Number.isFinite(slow) && fast >= slow) return false
    const oversold = parameters.oversold
    const overbought = parameters.overbought
    if (Number.isFinite(oversold) && Number.isFinite(overbought) && oversold >= overbought) return false
    const acceleration = parameters.acceleration
    const maximum = parameters.maximum
    if (Number.isFinite(acceleration) && Number.isFinite(maximum) && acceleration > maximum) return false
    return true
  })
}

export function normalizeCommonIndicationSettings(raw: unknown): CommonIndicationSettingsDocument {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const coordinationRaw = source.coordination && typeof source.coordination === "object"
    ? source.coordination as Record<string, unknown>
    : {}
  const normalized: CommonIndicationSettingsDocument = {
    coordination: {
      enabled: bool(coordinationRaw.enabled, DEFAULT_COMMON_COORDINATION_SETTINGS.enabled),
      timeframesMinutes: numericList(
        coordinationRaw.timeframesMinutes,
        DEFAULT_COMMON_COORDINATION_SETTINGS.timeframesMinutes,
        1,
        60,
      ).map((value) => Math.round(value)).sort((left, right) => left - right),
      rangeSteps: numericList(
        coordinationRaw.rangeSteps,
        DEFAULT_COMMON_COORDINATION_SETTINGS.rangeSteps,
        0.5,
        10,
      ).sort((left, right) => left - right),
      drawdownRatios: numericList(
        coordinationRaw.drawdownRatios,
        DEFAULT_COMMON_COORDINATION_SETTINGS.drawdownRatios,
        0.1,
        20,
      ).sort((left, right) => left - right),
      higherRangeDrawdownScale: clamp(
        finite(
          coordinationRaw.higherRangeDrawdownScale,
          DEFAULT_COMMON_COORDINATION_SETTINGS.higherRangeDrawdownScale,
        ),
        0,
        5,
      ),
      minAgreement: clamp(
        finite(coordinationRaw.minAgreement, DEFAULT_COMMON_COORDINATION_SETTINGS.minAgreement),
        0.5,
        1,
      ),
      minimumSignals: Math.round(clamp(
        finite(coordinationRaw.minimumSignals, DEFAULT_COMMON_COORDINATION_SETTINGS.minimumSignals),
        1,
        COMMON_INDICATOR_TYPES.length,
      )),
      shortDifferenceRatio: clamp(
        finite(coordinationRaw.shortDifferenceRatio, DEFAULT_COMMON_COORDINATION_SETTINGS.shortDifferenceRatio),
        0,
        5,
      ),
    },
  }

  for (const definition of COMMON_INDICATOR_DEFINITIONS) {
    const candidate = source[definition.storageKey] && typeof source[definition.storageKey] === "object"
      ? source[definition.storageKey] as Record<string, unknown>
      : {}
    const settings: CommonIndicatorSettings = {
      enabled: bool(candidate.enabled, definition.enabled),
      interval: clamp(finite(candidate.interval, 60), 0.1, 3_600),
      timeout: clamp(finite(candidate.timeout, 3), 0, 3_600),
    }
    for (const [key, parameter] of Object.entries(definition.parameters)) {
      const candidateRange = candidate[key] && typeof candidate[key] === "object"
        ? candidate[key] as Record<string, unknown>
        : {}
      const step = clamp(
        finite(candidateRange.step, parameter.default.step),
        parameter.minimumStep,
        Math.max(parameter.minimumStep, parameter.max - parameter.min),
      )
      let from = clamp(finite(candidateRange.from ?? candidateRange.min, parameter.default.from), parameter.min, parameter.max)
      let to = clamp(finite(candidateRange.to ?? candidateRange.max, parameter.default.to), parameter.min, parameter.max)
      if (from > to) [from, to] = [to, from]
      settings[key] = { from, to, step }
    }
    normalized[definition.storageKey] = settings
  }
  return normalized
}

export function enabledCommonIndicatorTypes(settings: CommonIndicationSettingsDocument): CommonIndicatorType[] {
  return COMMON_INDICATOR_DEFINITIONS
    .filter((definition) => (settings[definition.storageKey] as CommonIndicatorSettings)?.enabled !== false)
    .map((definition) => definition.type)
}
