export interface ExchangeConnection {
  id: string
  user_id?: number
  name: string
  exchange: string
  exchange_id?: number | null
  api_type: string
  contract_type?: string // usdt-perpetual, coin-perpetual, spot
  api_subtype?: string
  connection_method: string
  connection_library?: string
  api_key: string
  api_secret: string
  api_passphrase?: string
  margin_type: string
  position_mode: string
  is_testnet: boolean
  volume_factor?: number
  last_test_status?: string
  last_test_balance?: number
  last_test_error?: string
  last_test_log?: string[]
  last_test_timestamp?: string
  last_test_btc_price?: number
  last_test_at?: string
  api_capabilities?: string[]
  rate_limits?: {
    requests_per_second: number
    requests_per_minute: number
  }
  is_enabled: boolean
  is_inserted?: boolean | string
  is_enabled_dashboard?: boolean | string
  is_active_inserted?: boolean | string
  is_main_enabled: boolean
  is_live_trade: boolean
  is_preset_trade?: boolean
  is_active?: boolean
  is_assigned?: boolean
  is_main_assigned?: boolean
  is_predefined?: boolean
  connection_priority?: string[]
  use_main_symbols?: boolean
  arrangement_type?: "market_cap" | "market_volume" | "market_volatility" | "price_change" | "liquidity"
  arrangement_count?: number
  preset_type_id?: string
  created_at: string
  updated_at?: string
}

export interface PseudoPosition {
  id: string
  connection_id: string
  symbol: string
  direction?: "long" | "short"
  indication_type: "direction" | "move" | "active" | "optimal" | "auto" // auto is new advanced type
  takeprofit_factor: number
  stoploss_ratio: number
  trailing_enabled: boolean
  trail_start?: number
  trail_stop?: number
  entry_price: number
  current_price: number
  profit_factor: number
  signedResultR?: number
  costNormalizedReturn?: number
  signed_result_r?: number
  position_cost: number
  status: "open" | "closed"
  created_at: string
  updated_at: string
  base_position_id?: string // Added link to base pseudo position

  indication_range?: number // Range value used (2-30 for direction/move, 1-10 for active)
  indication_interval?: number // Interval in ms for indication processing
  indication_timeout?: number // Timeout in seconds for indication

  strategy_type?: "base" | "main" | "real" | "preset" | "block" | "level" | "dca"
  strategy_step?: number // Current step in multi-step strategies
  strategy_interval?: number // Interval in ms for strategy processing (50-1000ms)

  position_age_seconds?: number // How long position has been open
  last_update_interval?: number // Time since last update in ms
  avg_update_interval?: number // Average time between updates
  total_updates?: number // Count of position updates

  initial_profit_factor?: number // Profit factor at creation
  max_profit_factor?: number // Maximum profit factor reached
  min_profit_factor?: number // Minimum profit factor (for drawdown)
  avg_profit_factor?: number // Average profit factor over lifetime
  profit_factor_volatility?: number // Standard deviation of profit factor changes

  last_check_timestamp?: string // Last time position was checked
  checks_per_minute?: number // Frequency of position checks
  price_updates_count?: number // Number of price updates received

  activity_ratio?: number
  time_window?: number
  overall_change?: number
  last_part_change?: number
  volatility?: number
  momentum?: number
  continuation_ratio?: number

  eight_hour_trend?: "bullish" | "bearish" | "neutral"
  market_direction_short?: "up" | "down" | "sideways" // 5-20min
  market_direction_long?: "up" | "down" | "sideways" // 1-4hour
  progressive_activity?: number // Increasing change detection

  block_neutral_count?: number // Wait positions count (1-3)
  level_volume_ratio?: number // Optimal volume increment
  dca_step?: number // Current DCA step (1-4)
  dca_total_steps?: number // Total DCA steps
}

