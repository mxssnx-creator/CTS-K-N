export interface PresetConfigurationSet {
  id: string
  name: string
  description?: string

  // Symbol Selection
  symbol_mode: "main" | "forced" | "manual" | "exchange"
  symbols?: string[]
  exchange_order_by?: "market_cap" | "volume" | "volatility" | "price_change"
  exchange_limit?: number

  // Indication Configuration
  indication_category: "main" | "common" // Main (Direction/Move/Active/Optimal) or Common (RSI/MACD/etc.)
  indication_type: string // For main: 'direction', 'move', etc. For common: 'rsi', 'macd', etc.
  indication_params: Record<string, any> // Indicator-specific parameters with ranges

  // Position Ranges
  takeprofit_min: number
  takeprofit_max: number
  takeprofit_step: number
  stoploss_min: number
  stoploss_max: number
  stoploss_step: number

  // Trailing Configuration
  trailing_enabled: boolean
  trail_starts: number[]
  trail_stops: number[]

  // Calculation Settings
  range_days: number // 1-20
  trades_per_48h_min: number // 1-20
  profit_factor_min: number // 0.5-5.0
  drawdown_time_max: number // 4-20 hours
  evaluation_positions_count1: number // 10-50
  evaluation_positions_count2: number // 50-100

  // Database Configuration
  database_positions_per_set: number // default 250
  database_threshold_percent: number // default 20

  // Metadata
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface PresetType {
  id: string
  name: string
  description?: string

  // Preset Type Configuration
  preset_trade_type: string

  // Coordination Settings
  max_positions_per_indication: number
  max_positions_per_direction: number
  max_positions_per_range: number
  timeout_per_indication: number // seconds
  timeout_after_position: number // seconds

  // Strategy Configuration
  trailing_enabled: boolean
  trailing_only: boolean
  block_enabled: boolean
  block_only: boolean
  dca_enabled: boolean
  dca_only: boolean

  // Auto Evaluation
  auto_evaluate: boolean
  evaluation_interval_hours: number
  last_evaluation_at?: string

  // Metadata
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface PresetTypeSet {
  id: string
  preset_type_id: string
  configuration_set_id: string
  priority: number
  is_active: boolean
  added_at: string
}

export interface PresetCoordinationResult {
  id: string
  preset_type_id: string
  configuration_set_id: string
  symbol: string

  // Configuration Details
  indication_category: "main" | "common"
  indication_type: string
  indication_params: Record<string, any>
  takeprofit_factor: number
  stoploss_ratio: number
  trailing_enabled: boolean
  trail_start?: number
  trail_stop?: number

  // Performance Metrics
  profit_factor: number
  win_rate: number
  total_trades: number
  winning_trades: number
  losing_trades: number
  avg_profit: number
  avg_loss: number
  max_drawdown: number
  drawdown_time_hours: number

  // Evaluation Metrics
  profit_factor_last_25: number
  profit_factor_last_50: number
  positions_per_24h: number

  // Validation Status
  is_valid: boolean
  validation_reason?: string
  last_validated_at?: string

  // Metadata
  created_at: string
  updated_at: string
}

export interface PresetRealTrade {
  id: string
  connection_id: string
  preset_type_id: string
  configuration_set_id: string
  coordination_result_id?: string

  symbol: string
  direction: "long" | "short"

  // Trade Details
  entry_price: number
  exit_price?: number
  quantity: number
  leverage: number

  // Configuration Used
  indication_type: string
  takeprofit_factor: number
  stoploss_ratio: number
  trailing_enabled: boolean
  trail_start?: number
  trail_stop?: number

  // Performance
  profit_loss: number
  profit_factor: number
  fees_paid: number

  // Status
  status: "open" | "closed" | "cancelled"
  close_reason?: string

  // Timestamps
  opened_at: string
  closed_at?: string
  created_at: string
}

export interface PresetCoordinationStats {
  total_sets: number
  active_sets: number
  total_results: number
  valid_results: number
  avg_profit_factor: number
  avg_win_rate: number
  total_trades: number
  positions_per_24h: number
}
