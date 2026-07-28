import { DEFAULT_MAIN_COORDINATION_SETTINGS } from "@/lib/multi-range-coordination"

export const DEFAULT_MAIN_INDICATION_SETTINGS = {
  marketActivity: {
    enabled: true,
    minPriceChange: 0.1,
    minVolatility: 0.05,
    checkInterval: 1,
    activationThreshold: 0.2,
    deactivationThreshold: 0.05,
    calculationRange: 10,
    calculationFrame: 1,
    positionCostRatioIndex: 2,
  },
  configuration: {
    sample_ranges: Array.from({ length: 29 }, (_, index) => index + 2),
    drawdown_ratios: [0.5, 1, 1.5],
    last_part_ratios: [0.25, 0.5],
    factor_multipliers: [0.9, 1, 1.1],
    active_thresholds: [0.5, 1, 1.5, 2, 2.5],
    active_time_ratios: [0.5, 1],
  },
  coordination: {
    enabled: true,
    ranges: [...DEFAULT_MAIN_COORDINATION_SETTINGS.timeframesMinutes],
    range_steps: [...DEFAULT_MAIN_COORDINATION_SETTINGS.rangeSteps],
    drawdown_ratios: [...DEFAULT_MAIN_COORDINATION_SETTINGS.drawdownRatios],
    higher_range_drawdown_scale: DEFAULT_MAIN_COORDINATION_SETTINGS.higherRangeDrawdownScale,
    min_agreement: DEFAULT_MAIN_COORDINATION_SETTINGS.minAgreement,
    minimum_signals: DEFAULT_MAIN_COORDINATION_SETTINGS.minimumSignals,
    short_difference_ratio: DEFAULT_MAIN_COORDINATION_SETTINGS.shortDifferenceRatio,
    direction_post_change_only: true,
  },
  direction: {
    enabled: true,
    range: { from: 2, to: 30, step: 1 },
    sample_ranges: Array.from({ length: 29 }, (_, index) => index + 2),
    drawdown_ratio: { from: 0.5, to: 1.5, step: 0.5 },
    market_change_range: { from: 1, to: 10, step: 2 },
    market_change_lastpart_base: 20,
    market_change_lastpart_ratios: { from: 0.25, to: 0.5, step: 0.25 },
    min_calculation_time: 3,
    interval: 1,
    timeout: 0.25,
  },
  move: {
    enabled: true,
    range: { from: 2, to: 30, step: 1 },
    sample_ranges: Array.from({ length: 29 }, (_, index) => index + 2),
    drawdown_ratio: { from: 0.5, to: 1.5, step: 0.5 },
    market_change_range: { from: 1, to: 10, step: 2 },
    market_change_lastpart_base: 20,
    market_change_lastpart_ratios: { from: 0.25, to: 0.5, step: 0.25 },
    min_calculation_time: 3,
    interval: 1,
    timeout: 0.25,
  },
  active: {
    enabled: true,
    range: { from: 1, to: 10, step: 1 },
    activity_calculated: { from: 10, to: 90, step: 10 },
    activity_lastpart: { from: 10, to: 90, step: 10 },
    thresholds: [0.5, 1, 1.5, 2, 2.5],
    time_ratios: [0.5, 1],
    market_change_range: { from: 1, to: 10, step: 1 },
    market_change_lastpart_base: 20,
    market_change_lastpart_ratios: { from: 0.25, to: 0.5, step: 0.25 },
    interval: 1,
    timeout: 0.25,
    min_calculation_time: 3,
  },
  active_advanced: {
    enabled: true,
    activity_values: [0.5, 1, 1.5, 2, 2.5, 3],
    activity_ratios: { from: 0.5, to: 3, step: 0.5 },
    min_positions: 3,
    continuation_ratio: 0.6,
    min_volatility: 0.1,
    max_drawdown: 5,
  },
  optimal: {
    enabled: true,
    range: { from: 2, to: 30, step: 1 },
    sample_ranges: Array.from({ length: 29 }, (_, index) => index + 2),
    drawdown_ratio: { from: 0.5, to: 1.5, step: 0.5 },
    market_change_range: { from: 1, to: 10, step: 2 },
    market_change_lastpart_base: 20,
    market_change_lastpart_ratios: { from: 0.25, to: 0.5, step: 0.25 },
    min_calculation_time: 3,
    base_positions_limit: 250,
    interval: 2,
    timeout: 0.25,
    trailing_optimal_ranges: true,
  },
} as const