export interface RealPosition {
  id: string
  connection_id: string
  exchange_position_id?: string
  symbol: string
  strategy_type: string
  volume: number
  entry_price: number
  current_price: number
  takeprofit?: number
  stoploss?: number
  profit_loss: number
  status: "open" | "closed"
  opened_at: string
  closed_at?: string

  indication_type?: "direction" | "move" | "active" | "optimal" | "auto"
  indication_range?: number
  indication_interval?: number
  strategy_interval?: number

  position_duration_seconds?: number
  avg_check_interval_ms?: number
  total_checks?: number

  initial_profit_loss?: number
  max_profit?: number
  max_loss?: number
  profit_volatility?: number
}

export interface TradingPosition extends RealPosition {
  unrealized_pnl: number
  realized_pnl: number
  margin_used: number
  liquidation_price?: number
  fees_paid: number
  hold_time: number // in minutes
  max_profit: number
  max_loss: number
  position_side?: "long" | "short"
  contract_type?: "usdt-perpetual" | "coin-perpetual" | "spot"
  leverage?: number
  volume_factor?: number
  base_volume?: number // Base volume before factor adjustment
  adjusted_volume?: number // Volume after applying volume_factor
  indication_type?: "direction" | "move" | "active" | "optimal" | "auto" // Renamed active_advanced to auto

  entry_timestamp?: string
  last_update_timestamp?: string
  updates_per_hour?: number
  price_change_velocity?: number // Price change per hour
  pnl_change_velocity?: number // PNL change per hour
}

export interface IndicationConfig {
  type: "direction" | "move" | "active" | "optimal" | "auto" // Renamed active_advanced to auto
  range: number // 2-30 step 1 (for direction and move), 1-10 step 1 (for active)
  drawdown_ratio?: number // 0.1, 0.2, 0.3, 0.4, 0.5 step 0.1 (5 variations)
  price_change_ratio?: number // 0.1-1.0 for direction/move

  // Active range: 1-10 where ratio = 0.1 + (range - 1) × 0.1556
  // Range 1 = 0.1 ratio, Range 10 = 1.5 ratio from position cost
  active_range?: number // 1-10 step 1 (maps to ratio 0.1-1.5)
  activity_for_calculated?: number // % activity for calculated positions: 10-90% step 10% = 9 variations
  activity_last_part?: number // % activity for last part: 10-90% step 10% = 9 variations

  activity_ratio?: number // 0.5%, 1.0%, 1.5%, 2.0%, 2.5%, 3.0%
  time_window?: number // 1, 3, 5, 10, 15, 20, 30, 40 minutes

  auto_activity_ratio?: number // 0.5-3.0%
  auto_time_window?: number // 1-20 minutes (reduced from 40 to 20)
  auto_use_8hour_analysis?: boolean // Enable 8-hour historical analysis
  auto_progressive_threshold?: number // Progressive activity threshold
  auto_trailing_optimal_min?: number // Min trailing range
  auto_trailing_optimal_max?: number // Max trailing range
}

// Primary Strategy Categories (for content, statistics, values)
export type MainStrategyType = "base" | "main" | "real"

// Internal Calculation Helpers (not shown in UI, map to "main")
export type InternalCalculationType = "partial" | "count"

// Adjustment Strategies - Category: "Adjust" (volume/position adjustments)
export type AdjustStrategyType = "block" | "dca"

// Additional Strategies - Category: "Additional" (optional enhancements)
export type AdditionalStrategyType = "trailing"

// Combined adjustment type (for backward compatibility)
export type AdjustmentStrategyType = AdjustStrategyType | AdditionalStrategyType

export type AdjustmentType = AdjustmentStrategyType

