import type { EffectiveTradeDirection } from "@/lib/directional-evaluation"

/**
 * Hard safety limits for the Special indication/strategy family.
 *
 * These limits intentionally live below the Settings/UI layer. Imported,
 * legacy, or connection-overridden values therefore cannot create more than
 * five logical legs per direction, exceed three times the Base volume, use a
 * calculation range below three observations, or place SL farther than three
 * TP distances from the coordinated entry.
 */
export const SPECIAL_MIN_STEP = 3
export const SPECIAL_MAX_POSITIONS_PER_DIRECTION = 5
export const SPECIAL_MAX_VOLUME_RATIO = 3
export const SPECIAL_MAX_SL_TO_TP_RATIO = 3
export const SPECIAL_MAX_HOLDING_SECONDS = 90 * 60
export const SPECIAL_TIMEFRAMES_SECONDS = [15, 60, 15 * 60, 30 * 60] as const
export type SpecialExitVariant = "fixed" | "trailing"

export interface SpecialStrategySettings {
  enabled: boolean
  minStep: number
  maxStep: number
  stepSize: number
  activeWindow: number
  minimumEvidence: number
  minimumAgreement: number
  minimumMarketChangePct: number
  minimumScore: number
  noiseFilterPct: number
  momentumWeight: number
  activityWeight: number
  volatilityWeight: number
  marketChangeSpeedWeight: number
  minimumMarketChangeSpeedRatio: number
  maximumMarketChangeSpeedPctPerSecond: number
  scenarioCoordinationEnabled: boolean
  scenarioWeight: number
  scenarioMinimumScore: number
  pastActivityPersistenceMinimum: number
  activityBreakoutRatio: number
  reversalAccelerationMinimumPct: number
  activityLookback: number
  minimumActivityRatio: number
  marketActivityFadeRatio: number
  maximumVolatilityPct: number
  volatilityTargetPct: number
  minimumVolatilityVolumeScale: number
  orderFlowWeight: number
  minimumDirectionalOrderFlow: number
  requireOrderFlowConfirmation: boolean
  maximumSpreadBps: number
  minimumHoldingSteps: number
  maximumHoldingSteps: number
  minimumHoldingSeconds: number
  targetHoldingSeconds: number
  maximumHoldingSeconds: number
  timeframe15sEnabled: boolean
  timeframe1mEnabled: boolean
  timeframe15mEnabled: boolean
  timeframe30mEnabled: boolean
  individualTimeframesEnabled: boolean
  combinedTimeframesEnabled: boolean
  minimumTimeframeConfirmations: number
  minimumCombinedScoreMargin: number
  requireHigherTimeframeAlignment: boolean
  timeframe15sWeight: number
  timeframe1mWeight: number
  timeframe15mWeight: number
  timeframe30mWeight: number
  maxPositionsPerDirection: number
  additionalPositionStepPositionCostRatio: number
  volumeIncrementRatio: number
  maxVolumeRatio: number
  takeProfitMinPositionCostRatio: number
  takeProfitMaxPositionCostRatio: number
  takeProfitVolatilityMultiplier: number
  takeProfitMarketChangeMultiplier: number
  stopLossMinPositionCostRatio: number
  stopLossVolatilityMultiplier: number
  stopLossMaxTakeProfitRatio: number
  /** Evaluate/publish the fixed TP+SL lane as its own configuration. */
  nonTrailingVariantEnabled: boolean
  /** Evaluate/publish the active trailing lane as its own configuration. */
  trailingEnabled: boolean
  trailingAdaptiveEnabled: boolean
  trailingVolatilityAdaptationWeight: number
  trailingSpeedAdaptationWeight: number
  trailingActivityAdaptationWeight: number
  trailingScenarioAdaptationWeight: number
  trailingActivationTakeProfitRatio: number
  trailingDistanceTakeProfitRatio: number
  trailingStepTakeProfitRatio: number
  roundTripCostPct: number
  minimumTakeProfitAfterCostsRatio: number
  backtestMinimumTrades: number
  backtestMinimumTradesPerDirection: number
  backtestMinimumTradesPerSymbol: number
  backtestMinimumStableProfitFactor: number
  backtestMaximumDrawdownPct: number
  walkForwardFolds: number
  walkForwardPurgeSteps: number
  walkForwardMaximumFoldLossPct: number
}

export const DEFAULT_SPECIAL_STRATEGY_SETTINGS: Readonly<SpecialStrategySettings> = Object.freeze({
  enabled: true,
  minStep: SPECIAL_MIN_STEP,
  maxStep: 30,
  stepSize: 1,
  activeWindow: 5,
  minimumEvidence: 3,
  minimumAgreement: 0.62,
  // 0.16% conservative round-trip cost × 1.5 safety ratio. Signals below
  // the economic break-even envelope are noise, not executable indications.
  minimumMarketChangePct: 0.24,
  minimumScore: 1,
  noiseFilterPct: 0.01,
  momentumWeight: 0.45,
  activityWeight: 0.35,
  volatilityWeight: 0.2,
  marketChangeSpeedWeight: 0.35,
  minimumMarketChangeSpeedRatio: 0.5,
  maximumMarketChangeSpeedPctPerSecond: 5,
  scenarioCoordinationEnabled: true,
  scenarioWeight: 0.25,
  scenarioMinimumScore: 0.4,
  pastActivityPersistenceMinimum: 0.55,
  activityBreakoutRatio: 1.2,
  reversalAccelerationMinimumPct: 0.01,
  activityLookback: 20,
  minimumActivityRatio: 1.05,
  marketActivityFadeRatio: 0.75,
  maximumVolatilityPct: 3,
  volatilityTargetPct: 0.25,
  minimumVolatilityVolumeScale: 0.25,
  orderFlowWeight: 0.35,
  minimumDirectionalOrderFlow: 0.05,
  requireOrderFlowConfirmation: false,
  maximumSpreadBps: 25,
  minimumHoldingSteps: 3,
  maximumHoldingSteps: 30,
  minimumHoldingSeconds: 3,
  targetHoldingSeconds: 2 * 60,
  maximumHoldingSeconds: 15 * 60,
  timeframe15sEnabled: true,
  timeframe1mEnabled: true,
  timeframe15mEnabled: true,
  timeframe30mEnabled: true,
  individualTimeframesEnabled: true,
  combinedTimeframesEnabled: true,
  minimumTimeframeConfirmations: 2,
  minimumCombinedScoreMargin: 0.15,
  requireHigherTimeframeAlignment: false,
  timeframe15sWeight: 1.4,
  timeframe1mWeight: 1.2,
  timeframe15mWeight: 1,
  timeframe30mWeight: 0.8,
  maxPositionsPerDirection: SPECIAL_MAX_POSITIONS_PER_DIRECTION,
  additionalPositionStepPositionCostRatio: 3,
  volumeIncrementRatio: 0.5,
  maxVolumeRatio: SPECIAL_MAX_VOLUME_RATIO,
  takeProfitMinPositionCostRatio: 3,
  takeProfitMaxPositionCostRatio: 22,
  takeProfitVolatilityMultiplier: 1.5,
  takeProfitMarketChangeMultiplier: 1,
  stopLossMinPositionCostRatio: 0.75,
  stopLossVolatilityMultiplier: 1.25,
  stopLossMaxTakeProfitRatio: SPECIAL_MAX_SL_TO_TP_RATIO,
  nonTrailingVariantEnabled: true,
  trailingEnabled: true,
  trailingAdaptiveEnabled: true,
  trailingVolatilityAdaptationWeight: 0.25,
  trailingSpeedAdaptationWeight: 0.25,
  trailingActivityAdaptationWeight: 0.2,
  trailingScenarioAdaptationWeight: 0.3,
  trailingActivationTakeProfitRatio: 0.5,
  trailingDistanceTakeProfitRatio: 0.25,
  trailingStepTakeProfitRatio: 0.125,
  roundTripCostPct: 0.16,
  minimumTakeProfitAfterCostsRatio: 1.5,
  backtestMinimumTrades: 30,
  backtestMinimumTradesPerDirection: 3,
  backtestMinimumTradesPerSymbol: 3,
  backtestMinimumStableProfitFactor: 1.15,
  backtestMaximumDrawdownPct: 12,
  walkForwardFolds: 4,
  walkForwardPurgeSteps: 30,
  walkForwardMaximumFoldLossPct: 5,
})

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return Math.round(clamp(finite(value, fallback), minimum, maximum))
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true" || value === 1 || value === "1") return true
  if (value === false || value === "false" || value === 0 || value === "0") return false
  return fallback
}

