import {
  COMMON_INDICATOR_DEFINITIONS,
  DEFAULT_COMMON_INDICATION_SETTINGS,
  commonIndicatorParameterConfigurations,
  enabledCommonIndicatorTypes,
  normalizeCommonIndicationSettings,
} from "@/lib/common-indicator-config"
import {
  DEFAULT_MAIN_COORDINATION_SETTINGS,
} from "@/lib/multi-range-coordination"
import {
  DEFAULT_TREND_ACTIVE_SITUATION_RATIOS,
  DEFAULT_TREND_DRAWDOWN_FACTORS,
  DEFAULT_TREND_LAST_SITUATION_RATIOS,
  DEFAULT_TREND_RANGE_STEPS,
  normalizeTrendTimeframesMinutes,
} from "@/lib/trend-indication"
import {
  SIGNAL_SOURCE_DEFINITIONS,
} from "@/lib/signal-source-registry"
import { buildSignalTradeConfigurations } from "@/lib/signal-config-matrix"

export type IndicationConfigurationType =
  | "direction"
  | "move"
  | "active"
  | "active_advanced"
  | "optimal"
  | "auto"
  | "signal"
  | "trend"
  | "common"

export interface IndicationConfigurationCount {
  type: IndicationConfigurationType
  label: string
  group: "default" | "additional" | "common"
  storage: "independent_set" | "runtime"
  possibleSets: number
  evaluationConfigurations: number
  formula: string
  params: Record<string, string | number>
  description: string
}

export interface IndicationConfigurationCountResult {
  totalPossibleSets: number
  totalEvaluationConfigurations: number
  perSetDbCapacity: number
  maxStorablePositions: number
  settings: {
    indicationRangeMin: number
    indicationRangeMax: number
    indicationRangeStep: number
    takeProfitRangeDivisor: number
    validRangeCount: number
    optimalBasePositionsLimit: number
    commonTimeframes: number[]
    enabledCommonIndicators: number
    enabledSignalSources: number
  }
  types: IndicationConfigurationCount[]
}

function bool(value: unknown, fallback = true): boolean {
  if (value === true || value === 1 || value === "1" || value === "true") return true
  if (value === false || value === 0 || value === "0" || value === "false") return false
  return fallback
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function positiveInteger(value: unknown, fallback: number): number {
  return Math.max(1, Math.floor(positiveNumber(value, fallback)))
}

function numericList(value: unknown, fallback: readonly number[]): number[] {
  let source: unknown[] = []
  if (Array.isArray(value)) source = value
  else if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      source = Array.isArray(parsed) ? parsed : value.split(/[\s,|]+/)
    } catch {
      source = value.split(/[\s,|]+/)
    }
  }
  const normalized = [...new Set(source.map(Number).filter(Number.isFinite))]
  return normalized.length > 0 ? normalized : [...fallback]
}

function numericRange(
  fromRaw: unknown,
  toRaw: unknown,
  stepRaw: unknown,
  fallback: readonly number[],
): number[] {
  const from = Number(fromRaw)
  const to = Number(toRaw)
  const step = Number(stepRaw)
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(step) || step <= 0 || to < from) {
    return [...fallback]
  }
  const values: number[] = []
  for (let value = from; value <= to + Number.EPSILON; value += step) {
    values.push(Number(value.toFixed(8)))
  }
  return values.length > 0 ? values : [...fallback]
}

/**
 * Browser-safe projection of the Signal settings needed solely for the
 * topology calculator.  The complete Signal normalizer persists and reads
 * Redis performance state, so importing it from a client-rendered demo would
 * incorrectly pull the Node Redis client into the browser bundle.
 *
 * Keep this narrow projection aligned with the public defaults: it describes
 * source enablement and the input matrix only; it never decides execution.
 */
type SignalConfigurationCountSettings = {
  enabled: boolean
  directExecutionEnabled: boolean
  trailingEnabled: boolean
  trailingOnly: boolean
  maxSourcesPerCycle: number
  minimumSourceSignals: number
  sources: Record<string, { enabled: boolean }>
}