export interface StrategyConfig {
  takeprofit_factor: number // 2-22
  stoploss_ratio: number // 0.2-2.2
  trailing_enabled: boolean
  trail_start?: number // 0.3, 0.6, 1.0
  trail_stop?: number // 0.1, 0.2, 0.3
  last_positions_count: number // 3,4,5,6,8,12,25
  main_positions_count: number // 1,2,3,4,5 (was partial_positions_count)
  volume_factor: number // 1-5
  adjustments?: {
    block?: {
      enabled: boolean
      blockSize: number // 2, 4, 6, 8
      adjustmentRatio: number // Volume increase ratio
    }
    dca?: {
      enabled: boolean
      levels: number // 3, 5, 7
    }
    trailing?: {
      enabled: boolean
      auto_activity_ratio: number // 0.5-3.0%
      auto_time_window: number // 1-20 minutes
      auto_use_8hour_analysis: boolean // Enable 8-hour historical analysis
      auto_progressive_threshold: number // Progressive activity threshold
      auto_trailing_optimal_min: number // Min trailing range
      auto_trailing_optimal_max: number // Max trailing range
    }
  }
}

export interface SystemSettings {
  baseVolumeFactor: number
  minimalProfitFactor: number
  positionCost: number
  symbolsExchangeCount: number
  positionsAverage: number
  timeIntervalIndication: number
  timeIntervalStrategy: number
  timeIntervalReal: number
  realPositionsInterval?: number
  timeRangeHistoryDays?: number // Added time range history data setting
  databaseSizePseudo: number
  percentRearrange: number
  mainSymbols: string[]
  forcedSymbols: string[]

  defaultSymbols: string[]
  symbolSelectionMode: "main" | "forced" | "default" | "exchange"

  maxPositionsPerConfig: number
  maxTotalPositions: number

  maxPositionSize: number
  maxDailyLoss: number
  maxDrawdownPercent: number
  maxOpenPositions: number

  indicationRangeMin: number
  indicationRangeMax: number
  indicationRangeStep: number

  strategyTpMin: number
  strategyTpMax: number
  strategyTpStep: number
  strategySlMin: number
  strategySlMax: number
  strategySlStep: number
  strategyTrailStart: number[]
  strategyTrailStop: number[]
  strategyTrailStep: number

  minProfitFactorBase?: number
  minProfitFactorMain?: number
  minProfitFactorReal?: number
  maxDrawdownTimeMain?: number
  trailingEnabled?: boolean
  adjustTypeBlock?: boolean
  adjustTypeDca?: boolean

  baseValueRangeMin?: number
  baseValueRangeMax?: number
  baseRatioMin?: number
  baseRatioMax?: number
  baseTrailingEnabled?: boolean

  mainPreviousCount?: number
  mainLastStateCount?: number
  mainOngoingTrailing?: boolean
  mainAdjustBlock?: boolean
  mainBlockSize?: number
  mainBlockRatio?: number
  mainBlockState?: string
  mainAdjustDca?: boolean
  mainDcaLevels?: number
  mainDcaRatio?: number
  mainDcaState?: string

  realPreviousCountFilter?: number
  realLastStateCount?: number
  realOngoingCount?: number
  realIncludeTrailing?: boolean
  realAdjustBlockOnly?: boolean
  realPseudoLogging?: boolean
  realLogRetention?: number
  realMinTrades?: number

  // Monitoring Settings
  enableMonitoring?: boolean
  metricsRetentionDays?: number
  cpuAlertThreshold?: number
  memoryAlertThreshold?: number
  queryPerformanceThreshold?: number
  apiResponseThreshold?: number
  positionCountAlert?: number
  dailyPnlAlert?: number
  winRateAlert?: number
  drawdownAlert?: number
  apiHealthChecks?: boolean
  dbHealthChecks?: boolean
  healthCheckInterval?: number
  errorRateThreshold?: number
  monitoringLogLevel?: string
  logFileSizeLimit?: number
  logRetentionDays?: number
  alertFrequencyLimit?: number
  emailAlertsEnabled?: boolean
  telegramAlertsEnabled?: boolean
  browserAlertsEnabled?: boolean
  soundAlertsEnabled?: boolean