/** Normalize every operator setting and re-apply non-bypassable limits. */
export function normalizeSpecialStrategySettings(
  input: Partial<Record<keyof SpecialStrategySettings, unknown>> | null | undefined,
): SpecialStrategySettings {
  const source = input || {}
  const defaults = DEFAULT_SPECIAL_STRATEGY_SETTINGS
  const minStep = integer(source.minStep, defaults.minStep, SPECIAL_MIN_STEP, 120)
  const maxStep = integer(source.maxStep, defaults.maxStep, minStep, 240)
  const maxVolumeRatio = clamp(
    finite(source.maxVolumeRatio, defaults.maxVolumeRatio),
    1,
    SPECIAL_MAX_VOLUME_RATIO,
  )
  const takeProfitMinPositionCostRatio = clamp(
    finite(source.takeProfitMinPositionCostRatio, defaults.takeProfitMinPositionCostRatio),
    0.1,
    100,
  )
  const takeProfitMaxPositionCostRatio = Math.max(
    takeProfitMinPositionCostRatio,
    clamp(
      finite(source.takeProfitMaxPositionCostRatio, defaults.takeProfitMaxPositionCostRatio),
      takeProfitMinPositionCostRatio,
      100,
    ),
  )
  const minimumHoldingSeconds = integer(
    source.minimumHoldingSeconds,
    defaults.minimumHoldingSeconds,
    1,
    SPECIAL_MAX_HOLDING_SECONDS,
  )
  const maximumHoldingSeconds = integer(
    source.maximumHoldingSeconds,
    defaults.maximumHoldingSeconds,
    minimumHoldingSeconds,
    SPECIAL_MAX_HOLDING_SECONDS,
  )
  const roundTripCostPct = clamp(
    finite(source.roundTripCostPct, defaults.roundTripCostPct),
    0,
    20,
  )
  const minimumTakeProfitAfterCostsRatio = clamp(
    finite(source.minimumTakeProfitAfterCostsRatio, defaults.minimumTakeProfitAfterCostsRatio),
    1,
    20,
  )

  return {
    enabled: bool(source.enabled, defaults.enabled),
    minStep,
    maxStep,
    stepSize: integer(source.stepSize, defaults.stepSize, 1, Math.max(1, maxStep - minStep + 1)),
    activeWindow: integer(source.activeWindow, defaults.activeWindow, SPECIAL_MIN_STEP, 120),
    minimumEvidence: integer(source.minimumEvidence, defaults.minimumEvidence, 1, 120),
    minimumAgreement: clamp(finite(source.minimumAgreement, defaults.minimumAgreement), 0.5, 1),
    minimumMarketChangePct: clamp(
      Math.max(
        finite(source.minimumMarketChangePct, defaults.minimumMarketChangePct),
        roundTripCostPct * minimumTakeProfitAfterCostsRatio,
      ),
      0,
      100,
    ),
    minimumScore: clamp(finite(source.minimumScore, defaults.minimumScore), 0, 100),
    noiseFilterPct: clamp(finite(source.noiseFilterPct, defaults.noiseFilterPct), 0, 10),
    momentumWeight: clamp(finite(source.momentumWeight, defaults.momentumWeight), 0, 5),
    activityWeight: clamp(finite(source.activityWeight, defaults.activityWeight), 0, 5),
    volatilityWeight: clamp(finite(source.volatilityWeight, defaults.volatilityWeight), 0, 5),
    marketChangeSpeedWeight: clamp(
      finite(source.marketChangeSpeedWeight, defaults.marketChangeSpeedWeight),
      0,
      5,
    ),
    minimumMarketChangeSpeedRatio: clamp(
      finite(source.minimumMarketChangeSpeedRatio, defaults.minimumMarketChangeSpeedRatio),
      0,
      100,
    ),
    maximumMarketChangeSpeedPctPerSecond: clamp(
      finite(
        source.maximumMarketChangeSpeedPctPerSecond,
        defaults.maximumMarketChangeSpeedPctPerSecond,
      ),
      0.000001,
      100,
    ),
    scenarioCoordinationEnabled: bool(
      source.scenarioCoordinationEnabled,
      defaults.scenarioCoordinationEnabled,
    ),
    scenarioWeight: clamp(finite(source.scenarioWeight, defaults.scenarioWeight), 0, 5),
    scenarioMinimumScore: clamp(
      finite(source.scenarioMinimumScore, defaults.scenarioMinimumScore),
      0,
      100,
    ),
    pastActivityPersistenceMinimum: clamp(
      finite(source.pastActivityPersistenceMinimum, defaults.pastActivityPersistenceMinimum),
      0,
      1,
    ),
    activityBreakoutRatio: clamp(
      finite(source.activityBreakoutRatio, defaults.activityBreakoutRatio),
      0,
      20,
    ),
    reversalAccelerationMinimumPct: clamp(
      finite(source.reversalAccelerationMinimumPct, defaults.reversalAccelerationMinimumPct),
      0,
      100,
    ),
    activityLookback: integer(source.activityLookback, defaults.activityLookback, SPECIAL_MIN_STEP, 500),
    minimumActivityRatio: clamp(finite(source.minimumActivityRatio, defaults.minimumActivityRatio), 0, 20),
    marketActivityFadeRatio: clamp(
      finite(source.marketActivityFadeRatio, defaults.marketActivityFadeRatio),
      0,
      5,
    ),
    maximumVolatilityPct: clamp(finite(source.maximumVolatilityPct, defaults.maximumVolatilityPct), 0.01, 100),
    volatilityTargetPct: clamp(finite(source.volatilityTargetPct, defaults.volatilityTargetPct), 0.001, 100),
    minimumVolatilityVolumeScale: clamp(
      finite(source.minimumVolatilityVolumeScale, defaults.minimumVolatilityVolumeScale),
      0.01,
      1,
    ),
    orderFlowWeight: clamp(finite(source.orderFlowWeight, defaults.orderFlowWeight), 0, 5),
    minimumDirectionalOrderFlow: clamp(
      finite(source.minimumDirectionalOrderFlow, defaults.minimumDirectionalOrderFlow),
      0,
      1,
    ),
    requireOrderFlowConfirmation: bool(
      source.requireOrderFlowConfirmation,
      defaults.requireOrderFlowConfirmation,
    ),
    maximumSpreadBps: clamp(finite(source.maximumSpreadBps, defaults.maximumSpreadBps), 0, 10_000),
    minimumHoldingSteps: integer(source.minimumHoldingSteps, defaults.minimumHoldingSteps, 0, 10_000),
    maximumHoldingSteps: integer(
      source.maximumHoldingSteps,
      defaults.maximumHoldingSteps,
      integer(source.minimumHoldingSteps, defaults.minimumHoldingSteps, 0, 10_000),
      100_000,
    ),
    minimumHoldingSeconds,
    targetHoldingSeconds: integer(
      source.targetHoldingSeconds,
      defaults.targetHoldingSeconds,
      minimumHoldingSeconds,
      maximumHoldingSeconds,
    ),
    maximumHoldingSeconds,
    timeframe15sEnabled: bool(source.timeframe15sEnabled, defaults.timeframe15sEnabled),
    timeframe1mEnabled: bool(source.timeframe1mEnabled, defaults.timeframe1mEnabled),
    timeframe15mEnabled: bool(source.timeframe15mEnabled, defaults.timeframe15mEnabled),
    timeframe30mEnabled: bool(source.timeframe30mEnabled, defaults.timeframe30mEnabled),
    individualTimeframesEnabled: bool(
      source.individualTimeframesEnabled,
      defaults.individualTimeframesEnabled,
    ),
    combinedTimeframesEnabled: bool(
      source.combinedTimeframesEnabled,
      defaults.combinedTimeframesEnabled,
    ),
    minimumTimeframeConfirmations: integer(
      source.minimumTimeframeConfirmations,
      defaults.minimumTimeframeConfirmations,
      1,
      SPECIAL_TIMEFRAMES_SECONDS.length,
    ),
    minimumCombinedScoreMargin: clamp(
      finite(source.minimumCombinedScoreMargin, defaults.minimumCombinedScoreMargin),
      0,
      100,
    ),
    requireHigherTimeframeAlignment: bool(
      source.requireHigherTimeframeAlignment,
      defaults.requireHigherTimeframeAlignment,
    ),
    timeframe15sWeight: clamp(finite(source.timeframe15sWeight, defaults.timeframe15sWeight), 0.01, 10),
    timeframe1mWeight: clamp(finite(source.timeframe1mWeight, defaults.timeframe1mWeight), 0.01, 10),
    timeframe15mWeight: clamp(finite(source.timeframe15mWeight, defaults.timeframe15mWeight), 0.01, 10),
    timeframe30mWeight: clamp(finite(source.timeframe30mWeight, defaults.timeframe30mWeight), 0.01, 10),
    maxPositionsPerDirection: integer(
      source.maxPositionsPerDirection,
      defaults.maxPositionsPerDirection,
      1,
      SPECIAL_MAX_POSITIONS_PER_DIRECTION,
    ),
    additionalPositionStepPositionCostRatio: clamp(
      finite(
        source.additionalPositionStepPositionCostRatio,
        defaults.additionalPositionStepPositionCostRatio,
      ),
      SPECIAL_MIN_STEP,
      100,
    ),
    volumeIncrementRatio: clamp(finite(source.volumeIncrementRatio, defaults.volumeIncrementRatio), 0, 2),
    maxVolumeRatio,
    takeProfitMinPositionCostRatio,
    takeProfitMaxPositionCostRatio,
    takeProfitVolatilityMultiplier: clamp(
      finite(source.takeProfitVolatilityMultiplier, defaults.takeProfitVolatilityMultiplier),
      0,
      20,
    ),
    takeProfitMarketChangeMultiplier: clamp(
      finite(source.takeProfitMarketChangeMultiplier, defaults.takeProfitMarketChangeMultiplier),
      0,
      20,
    ),
    stopLossMinPositionCostRatio: clamp(
      finite(source.stopLossMinPositionCostRatio, defaults.stopLossMinPositionCostRatio),
      0.1,
      100,
    ),
    stopLossVolatilityMultiplier: clamp(
      finite(source.stopLossVolatilityMultiplier, defaults.stopLossVolatilityMultiplier),
      0,
      20,
    ),
    stopLossMaxTakeProfitRatio: clamp(
      finite(source.stopLossMaxTakeProfitRatio, defaults.stopLossMaxTakeProfitRatio),
      0.1,
      SPECIAL_MAX_SL_TO_TP_RATIO,
    ),
    nonTrailingVariantEnabled: bool(
      source.nonTrailingVariantEnabled,
      defaults.nonTrailingVariantEnabled,
    ),
    trailingEnabled: bool(source.trailingEnabled, defaults.trailingEnabled),
    trailingAdaptiveEnabled: bool(
      source.trailingAdaptiveEnabled,
      defaults.trailingAdaptiveEnabled,
    ),
    trailingVolatilityAdaptationWeight: clamp(
      finite(source.trailingVolatilityAdaptationWeight, defaults.trailingVolatilityAdaptationWeight),
      0,
      5,
    ),
    trailingSpeedAdaptationWeight: clamp(
      finite(source.trailingSpeedAdaptationWeight, defaults.trailingSpeedAdaptationWeight),
      0,
      5,
    ),
    trailingActivityAdaptationWeight: clamp(
      finite(source.trailingActivityAdaptationWeight, defaults.trailingActivityAdaptationWeight),
      0,
      5,
    ),
    trailingScenarioAdaptationWeight: clamp(
      finite(source.trailingScenarioAdaptationWeight, defaults.trailingScenarioAdaptationWeight),
      0,
      5,
    ),
    trailingActivationTakeProfitRatio: clamp(
      finite(source.trailingActivationTakeProfitRatio, defaults.trailingActivationTakeProfitRatio),
      0.05,
      1,
    ),
    trailingDistanceTakeProfitRatio: clamp(
      finite(source.trailingDistanceTakeProfitRatio, defaults.trailingDistanceTakeProfitRatio),
      0.01,
      1,
    ),
    trailingStepTakeProfitRatio: clamp(
      finite(source.trailingStepTakeProfitRatio, defaults.trailingStepTakeProfitRatio),
      0.005,
      1,
    ),
    roundTripCostPct,
    minimumTakeProfitAfterCostsRatio,
    backtestMinimumTrades: integer(source.backtestMinimumTrades, defaults.backtestMinimumTrades, 1, 100_000),
    backtestMinimumTradesPerDirection: integer(
      source.backtestMinimumTradesPerDirection,
      defaults.backtestMinimumTradesPerDirection,
      0,
      100_000,
    ),
    backtestMinimumTradesPerSymbol: integer(
      source.backtestMinimumTradesPerSymbol,
      defaults.backtestMinimumTradesPerSymbol,
      0,
      100_000,
    ),
    backtestMinimumStableProfitFactor: clamp(
      finite(source.backtestMinimumStableProfitFactor, defaults.backtestMinimumStableProfitFactor),
      0,
      100,
    ),
    backtestMaximumDrawdownPct: clamp(
      finite(source.backtestMaximumDrawdownPct, defaults.backtestMaximumDrawdownPct),
      0.01,
      100,
    ),
    walkForwardFolds: integer(source.walkForwardFolds, defaults.walkForwardFolds, 2, 12),
    walkForwardPurgeSteps: integer(
      source.walkForwardPurgeSteps,
      defaults.walkForwardPurgeSteps,
      0,
      100_000,
    ),
    walkForwardMaximumFoldLossPct: clamp(
      finite(source.walkForwardMaximumFoldLossPct, defaults.walkForwardMaximumFoldLossPct),
      0,
      100,
    ),
  }
}