type Document = Record<string, any>

function object(value: unknown): Document {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Document
    : {}
}

function parseStoredDocument(raw: unknown): Document {
  if (typeof raw !== "string") return object(raw)
  try {
    return object(JSON.parse(raw))
  } catch {
    return {}
  }
}

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bool(value: unknown, fallback = true): boolean {
  if (value === true || value === 1 || value === "1" || value === "true") return true
  if (value === false || value === 0 || value === "0" || value === "false") return false
  return fallback
}

function numericList(value: unknown, fallback: readonly number[]): number[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,|]+/)
      : []
  const result = [...new Set(source.map(Number).filter(Number.isFinite))]
  return result.length > 0 ? result : [...fallback]
}

function expandRange(value: unknown, fallback: readonly number[]): number[] {
  const range = object(value)
  const from = Number(range.from)
  const to = Number(range.to)
  const step = Number(range.step)
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(step) || step <= 0 || to < from) {
    return [...fallback]
  }
  const result: number[] = []
  for (let current = from; current <= to + Number.EPSILON; current += step) {
    result.push(Number(current.toFixed(8)))
  }
  return result.length > 0 ? result : [...fallback]
}

function mergeSection(defaultValue: unknown, sourceValue: unknown): Document {
  const defaults = object(defaultValue)
  const source = object(sourceValue)
  const merged: Document = { ...defaults, ...source }
  for (const [key, value] of Object.entries(defaults)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      merged[key] = { ...object(value), ...object(source[key]) }
    }
  }
  return merged
}

export function normalizeMainIndicationSettings(raw: unknown): Document {
  const source = parseStoredDocument(raw)
  const defaults = DEFAULT_MAIN_INDICATION_SETTINGS as unknown as Document
  return {
    ...defaults,
    ...source,
    marketActivity: mergeSection(defaults.marketActivity, source.marketActivity),
    configuration: mergeSection(defaults.configuration, source.configuration),
    coordination: mergeSection(defaults.coordination, source.coordination),
    direction: mergeSection(defaults.direction, source.direction),
    move: mergeSection(defaults.move, source.move),
    active: mergeSection(defaults.active, source.active),
    active_advanced: mergeSection(defaults.active_advanced, source.active_advanced),
    optimal: mergeSection(defaults.optimal, source.optimal),
  }
}