function normalizeSignalConfigurationCountSettings(
  input: unknown,
): SignalConfigurationCountSettings {
  const raw = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
  const rawSources = raw.sources && typeof raw.sources === "object" && !Array.isArray(raw.sources)
    ? raw.sources as Record<string, unknown>
    : {}
  const sources = Object.fromEntries(SIGNAL_SOURCE_DEFINITIONS.map((source) => {
    const candidate = rawSources[source.id]
    const configured = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : {}
    return [source.id, { enabled: bool(configured.enabled, source.enabledByDefault) }]
  })) as Record<string, { enabled: boolean }>
  const maxSourcesPerCycle = Math.round(Math.max(
    3,
    Math.min(35, positiveNumber(raw.maxSourcesPerCycle, 10)),
  ))
  const minimumSourceSignals = Math.min(
    maxSourcesPerCycle,
    Math.round(Math.max(2, Math.min(20, positiveNumber(raw.minimumSourceSignals, 3)))),
  )
  const trailingOnly = bool(raw.trailingOnly, false)
  return {
    enabled: bool(raw.enabled, true),
    directExecutionEnabled: bool(raw.directExecutionEnabled, true),
    trailingEnabled: trailingOnly || bool(raw.trailingEnabled, true),
    trailingOnly,
    maxSourcesPerCycle,
    minimumSourceSignals,
    sources,
  }
}

function activeAdvancedRatios(settings: Record<string, any>, fallback: readonly number[]): number[] {
  const nested = settings.active_advanced || settings.activeAdvanced
  const candidate = nested?.activity_ratios || settings.activeAdvancedActivityRatios
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return numericRange(candidate.from, candidate.to, candidate.step, fallback)
  }
  if (candidate !== undefined) return numericList(candidate, fallback)
  return numericRange(
    settings.activeAdvancedActivityRatiosFrom,
    settings.activeAdvancedActivityRatiosTo,
    settings.activeAdvancedActivityRatiosStep,
    fallback,
  )
}