/** Read the flat app-settings representation used by Settings → Special. */
export function specialSettingsFromAppSettings(settings: Record<string, unknown>): SpecialStrategySettings {
  const nested = settings.special && typeof settings.special === "object" && !Array.isArray(settings.special)
    ? settings.special as Record<string, unknown>
    : {}
  return normalizeSpecialStrategySettings({
    enabled: settings.specialEnabled ?? nested.enabled,
    minStep: settings.specialMinStep ?? nested.minStep,
    maxStep: settings.specialMaxStep ?? nested.maxStep,
    stepSize: settings.specialStepSize ?? nested.stepSize,
    activeWindow: settings.specialActiveWindow ?? nested.activeWindow,
    minimumEvidence: settings.specialMinimumEvidence ?? nested.minimumEvidence,
    minimumAgreement: settings.specialMinimumAgreement ?? nested.minimumAgreement,
    minimumMarketChangePct: settings.specialMinimumMarketChangePct ?? nested.minimumMarketChangePct,
    minimumScore: settings.specialMinimumScore ?? nested.minimumScore,
    noiseFilterPct: settings.specialNoiseFilterPct ?? nested.noiseFilterPct,
    momentumWeight: settings.specialMomentumWeight ?? nested.momentumWeight,
    activityWeight: settings.specialActivityWeight ?? nested.activityWeight,
    volatilityWeight: settings.specialVolatilityWeight ?? nested.volatilityWeight,
    marketChangeSpeedWeight:
      settings.specialMarketChangeSpeedWeight ?? nested.marketChangeSpeedWeight,
    minimumMarketChangeSpeedRatio:
      settings.specialMinimumMarketChangeSpeedRatio ?? nested.minimumMarketChangeSpeedRatio,
    maximumMarketChangeSpeedPctPerSecond:
      settings.specialMaximumMarketChangeSpeedPctPerSecond ??
      nested.maximumMarketChangeSpeedPctPerSecond,
    scenarioCoordinationEnabled:
      settings.specialScenarioCoordinationEnabled ?? nested.scenarioCoordinationEnabled,
    scenarioWeight: settings.specialScenarioWeight ?? nested.scenarioWeight,
    scenarioMinimumScore: settings.specialScenarioMinimumScore ?? nested.scenarioMinimumScore,
    pastActivityPersistenceMinimum:
      settings.specialPastActivityPersistenceMinimum ?? nested.pastActivityPersistenceMinimum,
    activityBreakoutRatio:
      settings.specialActivityBreakoutRatio ?? nested.activityBreakoutRatio,
    reversalAccelerationMinimumPct:
      settings.specialReversalAccelerationMinimumPct ?? nested.reversalAccelerationMinimumPct,
    activityLookback: settings.specialActivityLookback ?? nested.activityLookback,
    minimumActivityRatio: settings.specialMinimumActivityRatio ?? nested.minimumActivityRatio,
    marketActivityFadeRatio: settings.specialMarketActivityFadeRatio ?? nested.marketActivityFadeRatio,
    maximumVolatilityPct: settings.specialMaximumVolatilityPct ?? nested.maximumVolatilityPct,
    volatilityTargetPct: settings.specialVolatilityTargetPct ?? nested.volatilityTargetPct,
    minimumVolatilityVolumeScale:
      settings.specialMinimumVolatilityVolumeScale ?? nested.minimumVolatilityVolumeScale,
    orderFlowWeight: settings.specialOrderFlowWeight ?? nested.orderFlowWeight,
    minimumDirectionalOrderFlow:
      settings.specialMinimumDirectionalOrderFlow ?? nested.minimumDirectionalOrderFlow,
    requireOrderFlowConfirmation:
      settings.specialRequireOrderFlowConfirmation ?? nested.requireOrderFlowConfirmation,
    maximumSpreadBps: settings.specialMaximumSpreadBps ?? nested.maximumSpreadBps,
    minimumHoldingSteps: settings.specialMinimumHoldingSteps ?? nested.minimumHoldingSteps,
    maximumHoldingSteps: settings.specialMaximumHoldingSteps ?? nested.maximumHoldingSteps,
    minimumHoldingSeconds: settings.specialMinimumHoldingSeconds ?? nested.minimumHoldingSeconds,
    targetHoldingSeconds: settings.specialTargetHoldingSeconds ?? nested.targetHoldingSeconds,
    maximumHoldingSeconds: settings.specialMaximumHoldingSeconds ?? nested.maximumHoldingSeconds,
    timeframe15sEnabled: settings.specialTimeframe15sEnabled ?? nested.timeframe15sEnabled,
    timeframe1mEnabled: settings.specialTimeframe1mEnabled ?? nested.timeframe1mEnabled,
    timeframe15mEnabled: settings.specialTimeframe15mEnabled ?? nested.timeframe15mEnabled,
    timeframe30mEnabled: settings.specialTimeframe30mEnabled ?? nested.timeframe30mEnabled,
    individualTimeframesEnabled:
      settings.specialIndividualTimeframesEnabled ?? nested.individualTimeframesEnabled,
    combinedTimeframesEnabled:
      settings.specialCombinedTimeframesEnabled ?? nested.combinedTimeframesEnabled,
    minimumTimeframeConfirmations:
      settings.specialMinimumTimeframeConfirmations ?? nested.minimumTimeframeConfirmations,
    minimumCombinedScoreMargin:
      settings.specialMinimumCombinedScoreMargin ?? nested.minimumCombinedScoreMargin,
    requireHigherTimeframeAlignment:
      settings.specialRequireHigherTimeframeAlignment ?? nested.requireHigherTimeframeAlignment,
    timeframe15sWeight: settings.specialTimeframe15sWeight ?? nested.timeframe15sWeight,
    timeframe1mWeight: settings.specialTimeframe1mWeight ?? nested.timeframe1mWeight,
    timeframe15mWeight: settings.specialTimeframe15mWeight ?? nested.timeframe15mWeight,
    timeframe30mWeight: settings.specialTimeframe30mWeight ?? nested.timeframe30mWeight,
    maxPositionsPerDirection: settings.specialMaxPositionsPerDirection ?? nested.maxPositionsPerDirection,
    additionalPositionStepPositionCostRatio:
      settings.specialAdditionalPositionStepPositionCostRatio ?? nested.additionalPositionStepPositionCostRatio,
    volumeIncrementRatio: settings.specialVolumeIncrementRatio ?? nested.volumeIncrementRatio,
    maxVolumeRatio: settings.specialMaxVolumeRatio ?? nested.maxVolumeRatio,
    takeProfitMinPositionCostRatio:
      settings.specialTakeProfitMinPositionCostRatio ?? nested.takeProfitMinPositionCostRatio,
    takeProfitMaxPositionCostRatio:
      settings.specialTakeProfitMaxPositionCostRatio ?? nested.takeProfitMaxPositionCostRatio,
    takeProfitVolatilityMultiplier:
      settings.specialTakeProfitVolatilityMultiplier ?? nested.takeProfitVolatilityMultiplier,
    takeProfitMarketChangeMultiplier:
      settings.specialTakeProfitMarketChangeMultiplier ?? nested.takeProfitMarketChangeMultiplier,
    stopLossMinPositionCostRatio:
      settings.specialStopLossMinPositionCostRatio ?? nested.stopLossMinPositionCostRatio,
    stopLossVolatilityMultiplier:
      settings.specialStopLossVolatilityMultiplier ?? nested.stopLossVolatilityMultiplier,
    stopLossMaxTakeProfitRatio:
      settings.specialStopLossMaxTakeProfitRatio ?? nested.stopLossMaxTakeProfitRatio,
    nonTrailingVariantEnabled:
      settings.specialNonTrailingVariantEnabled ?? nested.nonTrailingVariantEnabled,
    trailingEnabled: settings.specialTrailingEnabled ?? nested.trailingEnabled,
    trailingAdaptiveEnabled:
      settings.specialTrailingAdaptiveEnabled ?? nested.trailingAdaptiveEnabled,
    trailingVolatilityAdaptationWeight:
      settings.specialTrailingVolatilityAdaptationWeight ?? nested.trailingVolatilityAdaptationWeight,
    trailingSpeedAdaptationWeight:
      settings.specialTrailingSpeedAdaptationWeight ?? nested.trailingSpeedAdaptationWeight,
    trailingActivityAdaptationWeight:
      settings.specialTrailingActivityAdaptationWeight ?? nested.trailingActivityAdaptationWeight,
    trailingScenarioAdaptationWeight:
      settings.specialTrailingScenarioAdaptationWeight ?? nested.trailingScenarioAdaptationWeight,
    trailingActivationTakeProfitRatio:
      settings.specialTrailingActivationTakeProfitRatio ?? nested.trailingActivationTakeProfitRatio,
    trailingDistanceTakeProfitRatio:
      settings.specialTrailingDistanceTakeProfitRatio ?? nested.trailingDistanceTakeProfitRatio,
    trailingStepTakeProfitRatio:
      settings.specialTrailingStepTakeProfitRatio ?? nested.trailingStepTakeProfitRatio,
    roundTripCostPct: settings.specialRoundTripCostPct ?? nested.roundTripCostPct,
    minimumTakeProfitAfterCostsRatio:
      settings.specialMinimumTakeProfitAfterCostsRatio ?? nested.minimumTakeProfitAfterCostsRatio,
    backtestMinimumTrades: settings.specialBacktestMinimumTrades ?? nested.backtestMinimumTrades,
    backtestMinimumTradesPerDirection:
      settings.specialBacktestMinimumTradesPerDirection ?? nested.backtestMinimumTradesPerDirection,
    backtestMinimumTradesPerSymbol:
      settings.specialBacktestMinimumTradesPerSymbol ?? nested.backtestMinimumTradesPerSymbol,
    backtestMinimumStableProfitFactor:
      settings.specialBacktestMinimumStableProfitFactor ?? nested.backtestMinimumStableProfitFactor,
    backtestMaximumDrawdownPct:
      settings.specialBacktestMaximumDrawdownPct ?? nested.backtestMaximumDrawdownPct,
    walkForwardFolds: settings.specialWalkForwardFolds ?? nested.walkForwardFolds,
    walkForwardPurgeSteps: settings.specialWalkForwardPurgeSteps ?? nested.walkForwardPurgeSteps,
    walkForwardMaximumFoldLossPct:
      settings.specialWalkForwardMaximumFoldLossPct ?? nested.walkForwardMaximumFoldLossPct,
  })
}

/**
 * Materialize fixed-bracket and trailing exits as separate configuration
 * lanes.  They share the same causal indication evidence, but never share a
 * Set key, position plan, trade ledger, or performance result.
 */
export function specialExitVariantSettings(
  input?: Partial<SpecialStrategySettings>,
): Array<{ exitVariant: SpecialExitVariant; settings: SpecialStrategySettings }> {
  const settings = normalizeSpecialStrategySettings(input as any)
  const variants: Array<{ exitVariant: SpecialExitVariant; settings: SpecialStrategySettings }> = []
  if (settings.nonTrailingVariantEnabled) {
    variants.push({
      exitVariant: "fixed",
      settings: { ...settings, trailingEnabled: false },
    })
  }
  if (settings.trailingEnabled) {
    variants.push({
      exitVariant: "trailing",
      settings: { ...settings, trailingEnabled: true },
    })
  }
  return variants
}

export interface SpecialDirectionLaneEvaluation {
  direction: EffectiveTradeDirection
  evidenceCount: number
  opposingEvidenceCount: number
  agreement: number
  marketChangePct: number
  activeChangePct: number
  previousChangePct: number
  accelerationPct: number
  marketChangeSpeedPctPerSecond: number | null
  activeChangeSpeedPctPerSecond: number | null
  speedAccelerationPctPerSecond: number | null
  marketChangeSpeedRatio: number | null
  volatilityPct: number
  activityRatio: number | null
  directionalOrderFlow: number | null
  spreadBps: number | null
  marketActivityQualified: boolean
  liquidityQualified: boolean
  score: number
  qualified: boolean
}

export interface SpecialDirectionEvaluation {
  long: SpecialDirectionLaneEvaluation
  short: SpecialDirectionLaneEvaluation
}

export type SpecialScenarioName =
  | "momentum_continuation"
  | "market_acceleration"
  | "activity_breakout"
  | "directional_reversal"
  | "order_flow_persistence"
  | "activity_fade"
  | "liquidity_stress"
  | "momentum_exhaustion"

export interface SpecialScenarioEvaluation {
  name: SpecialScenarioName | string
  direction: EffectiveTradeDirection
  score: number
  qualified: boolean
  veto: boolean
  reason: string
}

export interface SpecialScenarioCoordination {
  evaluations: SpecialScenarioEvaluation[]
  qualifiedScenarios: string[]
  vetoReasons: string[]
  score: number
  qualified: boolean
}

export interface SpecialScenarioContext {
  lane: SpecialDirectionLaneEvaluation
  settings: SpecialStrategySettings
}

export type SpecialScenarioEvaluator = (
  context: SpecialScenarioContext,
) => SpecialScenarioEvaluation | null

function scenario(
  context: SpecialScenarioContext,
  name: SpecialScenarioName,
  qualified: boolean,
  score: number,
  reason: string,
  veto = false,
): SpecialScenarioEvaluation | null {
  return qualified
    ? { name, direction: context.lane.direction, qualified: !veto, score, reason, veto }
    : null
}

/** Extensible built-in scenario registry; callers may append custom evaluators. */
export const BUILTIN_SPECIAL_SCENARIO_EVALUATORS: readonly SpecialScenarioEvaluator[] = Object.freeze([
  (context) => scenario(
    context,
    "momentum_continuation",
    context.lane.previousChangePct >= 0 &&
      context.lane.activeChangePct > 0 &&
      context.lane.agreement >= context.settings.pastActivityPersistenceMinimum,
    context.lane.agreement + Math.max(0, context.lane.marketChangeSpeedRatio || 0) * 0.1,
    "past and active movement persist in the lane direction",
  ),
  (context) => scenario(
    context,
    "market_acceleration",
    context.lane.accelerationPct >= context.settings.reversalAccelerationMinimumPct ||
      Number(context.lane.speedAccelerationPctPerSecond) > 0,
    Math.max(0, context.lane.accelerationPct) +
      Math.max(0, Number(context.lane.speedAccelerationPctPerSecond) || 0),
    "active movement speed is increasing",
  ),
  (context) => scenario(
    context,
    "activity_breakout",
    Number(context.lane.activityRatio) >= context.settings.activityBreakoutRatio,
    Math.max(0, Number(context.lane.activityRatio) - 1),
    "recent traded activity exceeds its historical median",
  ),
  (context) => scenario(
    context,
    "directional_reversal",
    context.lane.previousChangePct < 0 &&
      context.lane.activeChangePct > 0 &&
      context.lane.accelerationPct >= context.settings.reversalAccelerationMinimumPct,
    Math.max(0, context.lane.accelerationPct) + context.lane.agreement,
    "active movement reverses the previous window into this lane",
  ),
  (context) => scenario(
    context,
    "order_flow_persistence",
    Number(context.lane.directionalOrderFlow) >= context.settings.minimumDirectionalOrderFlow,
    Math.max(0, Number(context.lane.directionalOrderFlow) || 0),
    "order-flow pressure confirms the lane direction",
  ),
  (context) => scenario(
    context,
    "activity_fade",
    context.lane.activityRatio !== null &&
      context.lane.activityRatio < context.settings.marketActivityFadeRatio,
    1,
    "market activity faded below the Special exit threshold",
    true,
  ),
  (context) => scenario(
    context,
    "liquidity_stress",
    !context.lane.liquidityQualified ||
      context.lane.volatilityPct > context.settings.maximumVolatilityPct,
    1,
    "spread or volatility exceeds the configured liquidity boundary",
    true,
  ),
  (context) => scenario(
    context,
    "momentum_exhaustion",
    context.lane.activeChangePct > 0 &&
      context.lane.accelerationPct < 0 &&
      Number(context.lane.speedAccelerationPctPerSecond) < 0 &&
      context.lane.activityRatio !== null &&
      context.lane.activityRatio < context.settings.minimumActivityRatio,
    1,
    "direction remains positive but speed and activity are decaying",
    true,
  ),
])

export function evaluateSpecialScenarios(
  lane: SpecialDirectionLaneEvaluation,
  inputSettings?: Partial<SpecialStrategySettings>,
  additionalEvaluators: readonly SpecialScenarioEvaluator[] = [],
): SpecialScenarioCoordination {
  const settings = normalizeSpecialStrategySettings(inputSettings as any)
  if (!settings.scenarioCoordinationEnabled) {
    return { evaluations: [], qualifiedScenarios: [], vetoReasons: [], score: 0, qualified: true }
  }
  const evaluations = [...BUILTIN_SPECIAL_SCENARIO_EVALUATORS, ...additionalEvaluators]
    .map((evaluate) => evaluate({ lane, settings }))
    .filter((value): value is SpecialScenarioEvaluation => !!value)
  const vetoReasons = evaluations.filter((item) => item.veto).map((item) => item.reason)
  const positive = evaluations.filter((item) => !item.veto && item.qualified)
  const score = positive.reduce((sum, item) => sum + item.score, 0)
  return {
    evaluations,
    qualifiedScenarios: positive.map((item) => item.name),
    vetoReasons,
    score,
    qualified:
      vetoReasons.length === 0 &&
      positive.some((item) => item.score >= settings.scenarioMinimumScore),
  }
}