export function applyCanonicalSettingsToMainDocument(
  rawDocument: unknown,
  rawAppSettings: unknown,
): Document {
  const document = normalizeMainIndicationSettings(rawDocument)
  const app = object(rawAppSettings)
  const sampleRanges = numericList(
    app.indicationSampleRanges,
    document.configuration.sample_ranges,
  )
  const optimalRanges = numericList(app.optimalSampleRanges, sampleRanges)
  const advancedValues = numericList(
    app.activeAdvancedActivityRatios,
    document.active_advanced.activity_values,
  )

  return {
    ...document,
    marketActivity: {
      ...document.marketActivity,
      enabled: bool(app.marketActivityEnabled, document.marketActivity.enabled),
      calculationRange: finite(
        app.marketActivityCalculationRange,
        document.marketActivity.calculationRange,
      ),
      positionCostRatioIndex: finite(
        app.marketActivityPositionCostRatio,
        document.marketActivity.positionCostRatioIndex,
      ),
    },
    configuration: {
      ...document.configuration,
      sample_ranges: sampleRanges,
      drawdown_ratios: numericList(
        app.indicationDrawdownRatios,
        document.configuration.drawdown_ratios,
      ),
      last_part_ratios: numericList(
        app.indicationLastPartRatios,
        document.configuration.last_part_ratios,
      ),
      factor_multipliers: numericList(
        app.indicationFactorMultipliers,
        document.configuration.factor_multipliers,
      ),
      active_thresholds: numericList(
        app.activeThresholds,
        document.configuration.active_thresholds,
      ),
      active_time_ratios: numericList(
        app.activeTimeRatios,
        document.configuration.active_time_ratios,
      ),
    },
    coordination: {
      ...document.coordination,
      enabled: bool(app.defaultCoordinationEnabled, document.coordination.enabled),
      ranges: numericList(app.defaultCoordinationRanges, document.coordination.ranges),
      range_steps: numericList(app.defaultCoordinationRangeSteps, document.coordination.range_steps),
      drawdown_ratios: numericList(
        app.defaultCoordinationDrawdownRatios,
        document.coordination.drawdown_ratios,
      ),
      higher_range_drawdown_scale: finite(
        app.defaultCoordinationHigherRangeDrawdownScale,
        document.coordination.higher_range_drawdown_scale,
      ),
      min_agreement: finite(app.defaultCoordinationMinAgreement, document.coordination.min_agreement),
      minimum_signals: finite(
        app.defaultCoordinationMinimumSignals,
        document.coordination.minimum_signals,
      ),
      short_difference_ratio: finite(
        app.defaultCoordinationShortDifferenceRatio,
        document.coordination.short_difference_ratio,
      ),
      direction_post_change_only: bool(
        app.directionPostChangeOnly,
        document.coordination.direction_post_change_only,
      ),
    },
    direction: {
      ...document.direction,
      enabled: bool(app.directionEnabled, document.direction.enabled),
      sample_ranges: sampleRanges,
    },
    move: {
      ...document.move,
      enabled: bool(app.moveEnabled, document.move.enabled),
      sample_ranges: sampleRanges,
    },
    active: {
      ...document.active,
      enabled: bool(app.activeEnabled, document.active.enabled),
      thresholds: numericList(app.activeThresholds, document.active.thresholds),
      time_ratios: numericList(app.activeTimeRatios, document.active.time_ratios),
    },
    active_advanced: {
      ...document.active_advanced,
      enabled: bool(app.activeAdvancedEnabled, document.active_advanced.enabled),
      activity_values: advancedValues,
      min_positions: finite(
        app.activeAdvancedMinPositions,
        document.active_advanced.min_positions,
      ),
      continuation_ratio: finite(
        app.activeAdvancedContinuationRatio,
        document.active_advanced.continuation_ratio,
      ),
    },
    optimal: {
      ...document.optimal,
      enabled: bool(app.optimalEnabled, document.optimal.enabled),
      sample_ranges: optimalRanges,
      base_positions_limit: finite(
        app.optimalBasePositionsLimit,
        document.optimal.base_positions_limit,
      ),
    },
  }
}

