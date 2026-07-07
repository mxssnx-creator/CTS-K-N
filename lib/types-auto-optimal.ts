export interface AutoOptimalConfiguration {
  id: string
  name: string
  description?: string

  // Symbol Selection
  symbol_mode: "main" | "exchange"
  exchange_order_by: "price_change_24h" | "volume_24h" | "market_cap" | "volatility"
  symbol_limit: number // 1-25, default 5
  forced_symbols?: string[] // Symbols that are always included (e.g., XAGUSD, XAUUSD)

  // Indication Configuration
  indication_type: string | null // null for "Without Indication"
  indication_params?: Record<string, { min: number; max: number; step: number }>

  // Position Ranges
  takeprofit_min: number
  takeprofit_max: number
  stoploss_min: number
  stoploss_max: number

  // Trailing Options
  trailing_enabled: boolean
  trailing_only: boolean

  // Performance Filters
  min_profit_factor: number // 0.5-3.5
  min_profit_factor_positions: number // 10-60
  max_drawdown_time_hours: number // 2-20

  // Additional Strategies
  use_block: boolean
  use_dca: boolean
  additional_strategies_only: boolean

  // Auto deactivation settings
  block_auto_deactivate_threshold: number // default 25
  block_reactivate_threshold: number // default 40
  dca_auto_deactivate_threshold: number // default 25
  dca_reactivate_threshold: number // default 40

  // Calculation Settings
  calculation_days: number // default 3
  max_positions_per_direction: number // default 3
  max_positions_per_symbol: number // default 3

  // Metadata
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface AutoOptimalResult {
  id: string
  configuration_id: string
  symbol: string

  // Configuration Used
  indication_type: string | null
  indication_params?: Record<string, any>
  takeprofit: number
  stoploss: number
  trailing_enabled: boolean
  trail_start?: number
  trail_stop?: number

  // Strategy Configuration
  uses_block: boolean
  uses_dca: boolean

  // Performance Metrics
  profit_factor: number
  profit_factor_last_8: number
  profit_factor_last_25: number
  profit_factor_last_50: number
  win_rate: number
  total_trades: number
  positions_per_24h: number
  max_drawdown_time_hours: number

  // Trade Details
  avg_profit: number
  avg_loss: number
  max_profit: number
  max_loss: number
  total_profit: number
  total_loss: number

  // Validation
  is_valid: boolean
  validation_reason?: string

  // Metadata
  calculated_at: string
  created_at: string
}

export interface AutoOptimalSymbolSummary {
  symbol: string
  total_configurations: number
  best_profit_factor: number
  best_configuration_id: string
  avg_positions_per_24h: number
  configurations: AutoOptimalResult[]
}

export interface AutoOptimalSavedSet {
  id: string
  name: string
  description?: string
  configuration_id: string

  // Additional Settings for Saved Set
  volume_factor_ratio: number
  min_profit_factor: number
  max_drawdown_time_hours: number
  use_block: boolean
  use_dca: boolean

  // Selected Results
  selected_results: string[] // Array of result IDs

  // Metadata
  created_at: string
  updated_at: string
}