export interface SpecialMarketActivityInput {
  /** Oldest-first traded volume observations matching or covering prices. */
  volumes?: readonly unknown[]
  /** Normalized [-1, 1] bid-vs-ask flow/depth imbalance. */
  orderFlowImbalance?: unknown
  bidDepth?: unknown
  askDepth?: unknown
  spreadBps?: unknown
}

export interface SpecialIndication {
  type: "special"
  direction: EffectiveTradeDirection
  sampleRange: number
  confidence: number
  signalScore: number
  rawSignalStrength: number
  profitFactor: number
  directionEvaluation: SpecialDirectionEvaluation
  lane: SpecialDirectionLaneEvaluation
  scenarios: SpecialScenarioCoordination
  timeframeSeconds?: number | "combined"
  timeframeCoordination?: SpecialMultiTimeframeCoordination
}

function normalizedPrices(values: readonly unknown[]): number[] {
  return values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
}

function percentChange(from: number, to: number): number {
  return from > 0 ? ((to - from) / from) * 100 : 0
}

function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length
  return Math.sqrt(variance)
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function resolveOrderFlowImbalance(activity?: SpecialMarketActivityInput): number | null {
  const explicit = Number(activity?.orderFlowImbalance)
  if (Number.isFinite(explicit)) return clamp(explicit, -1, 1)
  const bidDepth = Number(activity?.bidDepth)
  const askDepth = Number(activity?.askDepth)
  const totalDepth = bidDepth + askDepth
  if (
    Number.isFinite(bidDepth) && bidDepth >= 0 &&
    Number.isFinite(askDepth) && askDepth >= 0 &&
    totalDepth > 0
  ) return clamp((bidDepth - askDepth) / totalDepth, -1, 1)
  return null
}

