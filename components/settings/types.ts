/**
 * Settings Type Definitions
 */

export interface Settings {
  // Overall / Main
  base_volume_factor: number
  volume_step_ratio: number
  positions_average: number
  max_leverage: number
  negativeChangePercent: number
  leveragePercentage: number
  prehistoricDataDays: number
  /**
   * Hours of prehistoric (historical) candle data to load on engine start.
   * UI: slider 1-50 hours, step 1, default 8. Stored in Redis under
   * `app_settings.prehistoric_range_hours` (snake_case is intentional — the
   * engine-manager reads from this exact key).
   */
  prehistoric_range_hours: number
  marketTimeframe: number
  tradeIntervalSeconds: number
  realPositionsIntervalSeconds: number
  validationTimeoutSeconds: number
  mainTradeInterval: number
  presetTradeInterval: number
  /** Percent of account balance budgeted per position. Range/default floor: 0.02% - 1.0%. */
  positionCost: number
  useMaximalLeverage: boolean
  min_volume_enforcement: boolean

  /**
   * Minimum exhaustive Base step. Default 4; every integer window from the
   * selected minimum through 30 is generated without sampling.
   */
  minStep: number
  maxStopLossRatio: number
  trailingMinStep: number

  // Base Strategy
  baseValueRangeMin: number
  baseValueRangeMax: number
  baseRatioMin: number
  baseRatioMax: number
  trailingOption: boolean

  /**
   * Multi-step trailing for Base Strategies.
   *
   * Spec: each enabled (start, stop) combo spawns one INDEPENDENT Base Set
   * per (indication_type × direction), so the engine evaluates the full
   * configuration matrix in parallel. Operator can prune the matrix in
   * Settings → Strategy → Trailing.
   *
   * Units: ratios where 0.1 ≡ 10% (decimal of price change).
   *   trailingStart  ∈ {0.3, 0.6, 0.9, 1.2, 1.5}    (activation gain)
   *   trailingStop   ∈ {0.1, 0.2, 0.3, 0.4, 0.5}    (trail distance)
   *   trailingStep   = trailingStop / 2              (derived; ratchet
   *                                                   minimum increment)
   *
   * `strategyBaseTrailingVariants` is a list of "start:stop" tokens
   * (e.g. "0.3:0.1") — one entry per ENABLED combo. Empty array means
   * multi-trailing is effectively off even with the master toggle on.
   */
  strategyBaseTrailingEnabled: boolean
  strategyBaseTrailingVariants: string[]

  // Main Strategy
  previousPositionsCount: number
  lastStateCount: number

  // Trailing Configuration
  trailingEnabled: boolean
  trailingStartValues: string
  trailingStopValues: string

  // Adjustment Strategies
  blockAdjustment: boolean
  dcaAdjustment: boolean
  block_enabled: boolean
  dca_enabled: boolean

  // Symbol Selection
  arrangementType: string
  quoteAsset: string

  // ── Main Trade PF thresholds per stage (Base/Main/Real/Live) ─────
  // Operator-tunable via Settings → Strategy → Main → Profit Factor
  // PositionCost-relative thresholds on the canonical 0.08..2.70/0.02
  // grid. Defaults: Base Valid 0.40; Main/Real/Live 1.12. These are deliberately
  // distinct from realised PF (gross profit / gross loss).
  baseProfitFactor: number
  mainProfitFactor: number
  realProfitFactor: number
  liveProfitFactor: number

  // Risk Management
  trailingStopLoss: boolean
  // Per-stage Max Drawdown-Time ceilings (hours), wired into the engine
  // DDT gate by `lib/strategy-coordinator.ts:loadAppPFThresholds()`.
  maxDrawdownTimeMainHours: number
  maxDrawdownTimeRealHours: number
  maxDrawdownTimeLiveHours: number

  // Trade Engine Intervals (milliseconds)
  mainEngineIntervalMs: number
  presetEngineIntervalMs: number
  activeOrderHandlingIntervalMs: number

  // Database Size Configuration
  databaseSizeBase: number
  databaseSizeMain: number
  databaseSizeReal: number
  databaseSizePreset: number

  // Trade Engine Configuration
  positionCooldownMs: number
  maxPositionsPerConfigDirection: number
  maxConcurrentOperations: number
  /**
   * Exact-lane occupancy fixed at one. The lane includes connection, symbol,
   * indication type/name/full config, direction and Base Set, so it never
   * limits sibling configs or the total Base inventory.
   */
  maxActiveBasePseudoPositionsPerDirection: number