  marketDataTimeframe?: number // seconds, default 1

  commonIndicators?: string[] // ["rsi", "macd", "bollinger", "sar", "adx"]

  tradeMode?: "preset" | "main" // preset = common indicators, main = step-based

  indicationValidationTimeout?: number // seconds, default 15
  positionCooldownTimeout?: number // seconds, default 20
  maxPositionsPerConfigSet?: number // default 1

  presetTpMin?: number // Take profit minimum factor (default: 2)
  presetTpMax?: number // Take profit maximum factor (default: 30)
  presetTpStep?: number // Take profit step (default: 2)
  presetSlMin?: number // Stop loss minimum ratio (default: 0.3)
  presetSlMax?: number // Stop loss maximum ratio (default: 3.0)
  presetSlStep?: number // Stop loss step (default: 0.3)
  presetTrailStarts?: number[] // Trailing start values (default: [0.5, 1.0, 1.5])
  presetTrailStops?: number[] // Trailing stop values (default: [0.2, 0.4, 0.6])

  minimumConnectInterval?: number // milliseconds, default 200ms

  indicationPositionStepRatioMin: number // Minimum ratio (default: 0.2)
  indicationPositionStepRatioMax: number // Maximum ratio (default: 1.0)
  // If indication step is 10, position step range is: 10 * 0.2 = 2 (min) to 10 * 1.0 = 10 (max)
}

export interface MarketData {
  id: number
  connection_id: string
  symbol: string
  price: number
  timestamp: string
}