function resolveActivityRatio(
  activity: SpecialMarketActivityInput | undefined,
  settings: SpecialStrategySettings,
): number | null {
  const volumes = (activity?.volumes || [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
  if (volumes.length < 2) return null
  const latest = volumes[volumes.length - 1]
  const history = volumes.slice(
    Math.max(0, volumes.length - settings.activityLookback - 1),
    -1,
  )
  const baseline = median(history.filter((value) => value > 0))
  return baseline > 0 ? latest / baseline : null
}

function calculateLane(
  prices: readonly number[],
  direction: EffectiveTradeDirection,
  settings: SpecialStrategySettings,
  activity?: SpecialMarketActivityInput,
  timeframeSeconds?: number,
): SpecialDirectionLaneEvaluation {
  const sign = direction === "long" ? 1 : -1
  const signedMoves: number[] = []
  for (let index = 1; index < prices.length; index++) {
    signedMoves.push(percentChange(prices[index - 1], prices[index]) * sign)
  }
  const meaningful = signedMoves.filter((move) => Math.abs(move) >= settings.noiseFilterPct)
  const evidenceCount = meaningful.filter((move) => move > 0).length
  const opposingEvidenceCount = meaningful.filter((move) => move < 0).length
  const agreement = meaningful.length > 0 ? evidenceCount / meaningful.length : 0
  const marketChangePct = percentChange(prices[0], prices[prices.length - 1]) * sign
  const activeMoveCount = Math.max(1, Math.min(settings.activeWindow, prices.length - 1))
  const activeStartIndex = Math.max(0, prices.length - activeMoveCount - 1)
  const activeChangePct = percentChange(prices[activeStartIndex], prices[prices.length - 1]) * sign
  const previousEndIndex = activeStartIndex
  const previousStartIndex = Math.max(0, previousEndIndex - activeMoveCount)
  const previousChangePct = previousEndIndex > previousStartIndex
    ? percentChange(prices[previousStartIndex], prices[previousEndIndex]) * sign
    : 0
  const accelerationPct = activeChangePct - previousChangePct
  const validTimeframeSeconds = Number(timeframeSeconds) > 0 ? Number(timeframeSeconds) : null
  const totalDurationSeconds = validTimeframeSeconds === null
    ? null
    : Math.max(validTimeframeSeconds, (prices.length - 1) * validTimeframeSeconds)
  const activeDurationSeconds = validTimeframeSeconds === null
    ? null
    : Math.max(validTimeframeSeconds, activeMoveCount * validTimeframeSeconds)
  const marketChangeSpeedPctPerSecond = totalDurationSeconds === null
    ? null
    : marketChangePct / totalDurationSeconds
  const activeChangeSpeedPctPerSecond = activeDurationSeconds === null
    ? null
    : activeChangePct / activeDurationSeconds
  const previousChangeSpeedPctPerSecond = activeDurationSeconds === null
    ? null
    : previousChangePct / activeDurationSeconds
  const speedAccelerationPctPerSecond = activeChangeSpeedPctPerSecond === null
    ? null
    : activeChangeSpeedPctPerSecond - (previousChangeSpeedPctPerSecond || 0)
  const expectedSpeed = totalDurationSeconds === null
    ? null
    : settings.minimumMarketChangePct / Math.max(totalDurationSeconds, 0.000001)
  const marketChangeSpeedRatio =
    expectedSpeed !== null && expectedSpeed > 0 && marketChangeSpeedPctPerSecond !== null
      ? marketChangeSpeedPctPerSecond / expectedSpeed
      : null
  const volatilityPct = standardDeviation(signedMoves)
  const activityRatio = resolveActivityRatio(activity, settings)
  const orderFlowImbalance = resolveOrderFlowImbalance(activity)
  const directionalOrderFlow = orderFlowImbalance === null ? null : orderFlowImbalance * sign
  const rawSpreadBps = Number(activity?.spreadBps)
  const spreadBps = Number.isFinite(rawSpreadBps) && rawSpreadBps >= 0 ? rawSpreadBps : null
  const marketActivityQualified = activityRatio === null || activityRatio >= settings.minimumActivityRatio
  const orderFlowQualified = directionalOrderFlow === null
    ? !settings.requireOrderFlowConfirmation
    : directionalOrderFlow >= settings.minimumDirectionalOrderFlow
  const liquidityQualified = spreadBps === null || spreadBps <= settings.maximumSpreadBps
  const marketUnit = Math.max(settings.minimumMarketChangePct, 0.000001)
  const score =
    (Math.max(0, marketChangePct) / marketUnit) * settings.momentumWeight +
    (Math.max(0, activeChangePct) / marketUnit) * settings.activityWeight +
    agreement +
    (Math.max(0, accelerationPct) / marketUnit) * settings.activityWeight +
    (volatilityPct / marketUnit) * settings.volatilityWeight +
    Math.max(0, marketChangeSpeedRatio ?? 0) * settings.marketChangeSpeedWeight +
    Math.max(0, speedAccelerationPctPerSecond ?? 0) * settings.marketChangeSpeedWeight +
    Math.max(0, (activityRatio ?? 1) - 1) * settings.activityWeight +
    Math.max(0, directionalOrderFlow ?? 0) * settings.orderFlowWeight
  const requiredEvidence = Math.min(
    meaningful.length,
    Math.max(1, settings.minimumEvidence),
  )
  const qualified =
    meaningful.length > 0 &&
    evidenceCount >= requiredEvidence &&
    agreement >= settings.minimumAgreement &&
    marketChangePct >= settings.minimumMarketChangePct &&
    activeChangePct > 0 &&
    (marketChangeSpeedRatio === null ||
      marketChangeSpeedRatio >= settings.minimumMarketChangeSpeedRatio) &&
    (marketChangeSpeedPctPerSecond === null ||
      marketChangeSpeedPctPerSecond <= settings.maximumMarketChangeSpeedPctPerSecond) &&
    volatilityPct <= settings.maximumVolatilityPct &&
    marketActivityQualified &&
    orderFlowQualified &&
    liquidityQualified &&
    score >= settings.minimumScore

  return {
    direction,
    evidenceCount,
    opposingEvidenceCount,
    agreement,
    marketChangePct,
    activeChangePct,
    previousChangePct,
    accelerationPct,
    marketChangeSpeedPctPerSecond,
    activeChangeSpeedPctPerSecond,
    speedAccelerationPctPerSecond,
    marketChangeSpeedRatio,
    volatilityPct,
    activityRatio,
    directionalOrderFlow,
    spreadBps,
    marketActivityQualified,
    liquidityQualified,
    score,
    qualified,
  }
}

/**
 * Calculate Long and Short as independent hypotheses over the same causal
 * window. No side is inferred from a default or copied from its opposite.
 */
export function evaluateSpecialDirectionLanes(
  values: readonly unknown[],
  inputSettings?: Partial<SpecialStrategySettings>,
  activity?: SpecialMarketActivityInput,
  timeframeSeconds?: number,
): SpecialDirectionEvaluation | null {
  const settings = normalizeSpecialStrategySettings(inputSettings as any)
  const prices = normalizedPrices(values)
  if (prices.length < settings.minStep + 1) return null
  return {
    long: calculateLane(prices, "long", settings, activity, timeframeSeconds),
    short: calculateLane(prices, "short", settings, activity, timeframeSeconds),
  }
}

/** Evaluate one exact range × direction configuration. */
export function evaluateSpecialIndication(
  values: readonly unknown[],
  direction: EffectiveTradeDirection,
  sampleRange: number,
  inputSettings?: Partial<SpecialStrategySettings>,
  activity?: SpecialMarketActivityInput,
  timeframeSeconds?: number,
): SpecialIndication | null {
  const settings = normalizeSpecialStrategySettings(inputSettings as any)
  const range = integer(sampleRange, settings.minStep, settings.minStep, settings.maxStep)
  const prices = normalizedPrices(values).slice(-(range + 1))
  if (prices.length < range + 1) return null
  const rangedActivity = activity?.volumes
    ? { ...activity, volumes: activity.volumes.slice(-(range + 1)) }
    : activity
  const directionEvaluation = evaluateSpecialDirectionLanes(
    prices,
    settings,
    rangedActivity,
    timeframeSeconds,
  )
  if (!directionEvaluation) return null
  const lane = directionEvaluation[direction]
  if (!lane.qualified) return null
  const scenarios = evaluateSpecialScenarios(lane, settings)
  if (!scenarios.qualified) return null
  const confidence = clamp(
    0.35 + lane.agreement * 0.45 + Math.min(0.2, lane.score / 10),
    0,
    1,
  )
  return {
    type: "special",
    direction,
    sampleRange: range,
    confidence,
    signalScore: lane.score + scenarios.score * settings.scenarioWeight,
    rawSignalStrength: Math.max(lane.marketChangePct, lane.activeChangePct),
    // Until realised forward outcomes are attached, this is a conservative
    // quality prior rather than a fabricated realised Profit Factor.
    profitFactor: 0,
    directionEvaluation,
    lane,
    scenarios,
  }
}

export interface SpecialTimedObservation {
  timestampMs: number
  price: number
  volume?: number
}

export interface SpecialTimeframeSeries {
  timeframeSeconds: number
  closes: number[]
  volumes: number[]
  timestamps: number[]
}

export interface SpecialTimeframeLaneSummary {
  timeframeSeconds: number
  weight: number
  evaluation: SpecialDirectionEvaluation
}

export interface SpecialMultiTimeframeDirectionSummary {
  direction: EffectiveTradeDirection
  availableTimeframes: number
  qualifiedTimeframes: number
  higherTimeframeAligned: boolean
  weightedScore: number
  weightedAgreement: number
  qualified: boolean
}

export interface SpecialMultiTimeframeCoordination {
  sampleRange: number
  selectedDirection: EffectiveTradeDirection | null
  scoreMargin: number
  frames: SpecialTimeframeLaneSummary[]
  long: SpecialMultiTimeframeDirectionSummary
  short: SpecialMultiTimeframeDirectionSummary
}

function enabledSpecialTimeframes(settings: SpecialStrategySettings): number[] {
  return [
    settings.timeframe15sEnabled ? 15 : 0,
    settings.timeframe1mEnabled ? 60 : 0,
    settings.timeframe15mEnabled ? 15 * 60 : 0,
    settings.timeframe30mEnabled ? 30 * 60 : 0,
  ].filter((value) => value > 0)
}

function specialTimeframeWeight(seconds: number, settings: SpecialStrategySettings): number {
  if (seconds === 15) return settings.timeframe15sWeight
  if (seconds === 60) return settings.timeframe1mWeight
  if (seconds === 15 * 60) return settings.timeframe15mWeight
  return settings.timeframe30mWeight
}

/** Causally resample tick/candle closes; insufficient source density fails closed. */
export function buildSpecialTimeframeSeries(
  observations: readonly SpecialTimedObservation[],
  timeframeSeconds: number,
): SpecialTimeframeSeries | null {
  const normalized = observations
    .map((item) => ({
      timestampMs: Number(item.timestampMs),
      price: Number(item.price),
      volume: Number(item.volume),
    }))
    .filter((item) =>
      Number.isFinite(item.timestampMs) && item.timestampMs > 0 &&
      Number.isFinite(item.price) && item.price > 0,
    )
    .sort((left, right) => left.timestampMs - right.timestampMs)
  if (normalized.length < 2 || !(timeframeSeconds > 0)) return null
  const deltas = normalized
    .slice(1)
    .map((item, index) => item.timestampMs - normalized[index].timestampMs)
    .filter((delta) => delta > 0)
  const sourceCadenceMs = median(deltas)
  const timeframeMs = timeframeSeconds * 1_000
  if (sourceCadenceMs > timeframeMs * 1.5) return null

  const buckets = new Map<number, { close: number; volume: number; timestamp: number }>()
  for (const item of normalized) {
    const bucket = Math.floor(item.timestampMs / timeframeMs) * timeframeMs
    const previous = buckets.get(bucket)
    buckets.set(bucket, {
      close: item.price,
      volume: (previous?.volume || 0) + (Number.isFinite(item.volume) && item.volume >= 0 ? item.volume : 0),
      timestamp: item.timestampMs,
    })
  }
  const rows = [...buckets.entries()].sort(([left], [right]) => left - right)
  if (rows.length < 2) return null
  return {
    timeframeSeconds,
    closes: rows.map(([, row]) => row.close),
    volumes: rows.map(([, row]) => row.volume),
    timestamps: rows.map(([, row]) => row.timestamp),
  }
}

/**
 * Coordinate independently calculated timeframe lanes. Both directions are
 * scored, but one combined configuration emits at most one direction.
 */
export function evaluateSpecialMultiTimeframeCoordination(input: {
  observations: readonly SpecialTimedObservation[]
  prebuiltSeries?: readonly SpecialTimeframeSeries[]
  sampleRange: number
  settings?: Partial<SpecialStrategySettings>
  activity?: SpecialMarketActivityInput
}): SpecialMultiTimeframeCoordination | null {
  const settings = normalizeSpecialStrategySettings(input.settings as any)
  const sampleRange = integer(input.sampleRange, settings.minStep, settings.minStep, settings.maxStep)
  const frames: SpecialTimeframeLaneSummary[] = []
  for (const timeframeSeconds of enabledSpecialTimeframes(settings)) {
    const series = input.prebuiltSeries?.find(
      (candidate) => candidate.timeframeSeconds === timeframeSeconds,
    ) ?? buildSpecialTimeframeSeries(input.observations, timeframeSeconds)
    if (!series || series.closes.length < sampleRange + 1) continue
    const closes = series.closes.slice(-(sampleRange + 1))
    const volumes = series.volumes.slice(-(sampleRange + 1))
    const evaluation = evaluateSpecialDirectionLanes(
      closes,
      settings,
      { ...(input.activity || {}), volumes },
      timeframeSeconds,
    )
    if (!evaluation) continue
    frames.push({
      timeframeSeconds,
      weight: specialTimeframeWeight(timeframeSeconds, settings),
      evaluation,
    })
  }
  if (frames.length === 0) return null

  const summarize = (direction: EffectiveTradeDirection): SpecialMultiTimeframeDirectionSummary => {
    const qualifiedFrames = frames.filter((frame) => frame.evaluation[direction].qualified)
    const totalWeight = frames.reduce((sum, frame) => sum + frame.weight, 0)
    const weightedScore = totalWeight > 0
      ? frames.reduce((sum, frame) => sum + frame.evaluation[direction].score * frame.weight, 0) / totalWeight
      : 0
    const qualifiedWeight = qualifiedFrames.reduce((sum, frame) => sum + frame.weight, 0)
    const weightedAgreement = qualifiedWeight > 0
      ? qualifiedFrames.reduce(
          (sum, frame) => sum + frame.evaluation[direction].agreement * frame.weight,
          0,
        ) / qualifiedWeight
      : 0
    const higherFrames = frames.filter((frame) => frame.timeframeSeconds >= 15 * 60)
    const higherTimeframeAligned = higherFrames.some((frame) => frame.evaluation[direction].qualified)
    const requiredConfirmations = Math.min(
      settings.minimumTimeframeConfirmations,
      enabledSpecialTimeframes(settings).length,
    )
    return {
      direction,
      availableTimeframes: frames.length,
      qualifiedTimeframes: qualifiedFrames.length,
      higherTimeframeAligned,
      weightedScore,
      weightedAgreement,
      qualified:
        frames.length >= requiredConfirmations &&
        qualifiedFrames.length >= requiredConfirmations &&
        (!settings.requireHigherTimeframeAlignment || higherTimeframeAligned),
    }
  }
  const long = summarize("long")
  const short = summarize("short")
  const scoreMargin = Math.abs(long.weightedScore - short.weightedScore)
  let selectedDirection: EffectiveTradeDirection | null = null
  if (long.qualified && !short.qualified) selectedDirection = "long"
  else if (short.qualified && !long.qualified) selectedDirection = "short"
  else if (long.qualified && short.qualified && scoreMargin >= settings.minimumCombinedScoreMargin) {
    selectedDirection = long.weightedScore > short.weightedScore ? "long" : "short"
  }
  return { sampleRange, selectedDirection, scoreMargin, frames, long, short }
}

export function evaluateSpecialMultiTimeframeIndication(input: {
  observations: readonly SpecialTimedObservation[]
  prebuiltSeries?: readonly SpecialTimeframeSeries[]
  direction: EffectiveTradeDirection
  sampleRange: number
  settings?: Partial<SpecialStrategySettings>
  activity?: SpecialMarketActivityInput
}): SpecialIndication | null {
  const coordination = evaluateSpecialMultiTimeframeCoordination(input)
  return coordination
    ? specialIndicationFromMultiTimeframeCoordination(
        coordination,
        input.direction,
        input.settings,
      )
    : null
}

export function specialIndicationFromMultiTimeframeCoordination(
  coordination: SpecialMultiTimeframeCoordination,
  direction: EffectiveTradeDirection,
  inputSettings?: Partial<SpecialStrategySettings>,
): SpecialIndication | null {
  if (coordination.selectedDirection !== direction) return null
  const strongest = coordination.frames
    .filter((frame) => frame.evaluation[direction].qualified)
    .sort((left, right) =>
      right.evaluation[direction].score * right.weight -
      left.evaluation[direction].score * left.weight,
    )[0]
  if (!strongest) return null
  const settings = normalizeSpecialStrategySettings(inputSettings as any)
  const scenarios = evaluateSpecialScenarios(strongest.evaluation[direction], settings)
  if (!scenarios.qualified) return null
  const summary = coordination[direction]
  return {
    type: "special",
    direction,
    sampleRange: coordination.sampleRange,
    confidence: clamp(
      0.35 + summary.weightedAgreement * 0.45 + Math.min(0.2, summary.weightedScore / 10),
      0,
      1,
    ),
    signalScore: summary.weightedScore + scenarios.score * settings.scenarioWeight,
    rawSignalStrength: Math.max(
      strongest.evaluation[direction].marketChangePct,
      strongest.evaluation[direction].activeChangePct,
    ),
    profitFactor: 0,
    directionEvaluation: strongest.evaluation,
    lane: strongest.evaluation[direction],
    scenarios,
    timeframeSeconds: "combined",
    timeframeCoordination: coordination,
  }
}

export interface SpecialPositionLeg {
  index: number
  triggerPositionCostRatio: number
  triggerMovePct: number
  incrementalVolumeRatio: number
  cumulativeVolumeRatio: number
}

export interface SpecialProtectionPlan {
  takeProfitPct: number
  stopLossPct: number
  takeProfitPrice: number
  stopLossPrice: number
  trailingEnabled: boolean
  trailingActivationPct: number
  trailingDistancePct: number
  trailingStepPct: number
  trailingActivationPrice: number
  trailingAdaptive: boolean
  trailingRegimeScore: number
  trailingRegimeTags: string[]
}

export interface SpecialPositionPlan {
  direction: EffectiveTradeDirection
  exitVariant: SpecialExitVariant
  logicalPositionCount: number
  maxPositionsPerDirection: number
  totalVolumeRatio: number
  maxVolumeRatio: number
  favorableMarketMovePct: number
  weightedEntryPrice: number
  scenarioTags: string[]
  scenarioVolumeScale: number
  minimumHoldingSeconds: number
  targetHoldingSeconds: number
  maximumHoldingSeconds: number
  legs: SpecialPositionLeg[]
  protection: SpecialProtectionPlan
}

function directionPrice(entry: number, pct: number, direction: EffectiveTradeDirection): number {
  const signed = direction === "long" ? pct : -pct
  return entry * (1 + signed / 100)
}

/**
 * Re-validate a Special plan at every persistence/execution boundary.
 *
 * The indication calculator normally creates an already-valid plan, but old
 * Redis rows, imports and manually edited settings are untrusted inputs.  This
 * normalizer therefore reapplies all non-bypassable Special limits and
 * rebuilds direction-sensitive absolute prices from the weighted entry rather
 * than trusting serialized values.
 */
export function sanitizeSpecialPositionPlan(
  value: unknown,
  expectedDirection: EffectiveTradeDirection,
): SpecialPositionPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const source = value as Partial<SpecialPositionPlan>
  if (source.direction !== expectedDirection) return null

  const weightedEntryPrice = Number(source.weightedEntryPrice)
  const requestedTakeProfitPct = Number(source.protection?.takeProfitPct)
  const requestedStopLossPct = Number(source.protection?.stopLossPct)
  if (
    !Number.isFinite(weightedEntryPrice) || weightedEntryPrice <= 0 ||
    !Number.isFinite(requestedTakeProfitPct) || requestedTakeProfitPct <= 0 ||
    !Number.isFinite(requestedStopLossPct) || requestedStopLossPct <= 0
  ) return null

  const logicalPositionCount = Math.min(
    SPECIAL_MAX_POSITIONS_PER_DIRECTION,
    Math.max(1, Math.floor(Number(source.logicalPositionCount) || 1)),
  )
  const totalVolumeRatio = clamp(
    Number(source.totalVolumeRatio) || 1,
    1,
    SPECIAL_MAX_VOLUME_RATIO,
  )
  const maxPositionsPerDirection = Math.min(
    SPECIAL_MAX_POSITIONS_PER_DIRECTION,
    Math.max(logicalPositionCount, Math.floor(Number(source.maxPositionsPerDirection) || logicalPositionCount)),
  )
  const maxVolumeRatio = clamp(
    Math.max(totalVolumeRatio, Number(source.maxVolumeRatio) || totalVolumeRatio),
    totalVolumeRatio,
    SPECIAL_MAX_VOLUME_RATIO,
  )
  const takeProfitPct = requestedTakeProfitPct
  const stopLossPct = Math.min(
    requestedStopLossPct,
    takeProfitPct * SPECIAL_MAX_SL_TO_TP_RATIO,
  )

  const rawLegs = Array.isArray(source.legs) ? source.legs : []
  const legs: SpecialPositionLeg[] = []
  let previousCumulative = 0
  for (let index = 0; index < logicalPositionCount; index++) {
    const raw = rawLegs[index]
    const evenlyDistributed = 1 + ((totalVolumeRatio - 1) * index) /
      Math.max(1, logicalPositionCount - 1)
    const requestedCumulative = index === logicalPositionCount - 1
      ? totalVolumeRatio
      : Number(raw?.cumulativeVolumeRatio)
    const cumulativeVolumeRatio = clamp(
      Number.isFinite(requestedCumulative) ? requestedCumulative : evenlyDistributed,
      previousCumulative,
      totalVolumeRatio,
    )
    legs.push({
      index: index + 1,
      triggerPositionCostRatio: Math.max(0, Number(raw?.triggerPositionCostRatio) || 0),
      triggerMovePct: Math.max(0, Number(raw?.triggerMovePct) || 0),
      incrementalVolumeRatio: Math.max(0, cumulativeVolumeRatio - previousCumulative),
      cumulativeVolumeRatio,
    })
    previousCumulative = cumulativeVolumeRatio
  }

  const trailingEnabled = source.protection?.trailingEnabled === true
  const trailingActivationPct = Math.max(
    0,
    Number(source.protection?.trailingActivationPct) || 0,
  )
  const trailingDistancePct = Math.min(
    trailingActivationPct,
    Math.max(0, Number(source.protection?.trailingDistancePct) || 0),
  )
  const trailingStepPct = Math.min(
    trailingDistancePct,
    Math.max(0, Number(source.protection?.trailingStepPct) || 0),
  )
  const trailingAdaptive = trailingEnabled && source.protection?.trailingAdaptive === true
  const trailingRegimeScore = Number.isFinite(Number(source.protection?.trailingRegimeScore))
    ? Number(source.protection?.trailingRegimeScore)
    : 0
  const trailingRegimeTags = Array.isArray(source.protection?.trailingRegimeTags)
    ? source.protection!.trailingRegimeTags.map(String).filter(Boolean).slice(0, 16)
    : []
  const minimumHoldingSeconds = integer(
    source.minimumHoldingSeconds,
    DEFAULT_SPECIAL_STRATEGY_SETTINGS.minimumHoldingSeconds,
    1,
    SPECIAL_MAX_HOLDING_SECONDS,
  )
  const maximumHoldingSeconds = integer(
    source.maximumHoldingSeconds,
    DEFAULT_SPECIAL_STRATEGY_SETTINGS.maximumHoldingSeconds,
    minimumHoldingSeconds,
    SPECIAL_MAX_HOLDING_SECONDS,
  )

  return {
    direction: expectedDirection,
    exitVariant: trailingEnabled ? "trailing" : "fixed",
    logicalPositionCount,
    maxPositionsPerDirection,
    totalVolumeRatio,
    maxVolumeRatio,
    favorableMarketMovePct: Math.max(0, Number(source.favorableMarketMovePct) || 0),
    weightedEntryPrice,
    scenarioTags: Array.isArray(source.scenarioTags)
      ? source.scenarioTags.map(String).filter(Boolean).slice(0, 16)
      : [],
    scenarioVolumeScale: clamp(Number(source.scenarioVolumeScale) || 1, 0.25, 1),
    minimumHoldingSeconds,
    targetHoldingSeconds: integer(
      source.targetHoldingSeconds,
      DEFAULT_SPECIAL_STRATEGY_SETTINGS.targetHoldingSeconds,
      minimumHoldingSeconds,
      maximumHoldingSeconds,
    ),
    maximumHoldingSeconds,
    legs,
    protection: {
      takeProfitPct,
      stopLossPct,
      takeProfitPrice: directionPrice(weightedEntryPrice, takeProfitPct, expectedDirection),
      stopLossPrice: directionPrice(weightedEntryPrice, -stopLossPct, expectedDirection),
      trailingEnabled,
      trailingActivationPct,
      trailingDistancePct,
      trailingStepPct,
      trailingActivationPrice: directionPrice(
        weightedEntryPrice,
        trailingActivationPct,
        expectedDirection,
      ),
      trailingAdaptive,
      trailingRegimeScore,
      trailingRegimeTags,
    },
  }
}

export interface SpecialAdaptiveTrailingProfile {
  activationPct: number
  distancePct: number
  stepPct: number
  adaptive: boolean
  regimeScore: number
  regimeTags: string[]
}

/**
 * Build the trailing lane's own bounded regime profile. Momentum/activity
 * persistence lets a move breathe, realised volatility widens noise buffers,
 * and reversal/exhaustion evidence tightens the ratchet. Fixed TP/SL never
 * consumes this profile.
 */
export function calculateSpecialAdaptiveTrailingProfile(input: {
  lane: SpecialDirectionLaneEvaluation
  scenarios?: SpecialScenarioCoordination
  takeProfitPct: number
  positionCostPct: number
  settings?: Partial<SpecialStrategySettings>
}): SpecialAdaptiveTrailingProfile {
  const settings = normalizeSpecialStrategySettings(input.settings as any)
  const takeProfitPct = Math.max(0.000001, Number(input.takeProfitPct) || 0)
  const positionCostPct = Math.max(0.000001, Number(input.positionCostPct) || 0)
  const scenarioTags = input.scenarios?.qualifiedScenarios || []
  const volatilityPressure = clamp(
    input.lane.volatilityPct / Math.max(settings.volatilityTargetPct, 0.000001),
    0,
    3,
  ) / 3
  const speedPersistence = clamp(Number(input.lane.marketChangeSpeedRatio) || 0, 0, 3) / 3
  const accelerationPersistence = clamp(
    Math.max(
      0,
      input.lane.accelerationPct / Math.max(settings.minimumMarketChangePct, 0.000001),
      Number(input.lane.speedAccelerationPctPerSecond) || 0,
    ),
    0,
    3,
  ) / 3
  const activityPersistence = clamp((Number(input.lane.activityRatio) || 1) - 1, 0, 2) / 2
  const continuationScenario = scenarioTags.some((tag) =>
    tag === "momentum_continuation" || tag === "market_acceleration" || tag === "activity_breakout",
  ) ? 1 : 0
  const reversalScenario = scenarioTags.includes("directional_reversal") ? 1 : 0
  const persistence = clamp(
    ((speedPersistence + accelerationPersistence) / 2) * settings.trailingSpeedAdaptationWeight +
    activityPersistence * settings.trailingActivityAdaptationWeight +
    continuationScenario * settings.trailingScenarioAdaptationWeight,
    0,
    3,
  )
  const risk = clamp(
    volatilityPressure * settings.trailingVolatilityAdaptationWeight +
    reversalScenario * settings.trailingScenarioAdaptationWeight,
    0,
    3,
  )
  const adaptive = settings.trailingEnabled && settings.trailingAdaptiveEnabled
  const activationScale = adaptive
    ? clamp(1 - persistence * 0.22 + risk * 0.12, 0.35, 1)
    : 1
  const distanceScale = adaptive
    ? clamp(1 + volatilityPressure * settings.trailingVolatilityAdaptationWeight * 0.3 +
        persistence * 0.18 - reversalScenario * 0.3, 0.45, 1.8)
    : 1
  const stepScale = adaptive
    ? clamp(1 + volatilityPressure * settings.trailingVolatilityAdaptationWeight * 0.15 -
        persistence * 0.2 - reversalScenario * 0.25, 0.35, 1.5)
    : 1
  const activationPct = Math.max(
    positionCostPct,
    takeProfitPct * settings.trailingActivationTakeProfitRatio * activationScale,
  )
  const distancePct = Math.min(
    activationPct,
    Math.max(
      positionCostPct * 0.5,
      takeProfitPct * settings.trailingDistanceTakeProfitRatio * distanceScale,
    ),
  )
  const stepPct = Math.min(
    distancePct,
    Math.max(
      positionCostPct * 0.25,
      takeProfitPct * settings.trailingStepTakeProfitRatio * stepScale,
    ),
  )
  const regimeTags = [
    ...(volatilityPressure > 0.5 ? ["volatile"] : []),
    ...(persistence > 0.5 ? ["persistent"] : []),
    ...(continuationScenario ? ["continuation"] : []),
    ...(reversalScenario ? ["reversal"] : []),
  ]
  return {
    activationPct,
    distancePct,
    stepPct,
    adaptive,
    regimeScore: persistence - risk,
    regimeTags,
  }
}

/**
 * Build/recalculate the coordinated Special logical-leg and protection plan.
 * The exchange may net same-side legs into one physical hedge-side position;
 * `legs` retain their independent triggers and cumulative volume audit trail.
 */
export function calculateSpecialPositionPlan(input: {
  indication: Pick<SpecialIndication, "direction" | "lane"> &
    Partial<Pick<SpecialIndication, "scenarios">>
  positionCostPct: number
  entryPrice: number
  currentPrice?: number
  roundTripCostPct?: number
  settings?: Partial<SpecialStrategySettings>
}): SpecialPositionPlan | null {
  const settings = normalizeSpecialStrategySettings(input.settings as any)
  const entryPrice = Number(input.entryPrice)
  const currentPrice = Number(input.currentPrice ?? entryPrice)
  const positionCostPct = Number(input.positionCostPct)
  if (
    !Number.isFinite(entryPrice) || entryPrice <= 0 ||
    !Number.isFinite(currentPrice) || currentPrice <= 0 ||
    !Number.isFinite(positionCostPct) || positionCostPct <= 0
  ) return null

  const direction = input.indication.direction
  const signedCurrentMovePct = percentChange(entryPrice, currentPrice) * (direction === "long" ? 1 : -1)
  const favorableMarketMovePct = Math.max(
    0,
    signedCurrentMovePct,
    Number(input.indication.lane.activeChangePct) || 0,
  )
  const addStepPct = positionCostPct * settings.additionalPositionStepPositionCostRatio
  const requestedCount = 1 + Math.floor(favorableMarketMovePct / Math.max(addStepPct, 0.000001))
  const logicalPositionCount = Math.min(
    SPECIAL_MAX_POSITIONS_PER_DIRECTION,
    settings.maxPositionsPerDirection,
    Math.max(1, requestedCount),
  )
  // Volatility management applies only to additive exposure. Base identity
  // remains 1×; extra legs scale down as realised volatility exceeds target.
  const volatilityPct = Math.max(0, Number(input.indication.lane.volatilityPct) || 0)
  const volatilityVolumeScale = volatilityPct > settings.volatilityTargetPct
    ? clamp(
        settings.volatilityTargetPct / Math.max(volatilityPct, 0.000001),
        settings.minimumVolatilityVolumeScale,
        1,
      )
    : 1
  const scenarioTags = input.indication.scenarios?.qualifiedScenarios || []
  const scenarioVolumeScale = scenarioTags.includes("directional_reversal")
    ? 0.75
    : scenarioTags.includes("momentum_continuation") || scenarioTags.includes("market_acceleration")
      ? 1
      : 0.85
  const targetTotalVolumeRatio = Math.min(
    SPECIAL_MAX_VOLUME_RATIO,
    settings.maxVolumeRatio,
    1 +
      (logicalPositionCount - 1) *
      settings.volumeIncrementRatio *
      volatilityVolumeScale *
      scenarioVolumeScale,
  )
  const legs: SpecialPositionLeg[] = []
  let previousCumulative = 0
  for (let index = 0; index < logicalPositionCount; index++) {
    const cumulative = index === logicalPositionCount - 1
      ? targetTotalVolumeRatio
      : Math.min(
          targetTotalVolumeRatio,
          1 + index * settings.volumeIncrementRatio,
        )
    legs.push({
      index: index + 1,
      triggerPositionCostRatio: index * settings.additionalPositionStepPositionCostRatio,
      triggerMovePct: index * addStepPct,
      incrementalVolumeRatio: Math.max(0, cumulative - previousCumulative),
      cumulativeVolumeRatio: cumulative,
    })
    previousCumulative = cumulative
  }

  const activeChangePct = Math.max(0, Number(input.indication.lane.activeChangePct) || 0)
  const roundTripCostPct = Math.max(
    0,
    Number.isFinite(Number(input.roundTripCostPct))
      ? Number(input.roundTripCostPct)
      : settings.roundTripCostPct,
  )
  const scenarioTakeProfitScale = scenarioTags.includes("activity_breakout") ||
    scenarioTags.includes("market_acceleration")
    ? 1.1
    : 1
  const takeProfitPct = clamp(
    Math.max(
      positionCostPct * settings.takeProfitMinPositionCostRatio,
      volatilityPct * settings.takeProfitVolatilityMultiplier * scenarioTakeProfitScale,
      activeChangePct * settings.takeProfitMarketChangeMultiplier * scenarioTakeProfitScale,
      roundTripCostPct * settings.minimumTakeProfitAfterCostsRatio,
    ),
    positionCostPct * settings.takeProfitMinPositionCostRatio,
    positionCostPct * settings.takeProfitMaxPositionCostRatio,
  )
  const unconstrainedStopLossPct = Math.max(
    positionCostPct * settings.stopLossMinPositionCostRatio,
    volatilityPct * settings.stopLossVolatilityMultiplier,
  )
  const stopLossPct = Math.max(
    0.01,
    Math.min(
      unconstrainedStopLossPct,
      takeProfitPct * settings.stopLossMaxTakeProfitRatio,
      takeProfitPct * SPECIAL_MAX_SL_TO_TP_RATIO,
    ),
  )
  const trailing = calculateSpecialAdaptiveTrailingProfile({
    lane: input.indication.lane,
    scenarios: input.indication.scenarios,
    takeProfitPct,
    positionCostPct,
    settings,
  })

  return {
    direction,
    exitVariant: settings.trailingEnabled ? "trailing" : "fixed",
    logicalPositionCount,
    maxPositionsPerDirection: Math.min(
      SPECIAL_MAX_POSITIONS_PER_DIRECTION,
      settings.maxPositionsPerDirection,
    ),
    totalVolumeRatio: targetTotalVolumeRatio,
    maxVolumeRatio: Math.min(SPECIAL_MAX_VOLUME_RATIO, settings.maxVolumeRatio),
    favorableMarketMovePct,
    weightedEntryPrice: entryPrice,
    scenarioTags,
    scenarioVolumeScale,
    minimumHoldingSeconds: settings.minimumHoldingSeconds,
    targetHoldingSeconds: settings.targetHoldingSeconds,
    maximumHoldingSeconds: settings.maximumHoldingSeconds,
    legs,
    protection: {
      takeProfitPct,
      stopLossPct,
      takeProfitPrice: directionPrice(entryPrice, takeProfitPct, direction),
      stopLossPrice: directionPrice(entryPrice, -stopLossPct, direction),
      trailingEnabled: settings.trailingEnabled,
      trailingActivationPct: trailing.activationPct,
      trailingDistancePct: trailing.distancePct,
      trailingStepPct: trailing.stepPct,
      trailingActivationPrice: directionPrice(entryPrice, trailing.activationPct, direction),
      trailingAdaptive: trailing.adaptive,
      trailingRegimeScore: trailing.regimeScore,
      trailingRegimeTags: trailing.regimeTags,
    },
  }
}

export interface SpecialBacktestSeries {
  symbol: string
  closes: readonly number[]
  volumes?: readonly number[]
  orderFlowImbalances?: readonly number[]
  spreadsBps?: readonly number[]
  timestamps?: readonly number[]
}

export interface SpecialBacktestTrade {
  symbol: string
  direction: EffectiveTradeDirection
  exitVariant: SpecialExitVariant
  entryIndex: number
  exitIndex: number
  entryPrice: number
  exitPrice: number
  entryTimestamp?: number
  exitTimestamp?: number
  pnlPct: number
  volumeRatio: number
  exitReason: "take_profit" | "stop_loss" | "trailing" | "activity_fade" | "time" | "end_of_series"
}

export interface SpecialBacktestSymbolMetrics {
  symbol: string
  trades: number
  wins: number
  losses: number
  grossProfitPct: number
  grossLossPct: number
  profitFactor: number
  maxDrawdownPct: number
  netPnlPct: number
}

export interface SpecialBacktestResult {
  exitVariant: SpecialExitVariant
  trades: SpecialBacktestTrade[]
  bySymbol: Record<string, SpecialBacktestSymbolMetrics>
  byDirection: Record<EffectiveTradeDirection, SpecialBacktestSymbolMetrics>
  totalTrades: number
  profitFactor: number
  stableProfitFactor: number
  profitFactorStdDev: number
  maxDrawdownPct: number
  netPnlPct: number
  longTrades: number
  shortTrades: number
  stableDirectionProfitFactor: number
  directionProfitFactorStdDev: number
  symbolCoverageQualified: boolean
  directionCoverageQualified: boolean
  robustScore: number
  qualified: boolean
}

type OpenBacktestTrade = {
  symbol: string
  direction: EffectiveTradeDirection
  entryIndex: number
  entryPrice: number
  entryTimestamp?: number
  plan: SpecialPositionPlan
  trailingStopPrice?: number
  trailingAnchorPrice?: number
}

function completedTrade(
  open: OpenBacktestTrade,
  exitIndex: number,
  exitPrice: number,
  exitReason: SpecialBacktestTrade["exitReason"],
  roundTripCostPct: number,
  exitTimestamp?: number,
): SpecialBacktestTrade {
  const sign = open.direction === "long" ? 1 : -1
  const pnlPct = (
    percentChange(open.entryPrice, exitPrice) * sign - Math.max(0, roundTripCostPct)
  ) * open.plan.totalVolumeRatio
  return {
    symbol: open.symbol,
    direction: open.direction,
    exitVariant: open.plan.exitVariant,
    entryIndex: open.entryIndex,
    exitIndex,
    entryPrice: open.entryPrice,
    exitPrice,
    entryTimestamp: open.entryTimestamp,
    exitTimestamp,
    pnlPct,
    volumeRatio: open.plan.totalVolumeRatio,
    exitReason,
  }
}

function backtestActivityAt(
  series: SpecialBacktestSeries,
  index: number,
  lookback: number,
): SpecialMarketActivityInput | undefined {
  const volumes = series.volumes?.slice(Math.max(0, index - lookback), index + 1)
  const orderFlowImbalance = series.orderFlowImbalances?.[index]
  const spreadBps = series.spreadsBps?.[index]
  if (!volumes && orderFlowImbalance === undefined && spreadBps === undefined) return undefined
  return { volumes, orderFlowImbalance, spreadBps }
}

function backtestElapsedSeconds(
  series: SpecialBacktestSeries,
  entryIndex: number,
  currentIndex: number,
): number {
  const start = Number(series.timestamps?.[entryIndex])
  const end = Number(series.timestamps?.[currentIndex])
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    const delta = end - start
    return start > 100_000_000_000 || end > 100_000_000_000 ? delta / 1_000 : delta
  }
  // VST validation uses one-minute candles when timestamps are unavailable.
  return Math.max(0, currentIndex - entryIndex) * 60
}