export function mainDocumentToCanonicalSettings(raw: unknown): Document {
  const document = normalizeMainIndicationSettings(raw)
  const configuration = object(document.configuration)
  const coordination = object(document.coordination)
  const direction = object(document.direction)
  const move = object(document.move)
  const active = object(document.active)
  const advanced = object(document.active_advanced)
  const optimal = object(document.optimal)
  const sampleRanges = numericList(
    configuration.sample_ranges ?? direction.sample_ranges,
    expandRange(direction.range, DEFAULT_MAIN_INDICATION_SETTINGS.configuration.sample_ranges),
  )
  const optimalRanges = numericList(
    optimal.sample_ranges,
    expandRange(optimal.range, sampleRanges),
  )
  const advancedValues = numericList(
    advanced.activity_values,
    expandRange(
      advanced.activity_ratios,
      DEFAULT_MAIN_INDICATION_SETTINGS.active_advanced.activity_values,
    ),
  )

  return {
    marketActivityEnabled: bool(document.marketActivity?.enabled, true),
    marketActivityCalculationRange: finite(document.marketActivity?.calculationRange, 10),
    marketActivityPositionCostRatio: finite(document.marketActivity?.positionCostRatioIndex, 2),
    directionEnabled: bool(direction.enabled, true),
    moveEnabled: bool(move.enabled, true),
    activeEnabled: bool(active.enabled, true),
    activeAdvancedEnabled: bool(advanced.enabled, true),
    optimalEnabled: bool(optimal.enabled, true),
    indicationSampleRanges: sampleRanges,
    optimalSampleRanges: optimalRanges,
    indicationDrawdownRatios: numericList(
      configuration.drawdown_ratios,
      DEFAULT_MAIN_INDICATION_SETTINGS.configuration.drawdown_ratios,
    ),
    indicationLastPartRatios: numericList(
      configuration.last_part_ratios,
      DEFAULT_MAIN_INDICATION_SETTINGS.configuration.last_part_ratios,
    ),
    indicationFactorMultipliers: numericList(
      configuration.factor_multipliers,
      DEFAULT_MAIN_INDICATION_SETTINGS.configuration.factor_multipliers,
    ),
    activeThresholds: numericList(
      configuration.active_thresholds ?? active.thresholds,
      DEFAULT_MAIN_INDICATION_SETTINGS.configuration.active_thresholds,
    ),
    activeTimeRatios: numericList(
      configuration.active_time_ratios ?? active.time_ratios,
      DEFAULT_MAIN_INDICATION_SETTINGS.configuration.active_time_ratios,
    ),
    activeAdvancedActivityRatios: advancedValues,
    activeAdvancedMinPositions: Math.max(2, Math.round(finite(advanced.min_positions, 3))),
    activeAdvancedContinuationRatio: Math.max(
      0,
      Math.min(1, finite(advanced.continuation_ratio, 0.6)),
    ),
    activeAdvancedMinVolatility: Math.max(0, finite(advanced.min_volatility, 0.1)),
    activeAdvancedMaxDrawdown: Math.max(0, finite(advanced.max_drawdown, 5)),
    optimalBasePositionsLimit: Math.max(
      1,
      Math.round(finite(optimal.base_positions_limit, 250)),
    ),
    directionRangeFrom: finite(direction.range?.from, sampleRanges[0] ?? 2),
    directionRangeTo: finite(direction.range?.to, sampleRanges[sampleRanges.length - 1] ?? 30),
    directionRangeStep: Math.max(0.000001, finite(direction.range?.step, 1)),
    optimalRangeStart: finite(optimal.range?.from, optimalRanges[0] ?? 2),
    optimalRangeEnd: finite(optimal.range?.to, optimalRanges[optimalRanges.length - 1] ?? 30),
    optimalRangeStep: Math.max(0.000001, finite(optimal.range?.step, 1)),
    defaultCoordinationEnabled: bool(coordination.enabled, true),
    defaultCoordinationRanges: numericList(
      coordination.ranges,
      DEFAULT_MAIN_COORDINATION_SETTINGS.timeframesMinutes,
    ),
    defaultCoordinationRangeSteps: numericList(
      coordination.range_steps,
      DEFAULT_MAIN_COORDINATION_SETTINGS.rangeSteps,
    ),
    defaultCoordinationDrawdownRatios: numericList(
      coordination.drawdown_ratios,
      DEFAULT_MAIN_COORDINATION_SETTINGS.drawdownRatios,
    ),
    defaultCoordinationHigherRangeDrawdownScale: Math.max(
      0,
      finite(
        coordination.higher_range_drawdown_scale,
        DEFAULT_MAIN_COORDINATION_SETTINGS.higherRangeDrawdownScale,
      ),
    ),
    defaultCoordinationMinAgreement: Math.max(
      0.5,
      Math.min(1, finite(coordination.min_agreement, DEFAULT_MAIN_COORDINATION_SETTINGS.minAgreement)),
    ),
    defaultCoordinationMinimumSignals: Math.max(
      1,
      Math.round(finite(coordination.minimum_signals, DEFAULT_MAIN_COORDINATION_SETTINGS.minimumSignals)),
    ),
    defaultCoordinationShortDifferenceRatio: Math.max(
      0,
      finite(
        coordination.short_difference_ratio,
        DEFAULT_MAIN_COORDINATION_SETTINGS.shortDifferenceRatio,
      ),
    ),
    directionPostChangeOnly: bool(coordination.direction_post_change_only, true),
  }
}