export function calculateIndicationConfigurationCounts(
  rawSettings: unknown,
  rawCommonSettings: unknown,
  rawSignalSettings?: unknown,
): IndicationConfigurationCountResult {
  const settings = rawSettings && typeof rawSettings === "object"
    ? rawSettings as Record<string, any>
    : {}
  const fallbackRanges = Array.from({ length: 29 }, (_, index) => index + 2)
  const fallbackFactors = [0.9, 1, 1.1]
  const fallbackThresholds = [0.5, 1, 1.5, 2, 2.5]
  const fallbackAdvanced = [0.5, 1, 1.5, 2, 2.5, 3]

  const ranges = settings.indicationSampleRanges !== undefined
    ? numericList(settings.indicationSampleRanges, fallbackRanges).filter((value) => value > 0)
    : numericRange(
        settings.directionRangeStart ?? settings.directionRangeFrom,
        settings.directionRangeEnd ?? settings.directionRangeTo,
        settings.directionRangeStep,
        fallbackRanges,
      )
  const optimalRanges = settings.optimalSampleRanges !== undefined
    ? numericList(settings.optimalSampleRanges, ranges).filter((value) => value > 0)
    : numericRange(
        settings.optimalRangeStart,
        settings.optimalRangeEnd,
        settings.optimalRangeStep,
        ranges,
      )
  const drawdowns = numericList(settings.indicationDrawdownRatios, [0.5, 1, 1.5])
  const lastParts = numericList(settings.indicationLastPartRatios, [0.25, 0.5])
  const factors = numericList(settings.indicationFactorMultipliers, fallbackFactors)
  const activeThresholds = numericList(settings.activeThresholds, fallbackThresholds)
  const activeTimes = numericList(settings.activeTimeRatios, [0.5, 1])
  const advancedRatios = activeAdvancedRatios(settings, fallbackAdvanced)
  const defaultCoordinationSteps = numericList(
    settings.defaultCoordinationRangeSteps,
    DEFAULT_MAIN_COORDINATION_SETTINGS.rangeSteps,
  ).filter((value) => value > 0)
  const defaultCoordinationVariants = bool(settings.defaultCoordinationEnabled, true)
    ? Math.max(1, defaultCoordinationSteps.length)
    : 0

  const directionGrid = ranges.length * drawdowns.length * lastParts.length * factors.length
  const activeGrid =
    activeThresholds.length * drawdowns.length * activeTimes.length * lastParts.length * factors.length
  const advancedGrid = advancedRatios.length * factors.length
  const optimalGrid = optimalRanges.length * factors.length

  const trendEnabled = bool(settings.trendEnabled, true)
  const trendTimeframes = normalizeTrendTimeframesMinutes(settings.trendTimeframesMinutes)
  const trendDrawdowns = numericList(
    settings.trendDrawdownValues,
    DEFAULT_TREND_DRAWDOWN_FACTORS,
  ).map((value) => value > 0 ? -value : value).filter((value) => value < 0)
  const trendLast = numericList(
    settings.trendLastSituationRatios,
    DEFAULT_TREND_LAST_SITUATION_RATIOS,
  ).filter((value) => value > 0)
  const trendActive = numericList(
    settings.trendActiveSituationRatios,
    DEFAULT_TREND_ACTIVE_SITUATION_RATIOS,
  ).filter((value) => value > 0)
  const trendRangeSteps = numericList(
    settings.trendRangeSteps,
    DEFAULT_TREND_RANGE_STEPS,
  ).filter((value) => value > 0)
  const trendGrid = trendEnabled
    ? trendTimeframes.length * trendDrawdowns.length * trendLast.length * trendActive.length
    : 0
  const trendCombinedEvaluations = trendEnabled && bool(settings.trendCombinedEnabled, true) ? 1 : 0
  const trendCombinedSetVariants = trendCombinedEvaluations > 0
    ? Math.max(1, trendRangeSteps.length)
    : 0

  const commonSettings = normalizeCommonIndicationSettings(
    rawCommonSettings || DEFAULT_COMMON_INDICATION_SETTINGS,
  )
  const enabledCommon = enabledCommonIndicatorTypes(commonSettings)
  const commonTimeframes = commonSettings.coordination.timeframesMinutes
  const commonVariantsByType = Object.fromEntries(
    COMMON_INDICATOR_DEFINITIONS
      .filter((definition) => enabledCommon.includes(definition.type))
      .map((definition) => [
        definition.type,
        commonIndicatorParameterConfigurations(
          definition,
          commonSettings[definition.storageKey] as any,
        ).length,
      ]),
  ) as Record<string, number>
  const commonParameterVariants = Object.values(commonVariantsByType)
    .reduce((sum, count) => sum + count, 0)
  const commonEvaluations = commonTimeframes.length * commonParameterVariants
  const signalSettings = normalizeSignalConfigurationCountSettings(rawSignalSettings)
  const enabledSignalSources = Object.values(signalSettings.sources)
    .filter((source) => source.enabled)
    .length
  const selectedSignalSources = signalSettings.enabled
    ? Math.min(enabledSignalSources, signalSettings.maxSourcesPerCycle)
    : 0
  // Source rows always remain independent. `directExecutionEnabled` is the
  // exact-config bootstrap bypass, not a switch that removes source rows.
  const signalDirectInputs = selectedSignalSources
  const signalConsensusInputs =
    selectedSignalSources >= signalSettings.minimumSourceSignals ? 1 : 0
  const signalEvaluationInputs = signalDirectInputs + signalConsensusInputs
  const signalPossibleDirectInputs = enabledSignalSources
  const signalPossibleConsensusInputs =
    enabledSignalSources >= signalSettings.minimumSourceSignals ? 1 : 0
  const signalPossibleInputs =
    signalPossibleDirectInputs + signalPossibleConsensusInputs
  const signalTradeConfigurations = buildSignalTradeConfigurations({
    trailingEnabled: signalSettings.trailingEnabled,
    trailingOnly: signalSettings.trailingOnly,
  }).length

  const setCount = (grid: number, dynamicVariants = 0) => (grid + dynamicVariants) * 2
  const types: IndicationConfigurationCount[] = [
    {
      type: "direction",
      label: "Direction",
      group: "default",
      storage: "independent_set",
      possibleSets: bool(settings.directionEnabled, true)
        ? setCount(directionGrid, defaultCoordinationVariants)
        : 0,
      evaluationConfigurations: bool(settings.directionEnabled, true) ? directionGrid + 1 : 0,
      formula: `${ranges.length} ranges × ${drawdowns.length} drawdowns × ${lastParts.length} last × ${factors.length} factors`,
      params: {
        ranges: ranges.length,
        drawdowns: drawdowns.length,
        lastParts: lastParts.length,
        factors: factors.length,
        relativeStepVariants: defaultCoordinationVariants,
      },
      description: "Post-reversal direction grid plus independent same-market-direction relative ranges.",
    },
    {
      type: "move",
      label: "Move",
      group: "default",
      storage: "independent_set",
      possibleSets: bool(settings.moveEnabled, true)
        ? setCount(directionGrid, defaultCoordinationVariants)
        : 0,
      evaluationConfigurations: bool(settings.moveEnabled, true) ? directionGrid + 1 : 0,
      formula: `${ranges.length} ranges × ${drawdowns.length} drawdowns × ${lastParts.length} last × ${factors.length} factors`,
      params: {
        ranges: ranges.length,
        drawdowns: drawdowns.length,
        lastParts: lastParts.length,
        factors: factors.length,
        relativeStepVariants: defaultCoordinationVariants,
      },
      description: "Independent movement grid; higher sample ranges remain additional to the base calculation.",
    },
    {
      type: "active",
      label: "Active",
      group: "default",
      storage: "independent_set",
      possibleSets: bool(settings.activeEnabled, true)
        ? setCount(activeGrid, defaultCoordinationVariants)
        : 0,
      evaluationConfigurations: bool(settings.activeEnabled, true) ? activeGrid + 1 : 0,
      formula: `${activeThresholds.length} thresholds × ${drawdowns.length} drawdowns × ${activeTimes.length} time ratios × ${lastParts.length} last × ${factors.length} factors`,
      params: {
        thresholds: activeThresholds.length,
        drawdowns: drawdowns.length,
        activeTimes: activeTimes.length,
        lastParts: lastParts.length,
        factors: factors.length,
        relativeStepVariants: defaultCoordinationVariants,
      },
      description: "Activity grid with independent direction and volume/activity conditions.",
    },
    {
      type: "active_advanced",
      label: "Active Advanced",
      group: "default",
      storage: "independent_set",
      possibleSets: bool(settings.activeAdvancedEnabled, true) ? setCount(advancedGrid) : 0,
      evaluationConfigurations: bool(settings.activeAdvancedEnabled, true) ? advancedGrid : 0,
      formula: `${advancedRatios.length} activity ratios × ${factors.length} factors`,
      params: {
        activityRatios: advancedRatios.length,
        factors: factors.length,
      },
      description: "Independent continuation/activity situations.",
    },
    {
      type: "optimal",
      label: "Optimal",
      group: "additional",
      storage: "independent_set",
      possibleSets: bool(settings.optimalEnabled, true) ? setCount(optimalGrid) : 0,
      evaluationConfigurations: bool(settings.optimalEnabled, true) ? optimalGrid : 0,
      formula: `${optimalRanges.length} ranges × ${factors.length} factors`,
      params: { ranges: optimalRanges.length, factors: factors.length },
      description: "Independent consecutive-step situations.",
    },
    {
      type: "auto",
      label: "Auto",
      group: "additional",
      storage: "runtime",
      possibleSets: 0,
      evaluationConfigurations: bool(settings.autoEnabled, true) ? 1 : 0,
      formula: `${commonTimeframes.length} common timeframes → one coordinated Auto result`,
      params: { timeframes: commonTimeframes.length, minimumSignals: commonSettings.coordination.minimumSignals },
      description: "Runtime aggregate of Common indicator votes and higher-range coordination.",
    },
    {
      type: "signal",
      label: "Signal",
      group: "common",
      storage: "independent_set",
      possibleSets:
        signalSettings.enabled
          ? signalPossibleInputs * signalTradeConfigurations * 2
          : 0,
      evaluationConfigurations: signalEvaluationInputs,
      formula:
        `${signalPossibleInputs} enabled source/consensus inputs × ` +
        `${signalTradeConfigurations} TP/SL/trailing configs × 2 directions`,
      params: {
        enabledSources: enabledSignalSources,
        selectedSourcesPerCycle: selectedSignalSources,
        directSourceInputs: signalDirectInputs,
        consensusInputs: signalConsensusInputs,
        possibleSourceInputs: signalPossibleInputs,
        registrySources: Object.keys(signalSettings.sources).length,
        tradeConfigurations: signalTradeConfigurations,
        sourcePerformanceLookback: 12,
        symbolDirectionPerformanceLookback: 10,
      },
      description:
        "Independent source × symbol × direction × TP/SL/trailing Sets; " +
        "sources use the newest 12 closes and source/symbol/direction lanes the newest 10.",
    },
    {
      type: "trend",
      label: "Trend",
      group: "additional",
      storage: "independent_set",
      possibleSets: setCount(trendGrid, trendCombinedSetVariants),
      evaluationConfigurations: trendGrid + trendCombinedEvaluations,
      formula: `${trendTimeframes.length} timeframes × ${trendDrawdowns.length} drawdowns × ${trendLast.length} last × ${trendActive.length} active`,
      params: {
        timeframes: trendTimeframes.length,
        drawdowns: trendDrawdowns.length,
        lastSituations: trendLast.length,
        activeSituations: trendActive.length,
        combinedStepVariants: trendCombinedSetVariants,
      },
      description: "Trend-only 1/5/15/30-minute situations plus the optional combined higher-range result.",
    },
    {
      type: "common",
      label: "Common",
      group: "common",
      storage: "independent_set",
      possibleSets: commonEvaluations * 2,
      evaluationConfigurations: commonEvaluations,
      formula: `${commonParameterVariants} complete indicator parameter tuples × ${commonTimeframes.length} timeframes`,
      params: {
        enabledIndicators: enabledCommon.length,
        availableIndicators: COMMON_INDICATOR_DEFINITIONS.length,
        timeframes: commonTimeframes.join("/"),
        parameterVariants: commonParameterVariants,
      },
      description: "Official technical indicators with every valid configured parameter tuple and independent Long/Short Sets.",
    },
  ]

  const totalPossibleSets = types.reduce((sum, type) => sum + type.possibleSets, 0)
  const totalEvaluationConfigurations = types.reduce(
    (sum, type) => sum + type.evaluationConfigurations,
    0,
  )
  const perSetDbCapacity = positiveInteger(
    settings.optimalBasePositionsLimit ?? settings.strategyMaxEntriesPerSet,
    250,
  )
  return {
    totalPossibleSets,
    totalEvaluationConfigurations,
    perSetDbCapacity,
    maxStorablePositions: totalPossibleSets * perSetDbCapacity,
    settings: {
      indicationRangeMin: ranges[0] ?? 2,
      indicationRangeMax: ranges[ranges.length - 1] ?? 30,
      indicationRangeStep: positiveNumber(settings.directionRangeStep, 1),
      takeProfitRangeDivisor: positiveInteger(settings.takeProfitRangeDivisor, 3),
      validRangeCount: ranges.length,
      optimalBasePositionsLimit: perSetDbCapacity,
      commonTimeframes,
      enabledCommonIndicators: enabledCommon.length,
      enabledSignalSources,
    },
    types,
  }
}