function causalSpecialTimeframeSeries(
  series: SpecialTimeframeSeries,
  currentTimestampMs: number,
  maximumSamples: number,
): SpecialTimeframeSeries | null {
  let low = 0
  let high = series.timestamps.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (series.timestamps[middle] <= currentTimestampMs) low = middle + 1
    else high = middle
  }
  const end = low
  if (end < 2) return null
  const start = Math.max(0, end - maximumSamples)
  return {
    timeframeSeconds: series.timeframeSeconds,
    closes: series.closes.slice(start, end),
    volumes: series.volumes.slice(start, end),
    timestamps: series.timestamps.slice(start, end),
  }
}

function strongestBacktestIndications(input: {
  prices: readonly number[]
  index: number
  settings: SpecialStrategySettings
  activity?: SpecialMarketActivityInput
  fullTimeframeSeries: readonly SpecialTimeframeSeries[]
  currentTimestampMs: number | null
  nativeCadenceSeconds: number | undefined
}): Record<EffectiveTradeDirection, SpecialIndication | null> {
  const strongest: Record<EffectiveTradeDirection, SpecialIndication | null> = {
    long: null,
    short: null,
  }
  const consider = (candidate: SpecialIndication | null) => {
    if (!candidate) return
    const previous = strongest[candidate.direction]
    if (!previous || candidate.signalScore > previous.signalScore) {
      strongest[candidate.direction] = candidate
    }
  }
  const causalFrames = input.currentTimestampMs === null
    ? []
    : input.fullTimeframeSeries
        .map((series) => causalSpecialTimeframeSeries(
          series,
          input.currentTimestampMs!,
          input.settings.maxStep + 1,
        ))
        .filter((series): series is SpecialTimeframeSeries => !!series)

  for (
    let range = input.settings.minStep;
    range <= input.settings.maxStep;
    range += input.settings.stepSize
  ) {
    if (input.settings.individualTimeframesEnabled) {
      for (const frame of causalFrames) {
        if (frame.closes.length < range + 1) continue
        for (const direction of ["long", "short"] as const) {
          const indication = evaluateSpecialIndication(
            frame.closes,
            direction,
            range,
            input.settings,
            { ...(input.activity || {}), volumes: frame.volumes },
            frame.timeframeSeconds,
          )
          if (indication) indication.timeframeSeconds = frame.timeframeSeconds
          consider(indication)
        }
      }
    }
    if (input.settings.combinedTimeframesEnabled && causalFrames.length > 0) {
      const coordination = evaluateSpecialMultiTimeframeCoordination({
        observations: [],
        prebuiltSeries: causalFrames,
        sampleRange: range,
        settings: input.settings,
        activity: input.activity,
      })
      if (coordination?.selectedDirection) {
        consider(specialIndicationFromMultiTimeframeCoordination(
          coordination,
          coordination.selectedDirection,
          input.settings,
        ))
      }
    }
    if (causalFrames.length === 0) {
      for (const direction of ["long", "short"] as const) {
        consider(evaluateSpecialIndication(
          input.prices.slice(0, input.index + 1),
          direction,
          range,
          input.settings,
          input.activity,
          input.nativeCadenceSeconds,
        ))
      }
    }
  }
  return strongest
}