  /** Strategy retention/scheduling controls surfaced in Settings → System. */
  strategyMaxEntriesPerSet: number
  /** Number of Base Sets expanded in one async Main-axis work batch. */
  strategyMainAxisBatchSize: number
  /** Inactive Block rows materialized per rotating Real/Live work cycle. */
  strategyBlockMaterializationBatchSize: number
  strategyRealSetsSafetyCeiling: number
  maxRealSets: number
  strategyLiveSetsCeiling: number

  // System Configuration
  autoRestartOnErrors: boolean
  logLevel: string

  // Database Management
  maxDatabaseSizeMB: number
  databaseThresholdPercent: number
  automaticDatabaseCleanup: boolean
  automaticDatabaseBackups: boolean
  backupInterval: string

  // Connection Settings
  minimumConnectIntervalMs: number
  symbolsPerExchange: number

  // Connection Defaults
  defaultMarginType: string
  defaultPositionMode: string
  rateLimitDelayMs: number
  maxConcurrentConnections: number
  enableTestnetByDefault: boolean

  // Application Logs
  logsLevel: string
  logsCategory: string
  logsLimit: number

  // Monitoring Configuration
  enableSystemMonitoring: boolean
  metricsRetentionDays: number

  mainEngineEnabled: boolean
  presetEngineEnabled: boolean

  mainSymbols: string[]
  forcedSymbols: string[]

  useMainSymbols: boolean
  numberOfSymbolsToSelect: number
  symbolOrderType: string

  // Indication
  indication_time_interval: number
  indication_range_min: number
  indication_range_max: number
  indication_min_profit_factor: number

  // Strategy
  strategy_time_interval: number
  strategy_min_profit_factor: number
  stepRelationMinRatio: number
  stepRelationMaxRatio: number

  // Main Indication Settings
  marketActivityEnabled: boolean
  marketActivityCalculationRange: number
  marketActivityPositionCostRatio: number
  directionEnabled: boolean
  directionInterval: number
  directionTimeout: number
  directionRangeFrom: number
  directionRangeTo: number
  moveEnabled: boolean
  moveInterval: number
  moveTimeout: number
  activeEnabled: boolean
  activeInterval: number
  activeTimeout: number
  defaultCoordinationEnabled: boolean
  defaultCoordinationRanges: number[] | string
  defaultCoordinationRangeSteps: number[] | string
  defaultCoordinationDrawdownRatios: number[] | string
  defaultCoordinationHigherRangeDrawdownScale: number
  defaultCoordinationMinAgreement: number
  defaultCoordinationMinimumSignals: number
  defaultCoordinationShortDifferenceRatio: number
  directionPostChangeOnly: boolean
  indicationSampleRanges: number[] | string
  indicationDrawdownRatios: number[] | string
  indicationLastPartRatios: number[] | string
  indicationFactorMultipliers: number[] | string
  activeThresholds: number[] | string
  activeTimeRatios: number[] | string
  activeAdvancedEnabled: boolean
  activeAdvancedActivityRatios: number[] | string
  activeAdvancedMinPositions: number
  activeAdvancedContinuationRatio: number

  // Optimal Indication Settings
  optimalEnabled: boolean
  optimalSampleRanges: number[] | string
  optimalCoordinationEnabled: boolean
  trailingOptimalRanges: boolean
  simultaneousTrading: boolean
  positionIncrementAfterSituation: boolean
  autoEnabled: boolean

  // Trend Indication Settings (final Main indication type)
  trendEnabled: boolean
  trendTimeframesMinutes: number[] | string
  trendDrawdownValues: number[] | string
  trendLastSituationRatios: number[] | string
  trendActiveSituationRatios: number[] | string
  trendMinAgreement: number
  trendCombinedEnabled: boolean
  trendRangeSteps: number[] | string
  trendHigherRangeDrawdownScale: number
  trendTpMinMultiplier: number
  trendTpMaxFactor: number
  trendTpStep: number
  databaseSizeTrend: number

  // Common Indicators
  rsiEnabled: boolean
  rsiPeriod: number
  rsiOversold: number
  rsiOverbought: number
  rsiPeriodFrom: number
  rsiPeriodTo: number
  rsiPeriodStep: number
  rsiOversoldFrom: number
  rsiOversoldTo: number
  rsiOversoldStep: number
  rsiOverboughtFrom: number
  rsiOverboughtTo: number
  rsiOverboughtStep: number

  macdEnabled: boolean
  macdFastPeriod: number
  macdSlowPeriod: number
  macdSignalPeriod: number
  macdFastPeriodFrom: number
  macdFastPeriodTo: number
  macdFastPeriodStep: number
  macdSlowPeriodFrom: number
  macdSlowPeriodTo: number
  macdSlowPeriodStep: number
  macdSignalPeriodFrom: number
  macdSignalPeriodTo: number
  macdSignalPeriodStep: number