export interface Preset {
  id: string
  name: string
  description?: string
  preset_type: "automatic" | "configured" // Added preset type
  use_automatic_mode: boolean // Enable automatic configuration generation
  indication_types: string[]
  indication_ranges: number[]
  takeprofit_steps: number[]
  stoploss_ratios: number[]
  trailing_enabled: boolean
  trail_starts: number[]
  trail_stops: number[]
  strategy_types: string[]
  last_positions_counts: number[]
  main_positions_count: number[]
  block_adjustment_enabled: boolean
  block_sizes: number[]
  block_adjustment_ratios: number[]
  dca_adjustment_enabled: boolean
  dca_levels: number[]
  volume_factors: number[]
  volume_factor_live: number // Separate volume factor for live trade
  volume_factor_preset: number // Separate volume factor for preset trade
  min_profit_factor: number
  min_win_rate: number
  max_drawdown: number
  max_drawdown_hours: number // Added drawdown time in hours
  backtest_period_days: number
  backtest_enabled: boolean
  backtest_auto_add: boolean // Automatically add validated configs
  symbol_selection: "all" | "specific" // All symbols or specific
  specific_symbols: string[] // List of specific symbols
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface PresetStrategy {
  id: string
  preset_id: string
  connection_id: string
  symbol: string
  indication_type: string
  indication_range: number
  strategy_type: string
  takeprofit_factor: number
  stoploss_ratio: number
  trailing_enabled: boolean
  trail_start?: number
  trail_stop?: number
  block_adjustment_enabled: boolean
  block_size?: number
  block_adjustment_ratio?: number
  dca_adjustment_enabled: boolean
  dca_levels?: number
  volume_factor: number
  profit_factor: number
  win_rate: number
  total_trades: number
  winning_trades: number
  losing_trades: number
  max_drawdown: number
  is_validated: boolean
  last_validated_at?: string
  created_at: string
  updated_at: string
}

export interface TradeBot {
  id: string
  name: string
  description?: string
  connection_id: string
  symbols: string[]
  max_concurrent_positions: number
  position_timeout_hours: number
  status: "running" | "stopped" | "paused" | "error"
  is_active: boolean
  total_trades: number
  winning_trades: number
  losing_trades: number
  total_pnl: number
  current_positions: number
  started_at?: string
  stopped_at?: string
  last_trade_at?: string
  created_at: string
  updated_at: string
}

export interface BotPresetAssignment {
  id: string
  bot_id: string
  preset_id: string
  priority: number
  is_active: boolean
  assigned_at: string
}

export interface BotTrade {
  id: string
  bot_id: string
  preset_id?: string
  strategy_id?: string
  connection_id: string
  symbol: string
  side: "long" | "short"
  entry_price: number
  exit_price?: number
  quantity: number
  volume_factor: number
  indication_type?: string
  takeprofit_factor?: number
  stoploss_ratio?: number
  trailing_enabled: boolean
  profit_loss?: number
  profit_factor?: number
  fees_paid: number
  status: "open" | "closed" | "cancelled"
  close_reason?: string
  opened_at: string
  closed_at?: string
  created_at: string
}

export interface BacktestResult {
  id: string
  preset_id: string
  connection_id: string
  start_date: string
  end_date: string
  symbols: string[]
  total_trades: number
  winning_trades: number
  losing_trades: number
  win_rate: number
  total_profit: number
  total_loss: number
  net_profit: number
  profit_factor: number
  max_drawdown: number
  max_drawdown_duration_hours: number
  avg_drawdown: number
  avg_win: number
  avg_loss: number
  largest_win: number
  largest_loss: number
  avg_trade_duration_minutes: number
  sharpe_ratio: number
  sortino_ratio: number
  status: "pending" | "running" | "completed" | "failed"
  error_message?: string
  created_at: string
  completed_at?: string
}

export interface PresetConfig {
  indicatorType: string
  params: {
    period?: number
    overbought?: number
    oversold?: number
    fastPeriod?: number
    slowPeriod?: number
    signalPeriod?: number
    stdDev?: number
    acceleration?: number
    maximum?: number
    tpFactor: number
    slRatio: number
    trailingEnabled: boolean
    trailStart?: number
    trailStop?: number
  }
}

export interface PresetTestResult {
  config: PresetConfig
  test_period_hours: number
  profit_factor: number
  win_rate: number
  total_trades: number
  max_drawdown: number
  max_drawdown_duration_hours: number
  avg_trade_duration_minutes: number
  is_validated: boolean
}

export interface PriceAlert {
  id: string
  symbol: string
  condition: "above" | "below"
  price: number
  current_price: number
  is_enabled: boolean
  created_at: string
  triggered_at: string | null
}

export interface PositionAlert {
  id: string
  position_id: string
  symbol: string
  alert_type: "profit_target" | "stop_loss" | "time_limit"
  threshold: number
  current_value: number
  is_enabled: boolean
  created_at: string
  triggered_at: string | null
}

export interface SystemAlert {
  id: string
  alert_type: "connection_lost" | "high_drawdown" | "api_error" | "low_balance"
  exchange: string
  connection_id: string
  severity: "low" | "medium" | "high"
  message: string
  is_resolved: boolean
  created_at: string
  resolved_at: string | null
}

export interface AlertHistory {
  id: string
  alert_type: "price" | "position" | "system"
  symbol: string | null
  message: string
  triggered_at: string
  acknowledged: boolean
}

export interface SymbolPerformance {
  symbol: string
  profit_factor_12: number // Last 12 positions
  profit_factor_25: number // Last 25 positions
  profit_factor_50: number // Last 50 positions
  pnl_4h: number // Last 4 hours
  pnl_12h: number // Last 12 hours
  pnl_24h: number // Last 24 hours
  drawdown_time_120: number // Drawdown time for last 120 positions (hours)
  market_cap_change_24h: number // Market cap change percentage
  validated_configs_count: number
  last_updated: string
}

export interface BacktestConfig {
  preset_id: string
  timerange_days: number // Default 7 days
  min_profit_factor: number // Slider 0.2-7.0, step 0.1, default 0.5
  max_drawdown_hours: number // Slider 1-12, step 1, default 4
  auto_add_validated: boolean // Automatically add to configured types
  symbols: string[] // Symbols to backtest
}

export type {
  PresetType,
  PresetTypeSet,
  PresetConfigurationSet,
  PresetCoordinationResult,
  PresetRealTrade,
  PresetCoordinationStats,
} from "./types-preset-coordination"

export interface BasePseudoPosition {
  id: string
  symbol: string
  connection_id: string
  indication_type: "direction" | "move" | "active" | "optimal" | "auto" // Renamed active_advanced to auto
  indication_range: number
  direction: "long" | "short"