function backtestSeries(
  series: SpecialBacktestSeries,
  settings: SpecialStrategySettings,
  positionCostPct: number,
): SpecialBacktestTrade[] {
  const prices = normalizedPrices(series.closes)
  const trades: SpecialBacktestTrade[] = []
  const openByDirection: Partial<Record<EffectiveTradeDirection, OpenBacktestTrade>> = {}
  const warmup = settings.maxStep + 1
  const timestampMs = prices.map((_, index) => epochMilliseconds(series.timestamps?.[index]))
  const timedObservations = prices
    .map((price, index) => ({ timestampMs: timestampMs[index] || 0, price, volume: Number(series.volumes?.[index]) || 0 }))
    .filter((observation) => observation.timestampMs > 0)
  const fullTimeframeSeries = enabledSpecialTimeframes(settings)
    .map((seconds) => buildSpecialTimeframeSeries(timedObservations, seconds))
    .filter((frame): frame is SpecialTimeframeSeries => !!frame)
  const timestampDeltasSeconds = timestampMs
    .slice(1)
    .map((timestamp, index) => timestamp && timestampMs[index]
      ? (timestamp - timestampMs[index]!) / 1_000
      : 0)
    .filter((delta) => delta > 0)
  const nativeCadenceSeconds = timestampDeltasSeconds.length > 0
    ? median(timestampDeltasSeconds)
    : 60

  for (let index = warmup; index < prices.length; index++) {
    const price = prices[index]
    const currentActivity = backtestActivityAt(series, index, settings.activityLookback)
    const strongestByDirection = strongestBacktestIndications({
      prices,
      index,
      settings,
      activity: currentActivity,
      fullTimeframeSeries,
      currentTimestampMs: timestampMs[index],
      nativeCadenceSeconds,
    })
    for (const direction of ["long", "short"] as const) {
      const open = openByDirection[direction]
      if (open) {
        const protection = open.plan.protection
        const tpHit = direction === "long"
          ? price >= protection.takeProfitPrice
          : price <= protection.takeProfitPrice
        const slHit = direction === "long"
          ? price <= protection.stopLossPrice
          : price >= protection.stopLossPrice
        const activationHit = direction === "long"
          ? price >= protection.trailingActivationPrice
          : price <= protection.trailingActivationPrice
        if (protection.trailingEnabled && activationHit) {
          const anchor = open.trailingAnchorPrice
          const stepDistance = Math.max(
            price * 0.000001,
            Number(anchor || price) * protection.trailingStepPct / 100,
          )
          const favorableStep = anchor === undefined || (
            direction === "long"
              ? price >= anchor + stepDistance
              : price <= anchor - stepDistance
          )
          if (favorableStep) {
            const candidate = direction === "long"
              ? price * (1 - protection.trailingDistancePct / 100)
              : price * (1 + protection.trailingDistancePct / 100)
            open.trailingAnchorPrice = price
            open.trailingStopPrice = open.trailingStopPrice === undefined
              ? candidate
              : direction === "long"
                ? Math.max(open.trailingStopPrice, candidate)
                : Math.min(open.trailingStopPrice, candidate)
          }
        }
        const trailingHit = open.trailingStopPrice !== undefined && (
          direction === "long"
            ? price <= open.trailingStopPrice
            : price >= open.trailingStopPrice
        )
        const holdingSteps = index - open.entryIndex
        const holdingSeconds = backtestElapsedSeconds(series, open.entryIndex, index)
        const currentLane = strongestByDirection[direction]?.lane
        const activityFade =
          holdingSteps >= settings.minimumHoldingSteps &&
          holdingSeconds >= settings.minimumHoldingSeconds &&
          currentLane?.activityRatio !== null &&
          currentLane?.activityRatio !== undefined &&
          currentLane.activityRatio < settings.marketActivityFadeRatio
        const targetTimeExit =
          holdingSeconds >= settings.targetHoldingSeconds &&
          currentLane?.qualified !== true
        const timeExit =
          holdingSteps >= settings.maximumHoldingSteps ||
          holdingSeconds >= settings.maximumHoldingSeconds
        if (slHit || trailingHit || tpHit || activityFade || targetTimeExit || timeExit) {
          const reason = slHit ? "stop_loss" : trailingHit ? "trailing" : "take_profit"
          trades.push(completedTrade(
            open,
            index,
            price,
            activityFade ? "activity_fade" : targetTimeExit || timeExit ? "time" : reason,
            settings.roundTripCostPct,
            Number(series.timestamps?.[index]) || undefined,
          ))
          delete openByDirection[direction]
        } else {
          const indication = strongestByDirection[direction]
          if (indication) {
            const recalculated = calculateSpecialPositionPlan({
              indication,
              positionCostPct,
              entryPrice: open.entryPrice,
              currentPrice: price,
              roundTripCostPct: settings.roundTripCostPct,
              settings,
            })
            if (recalculated) open.plan = recalculated
          }
        }
      }
    }

    // Entries are evaluated only from data available at this index. Long and
    // Short have independent books; within one exact range a neutral/tie emits
    // neither direction and never fabricates a pair.
    for (const direction of ["long", "short"] as const) {
      if (openByDirection[direction]) continue
      const strongest = strongestByDirection[direction]
      if (!strongest) continue
      const plan = calculateSpecialPositionPlan({
        indication: strongest,
        positionCostPct,
        entryPrice: price,
        currentPrice: price,
        roundTripCostPct: settings.roundTripCostPct,
        settings,
      })
      if (!plan) continue
      openByDirection[direction] = {
        symbol: series.symbol,
        direction,
        entryIndex: index,
        entryPrice: price,
        entryTimestamp: Number(series.timestamps?.[index]) || undefined,
        plan,
      }
    }
  }

  const finalIndex = prices.length - 1
  if (finalIndex >= 0) {
    for (const direction of ["long", "short"] as const) {
      const open = openByDirection[direction]
      if (open) trades.push(completedTrade(
        open,
        finalIndex,
        prices[finalIndex],
        "end_of_series",
        settings.roundTripCostPct,
        Number(series.timestamps?.[finalIndex]) || undefined,
      ))
    }
  }
  return trades
}

function metricsForSymbol(symbol: string, trades: readonly SpecialBacktestTrade[]): SpecialBacktestSymbolMetrics {
  let grossProfitPct = 0
  let grossLossPct = 0
  let equity = 0
  let peak = 0
  let maxDrawdownPct = 0
  let wins = 0
  let losses = 0
  for (const trade of trades) {
    equity += trade.pnlPct
    peak = Math.max(peak, equity)
    maxDrawdownPct = Math.max(maxDrawdownPct, peak - equity)
    if (trade.pnlPct > 0) {
      wins++
      grossProfitPct += trade.pnlPct
    } else if (trade.pnlPct < 0) {
      losses++
      grossLossPct += -trade.pnlPct
    }
  }
  return {
    symbol,
    trades: trades.length,
    wins,
    losses,
    grossProfitPct,
    grossLossPct,
    profitFactor: grossLossPct > 0 ? grossProfitPct / grossLossPct : grossProfitPct > 0 ? 100 : 0,
    maxDrawdownPct,
    netPnlPct: grossProfitPct - grossLossPct,
  }
}