  bollingerEnabled: boolean
  bollingerPeriod: number
  bollingerStdDev: number
  bollingerPeriodFrom: number
  bollingerPeriodTo: number
  bollingerPeriodStep: number
  bollingerStdDevFrom: number
  bollingerStdDevTo: number
  bollingerStdDevStep: number

  emaEnabled: boolean
  emaShortPeriod: number
  emaLongPeriod: number
  emaShortPeriodFrom: number
  emaShortPeriodTo: number
  emaShortPeriodStep: number
  emaLongPeriodFrom: number
  emaLongPeriodTo: number
  emaLongPeriodStep: number

  smaEnabled: boolean
  smaShortPeriod: number
  smaLongPeriod: number
  smaShortPeriodFrom: number
  smaShortPeriodTo: number
  smaShortPeriodStep: number
  smaLongPeriodFrom: number
  smaLongPeriodTo: number
  smaLongPeriodStep: number

  stochasticEnabled: boolean
  stochasticKPeriod: number
  stochasticDPeriod: number
  stochasticSlowing: number
  stochasticKPeriodFrom: number
  stochasticKPeriodTo: number
  stochasticKPeriodStep: number
  stochasticDPeriodFrom: number
  stochasticDPeriodTo: number
  stochasticDPeriodStep: number
  stochasticSlowingFrom: number
  stochasticSlowingTo: number
  stochasticSlowingStep: number

  adxEnabled: boolean
  adxPeriod: number
  adxThreshold: number
  adxPeriodFrom: number
  adxPeriodTo: number
  adxPeriodStep: number
  adxThresholdFrom: number
  adxThresholdTo: number
  adxThresholdStep: number

  atrEnabled: boolean
  atrPeriod: number
  atrMultiplier: number
  atrPeriodFrom: number
  atrPeriodTo: number
  atrPeriodStep: number
  atrMultiplierFrom: number
  atrMultiplierTo: number
  atrMultiplierStep: number

  // Parabolic SAR
  parabolicSAREnabled: boolean
  parabolicSARAcceleration: number
  parabolicSARMaximum: number
  parabolicSARAccelerationFrom: number
  parabolicSARAccelerationTo: number
  parabolicSARAccelerationStep: number
  parabolicSARMaximumFrom: number
  parabolicSARMaximumTo: number
  parabolicSARMaximumStep: number

  autoRestartOnError: boolean
  restartCooldownMinutes: number
  maxRestartAttempts: number

  // Exchange-specific overrides
  exchangeDirectionEnabled: boolean
  exchangeMoveEnabled: boolean
  exchangeActiveEnabled: boolean
  exchangeOptimalEnabled: boolean
  exchangeBaseStrategyEnabled: boolean
  exchangeMainStrategyEnabled: boolean
  exchangeRealStrategyEnabled: boolean
  exchangeTrailingEnabled: boolean
  exchangeBlockEnabled: boolean
  exchangeDcaEnabled: boolean

  maxPositionsPerExchange: Record<string, number>

  // Indication Settings Defaults
  directionRangeStep: number
  directionDrawdownValues: string
  directionMarketChangeFrom: number
  directionMarketChangeTo: number
  directionMarketChangeStep: number
  directionMinCalcTime: number
  directionLastPartRatio: number
  directionRatioFactorFrom: number
  directionRatioFactorTo: number
  directionRatioFactorStep: number

  moveRangeFrom: number
  moveRangeTo: number
  moveRangeStep: number
  moveDrawdownValues: string
  moveMarketChangeFrom: number
  moveMarketChangeTo: number
  moveMarketChangeStep: number
  moveMinCalcTime: number
  moveLastPartRatio: number
  moveRatioFactorFrom: number
  moveRatioFactorTo: number
  moveRatioFactorStep: number

  activeRangeFrom: number
  activeRangeTo: number
  activeRangeStep: number
  activeDrawdownValues: string
  activeMarketChangeFrom: number
  activeMarketChangeTo: number
  activeMarketChangeStep: number
  activeMinCalcTime: number
  activeLastPartRatio: number
  activeRatioFactorFrom: number
  activeRatioFactorTo: number
  activeRatioFactorStep: number
  activeCalculatedFrom: number
  activeCalculatedTo: number
  activeCalculatedStep: number
  activeLastPartFrom: number
  activeLastPartTo: number
  activeLastPartStep: number

  database_type: string
}