  // Core configuration
  drawdown_ratio: number
  market_change_range: number
  last_part_ratio: number

  // Active-specific (nullable)
  activity_calculated?: number
  activity_lastpart?: number

  activity_ratio?: number
  time_window?: number

  // Performance metrics
  total_positions: number
  winning_positions: number
  losing_positions: number
  total_profit_loss: number
  max_drawdown: number
  win_rate: number
  avg_profit: number
  avg_loss: number

  // Status
  status: "evaluating" | "active" | "paused" | "failed"
  evaluation_count: number

  created_at: string
  updated_at: string
}

export interface PerformanceThresholds {
  initial_min_win_rate: number // 40% after 10 positions
  expanded_min_win_rate: number // 45% after 50 positions
  expanded_min_profit_ratio: number // 1.2x (avg_profit / avg_loss)
  production_min_win_rate: number // 42% ongoing
  production_max_drawdown: number // 30% from peak
  pause_threshold_win_rate: number // 38% pause trigger
  resume_threshold_win_rate: number // 43% resume trigger
}

export interface AutoIndicationSettings {
  enabled: boolean

  // Time analysis windows
  analysisWindow8h: boolean
  analysisWindow1h: boolean
  analysisWindow30m: boolean

  // Activity ratios (0.5% - 3.0%)
  activityRatios: number[]

  // Time windows (1-20 minutes)
  timeWindows: number[]

  // Market direction tracking
  shortTermDirection: boolean
  longTermDirection: boolean

  // Progressive analysis
  progressiveActivity: boolean
  stepCalculation: boolean

  // Optimal situation
  optimalSituationCoordination: boolean
  trailingOptimalRanges: boolean
  simultaneousTrading: boolean

  // Position increment
  positionIncrementAfterSituation: boolean

  // Strategy configurations
  strategies: {
    block: AutoBlockStrategy
    level: AutoLevelStrategy
    dca: AutoDCAStrategy
    trailing: AutoTrailingStrategy
  }

  // Profit back tactics
  profitBackTactics: ProfitBackTactics
}

export interface AutoBlockStrategy {
  enabled: boolean
  positions: number
  neutralWait: {
    enabled: boolean
    positions: number // 3-position wait
    volumeAdjustment: "keep" | "reduce"
  }
}

export interface AutoLevelStrategy {
  enabled: boolean
  volumeIncrementType: "linear" | "exponential" | "fibonacci" | "optimal"
  maxLevels: number
  incrementRatio: number
  profitTargetAdjustment: boolean
}

export interface AutoDCAStrategy {
  enabled: boolean
  maxSteps: number // Up to 4
  volumeIncrease: number[] // Max 2.5x per step
  priceDistancePercent: number[]
  takeProfitAdjustment: "average" | "first_entry" | "breakeven_plus"
}

export interface AutoTrailingStrategy {
  enabled: boolean
  auto_activity_ratio: number // 0.5-3.0%
  auto_time_window: number // 1-20 minutes
  auto_use_8hour_analysis: boolean // Enable 8-hour historical analysis
  auto_progressive_threshold: number // Progressive activity threshold
  auto_trailing_optimal_min: number // Min trailing range
  auto_trailing_optimal_max: number // Max trailing range
}

export interface ProfitBackTactics {
  enabled: boolean
  closePartialOnBreakeven: boolean
  closePartialPercent: number
  trailingAfterBreakeven: boolean
  aggressiveTpReduction: boolean
}