export interface SpecialTwoHourIntervalStats {
  intervalStart: number
  intervalEnd: number
  pisCount: number
  longCount: number
  shortCount: number
  grossProfitPct: number
  grossLossPct: number
  profitFactor: number
  maxDrawdownPct: number
  maxDrawdownDurationSeconds: number
}

function epochMilliseconds(value: unknown): number | null {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null
  return timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp
}

/** Last 24 hours in twelve visible 2-hour buckets, all symbols combined. */
export function calculateSpecial24HourTwoHourStats(
  trades: readonly SpecialBacktestTrade[],
  endTimestamp?: number,
): SpecialTwoHourIntervalStats[] {
  const intervalMs = 2 * 60 * 60 * 1_000
  const latestTradeTime = trades.reduce((latest, trade) =>
    Math.max(latest, epochMilliseconds(trade.exitTimestamp) || 0), 0)
  const requestedEnd = epochMilliseconds(endTimestamp)
  const rawEnd = requestedEnd || latestTradeTime
  if (!(rawEnd > 0)) return []
  const alignedEnd = Math.ceil(rawEnd / intervalMs) * intervalMs
  const start = alignedEnd - 12 * intervalMs

  return Array.from({ length: 12 }, (_, index) => {
    const intervalStart = start + index * intervalMs
    const intervalEnd = intervalStart + intervalMs
    const bucket = trades
      .filter((trade) => {
        const timestamp = epochMilliseconds(trade.exitTimestamp)
        return timestamp !== null && timestamp >= intervalStart && timestamp < intervalEnd
      })
      .sort((left, right) =>
        (epochMilliseconds(left.exitTimestamp) || 0) - (epochMilliseconds(right.exitTimestamp) || 0),
      )
    let equity = 0
    let peak = 0
    let maxDrawdownPct = 0
    let underwaterStartedAt: number | null = null
    let maxDrawdownDurationSeconds = 0
    let grossProfitPct = 0
    let grossLossPct = 0
    for (const trade of bucket) {
      const timestamp = epochMilliseconds(trade.exitTimestamp) || intervalStart
      equity += trade.pnlPct
      if (trade.pnlPct > 0) grossProfitPct += trade.pnlPct
      else if (trade.pnlPct < 0) grossLossPct += -trade.pnlPct
      if (equity >= peak) {
        if (underwaterStartedAt !== null) {
          maxDrawdownDurationSeconds = Math.max(
            maxDrawdownDurationSeconds,
            (timestamp - underwaterStartedAt) / 1_000,
          )
        }
        peak = equity
        underwaterStartedAt = null
      } else {
        underwaterStartedAt ??= timestamp
        maxDrawdownPct = Math.max(maxDrawdownPct, peak - equity)
      }
    }
    if (underwaterStartedAt !== null) {
      maxDrawdownDurationSeconds = Math.max(
        maxDrawdownDurationSeconds,
        (intervalEnd - underwaterStartedAt) / 1_000,
      )
    }
    return {
      intervalStart,
      intervalEnd,
      pisCount: bucket.length,
      longCount: bucket.filter((trade) => trade.direction === "long").length,
      shortCount: bucket.filter((trade) => trade.direction === "short").length,
      grossProfitPct,
      grossLossPct,
      profitFactor: grossLossPct > 0
        ? grossProfitPct / grossLossPct
        : grossProfitPct > 0 ? 100 : 0,
      maxDrawdownPct,
      maxDrawdownDurationSeconds,
    }
  })
}

/**
 * Causal multi-symbol backtest. The robust score rewards the weakest symbol's
 * PF and penalises cross-symbol PF variance and portfolio drawdown, preventing
 * one unusually profitable market from hiding unstable configurations.
 */
export function backtestSpecialStrategy(input: {
  series: readonly SpecialBacktestSeries[]
  settings?: Partial<SpecialStrategySettings>
  positionCostPct: number
}): SpecialBacktestResult {
  const settings = normalizeSpecialStrategySettings(input.settings as any)
  const trades = input.series.flatMap((series) => backtestSeries(series, settings, input.positionCostPct))
  const bySymbol: Record<string, SpecialBacktestSymbolMetrics> = {}
  for (const series of input.series) {
    const symbolTrades = trades.filter((trade) => trade.symbol === series.symbol)
    bySymbol[series.symbol] = metricsForSymbol(series.symbol, symbolTrades)
  }
  const symbolMetrics = Object.values(bySymbol)
  const byDirection = {
    long: metricsForSymbol("long", trades.filter((trade) => trade.direction === "long")),
    short: metricsForSymbol("short", trades.filter((trade) => trade.direction === "short")),
  }
  const grossProfitPct = symbolMetrics.reduce((sum, metrics) => sum + metrics.grossProfitPct, 0)
  const grossLossPct = symbolMetrics.reduce((sum, metrics) => sum + metrics.grossLossPct, 0)
  const profitFactor = grossLossPct > 0 ? grossProfitPct / grossLossPct : grossProfitPct > 0 ? 100 : 0
  const symbolProfitFactors = symbolMetrics.map((metrics) => metrics.profitFactor)
  const directionProfitFactors = [byDirection.long.profitFactor, byDirection.short.profitFactor]
  const stableDirectionProfitFactor = Math.min(...directionProfitFactors)
  const directionProfitFactorStdDev = standardDeviation(directionProfitFactors)
  const stableProfitFactor = symbolProfitFactors.length > 0
    ? Math.min(...symbolProfitFactors, stableDirectionProfitFactor)
    : 0
  const profitFactorStdDev = standardDeviation([...symbolProfitFactors, ...directionProfitFactors])
  const maxDrawdownPct = symbolMetrics.length > 0
    ? Math.max(...symbolMetrics.map((metrics) => metrics.maxDrawdownPct))
    : 0
  const symbolCoverageQualified = symbolMetrics.every((metrics) =>
    metrics.trades >= settings.backtestMinimumTradesPerSymbol,
  )
  const directionCoverageQualified = Object.values(byDirection).every((metrics) =>
    metrics.trades >= settings.backtestMinimumTradesPerDirection,
  )
  const robustScore =
    stableProfitFactor -
    profitFactorStdDev * 0.5 -
    directionProfitFactorStdDev * 0.25 -
    maxDrawdownPct / 100
  return {
    exitVariant: settings.trailingEnabled ? "trailing" : "fixed",
    trades,
    bySymbol,
    byDirection,
    totalTrades: trades.length,
    profitFactor,
    stableProfitFactor,
    profitFactorStdDev,
    maxDrawdownPct,
    netPnlPct: grossProfitPct - grossLossPct,
    longTrades: trades.filter((trade) => trade.direction === "long").length,
    shortTrades: trades.filter((trade) => trade.direction === "short").length,
    stableDirectionProfitFactor,
    directionProfitFactorStdDev,
    symbolCoverageQualified,
    directionCoverageQualified,
    robustScore,
    qualified:
      trades.length >= settings.backtestMinimumTrades &&
      symbolCoverageQualified &&
      directionCoverageQualified &&
      stableProfitFactor >= settings.backtestMinimumStableProfitFactor &&
      maxDrawdownPct <= settings.backtestMaximumDrawdownPct,
  }
}

export interface SpecialOptimizationResult {
  settings: SpecialStrategySettings
  result: SpecialBacktestResult
}

function expandSpecialOptimizationSettings(input: {
  candidates: readonly Partial<SpecialStrategySettings>[]
  baseSettings?: Partial<SpecialStrategySettings>
}): SpecialStrategySettings[] {
  const unique = new Map<string, SpecialStrategySettings>()
  for (const candidate of input.candidates) {
    const merged = normalizeSpecialStrategySettings({
      ...(input.baseSettings || {}),
      ...candidate,
    } as any)
    for (const variant of specialExitVariantSettings(merged)) {
      const key = JSON.stringify(variant.settings)
      if (!unique.has(key)) unique.set(key, variant.settings)
    }
  }
  return [...unique.values()]
}

/** Rank complete configurations by out-of-symbol stability, then drawdown. */
export function optimizeSpecialStrategy(input: {
  series: readonly SpecialBacktestSeries[]
  candidates: readonly Partial<SpecialStrategySettings>[]
  baseSettings?: Partial<SpecialStrategySettings>
  positionCostPct: number
}): SpecialOptimizationResult[] {
  return expandSpecialOptimizationSettings(input)
    .map((settings) => {
      return {
        settings,
        result: backtestSpecialStrategy({
          series: input.series,
          settings,
          positionCostPct: input.positionCostPct,
        }),
      }
    })
    .sort((left, right) =>
      Number(right.result.qualified) - Number(left.result.qualified) ||
      right.result.robustScore - left.result.robustScore ||
      left.result.maxDrawdownPct - right.result.maxDrawdownPct ||
      right.result.totalTrades - left.result.totalTrades,
    )
}

export interface SpecialWalkForwardResult extends SpecialOptimizationResult {
  folds: SpecialBacktestResult[]
  worstFoldProfitFactor: number
  foldProfitFactorStdDev: number
  catastrophicVeto: boolean
  walkForwardQualified: boolean
  walkForwardScore: number
}

/**
 * Purged chronological walk-forward validation. Candidate ranking is based on
 * the weakest out-of-sample fold and stability, never on one full-period peak.
 */
export function walkForwardOptimizeSpecialStrategy(input: {
  series: readonly SpecialBacktestSeries[]
  candidates: readonly Partial<SpecialStrategySettings>[]
  baseSettings?: Partial<SpecialStrategySettings>
  positionCostPct: number
}): SpecialWalkForwardResult[] {
  return expandSpecialOptimizationSettings(input)
    .map((settings): SpecialWalkForwardResult => {
      const result = backtestSpecialStrategy({
        series: input.series,
        settings,
        positionCostPct: input.positionCostPct,
      })
      const minimumLength = input.series.length > 0
        ? Math.min(...input.series.map((series) => series.closes.length))
        : 0
      const warmup = settings.maxStep + 1
      const foldsCount = settings.walkForwardFolds
      const usable = Math.max(0, minimumLength - warmup - settings.walkForwardPurgeSteps * (foldsCount - 1))
      const foldSize = Math.floor(usable / foldsCount)
      const folds: SpecialBacktestResult[] = []
      if (foldSize > warmup) {
        for (let foldIndex = 0; foldIndex < foldsCount; foldIndex++) {
          const testStart = warmup + foldIndex * (foldSize + settings.walkForwardPurgeSteps)
          const testEnd = Math.min(minimumLength, testStart + foldSize)
          const sliceStart = Math.max(0, testStart - warmup)
          const foldSeries = input.series.map((series) => ({
            ...series,
            closes: series.closes.slice(sliceStart, testEnd),
            volumes: series.volumes?.slice(sliceStart, testEnd),
            orderFlowImbalances: series.orderFlowImbalances?.slice(sliceStart, testEnd),
            spreadsBps: series.spreadsBps?.slice(sliceStart, testEnd),
            timestamps: series.timestamps?.slice(sliceStart, testEnd),
          }))
          folds.push(backtestSpecialStrategy({
            series: foldSeries,
            settings: {
              ...settings,
              backtestMinimumTrades: Math.max(1, Math.floor(settings.backtestMinimumTrades / foldsCount)),
              backtestMinimumTradesPerDirection: Math.max(
                0,
                Math.floor(settings.backtestMinimumTradesPerDirection / foldsCount),
              ),
              backtestMinimumTradesPerSymbol: Math.max(
                0,
                Math.floor(settings.backtestMinimumTradesPerSymbol / foldsCount),
              ),
            },
            positionCostPct: input.positionCostPct,
          }))
        }
      }
      const foldProfitFactors = folds.map((fold) => fold.stableProfitFactor)
      const worstFoldProfitFactor = foldProfitFactors.length > 0
        ? Math.min(...foldProfitFactors)
        : 0
      const foldProfitFactorStdDev = standardDeviation(foldProfitFactors)
      const catastrophicVeto =
        folds.length !== foldsCount ||
        folds.some((fold) =>
          fold.netPnlPct < -settings.walkForwardMaximumFoldLossPct ||
          fold.maxDrawdownPct > settings.backtestMaximumDrawdownPct,
        )
      const walkForwardQualified =
        result.qualified &&
        !catastrophicVeto &&
        folds.every((fold) => fold.qualified) &&
        worstFoldProfitFactor >= settings.backtestMinimumStableProfitFactor
      const walkForwardScore =
        worstFoldProfitFactor -
        foldProfitFactorStdDev * 0.5 -
        Math.max(0, ...folds.map((fold) => fold.maxDrawdownPct)) / 100
      return {
        settings,
        result,
        folds,
        worstFoldProfitFactor,
        foldProfitFactorStdDev,
        catastrophicVeto,
        walkForwardQualified,
        walkForwardScore,
      }
    })
    .sort((left, right) =>
      Number(right.walkForwardQualified) - Number(left.walkForwardQualified) ||
      right.walkForwardScore - left.walkForwardScore ||
      left.result.maxDrawdownPct - right.result.maxDrawdownPct ||
      right.result.totalTrades - left.result.totalTrades,
    )
}
