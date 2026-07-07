/**
 * Centralized Type Constants for Dynamic Type Handling
 * All hardcoded type strings should reference these constants
 */

// ============================================================================
// INDICATION TYPES
// ============================================================================
export const INDICATION_TYPES = {
  DIRECTION: "direction",
  MOVE: "move",
  ACTIVE: "active",
  OPTIMAL: "optimal",
  AUTO: "auto",
} as const

export type IndicationType = (typeof INDICATION_TYPES)[keyof typeof INDICATION_TYPES]

export const INDICATION_TYPE_LABELS: Record<IndicationType, string> = {
  [INDICATION_TYPES.DIRECTION]: "Direction",
  [INDICATION_TYPES.MOVE]: "Move",
  [INDICATION_TYPES.ACTIVE]: "Active",
  [INDICATION_TYPES.OPTIMAL]: "Optimal",
  [INDICATION_TYPES.AUTO]: "Auto",
}

export const DEFAULT_INDICATION_TYPES: IndicationType[] = [
  INDICATION_TYPES.DIRECTION,
  INDICATION_TYPES.MOVE,
  INDICATION_TYPES.ACTIVE,
]

// ============================================================================
// STRATEGY TYPES
// ============================================================================
export const STRATEGY_TYPES = {
  BASE: "base", // Last N positions analysis
  MAIN: "main", // Multi-position coordination (was "partial")
  REAL: "real", // Exchange-mirrored live positions
  BLOCK: "block", // Block trading strategy
  DCA: "dca", // Dollar-cost averaging strategy
  TRAILING: "trailing", // Trailing stop strategy
} as const

export type StrategyType = (typeof STRATEGY_TYPES)[keyof typeof STRATEGY_TYPES]

export const STRATEGY_TYPE_LABELS: Record<StrategyType, string> = {
  [STRATEGY_TYPES.BASE]: "Base Strategy",
  [STRATEGY_TYPES.MAIN]: "Main Strategy",
  [STRATEGY_TYPES.REAL]: "Real Strategy",
  [STRATEGY_TYPES.BLOCK]: "Block Strategy",
  [STRATEGY_TYPES.DCA]: "DCA Strategy",
  [STRATEGY_TYPES.TRAILING]: "Trailing Strategy",
}

export const DEFAULT_STRATEGY_TYPES: StrategyType[] = [
  STRATEGY_TYPES.BASE,
  STRATEGY_TYPES.MAIN,
  STRATEGY_TYPES.REAL,
  STRATEGY_TYPES.BLOCK,
  STRATEGY_TYPES.DCA,
  STRATEGY_TYPES.TRAILING,
]

// ============================================================================
// INTERNAL CALCULATION TYPES - Not shown in UI, just for calculation logistics
// ============================================================================
export const INTERNAL_CALC_TYPES = {
  PARTIAL: "partial", // Internal: partial position analysis helper
  COUNT: "count", // Internal: count variation helper
} as const

export type InternalCalcType = (typeof INTERNAL_CALC_TYPES)[keyof typeof INTERNAL_CALC_TYPES]

// ============================================================================
// DATABASE TYPES
// ============================================================================
export const DATABASE_TYPES = {
  SQLITE: "sqlite",
  POSTGRESQL_LOCAL: "postgresql",
  POSTGRESQL_REMOTE: "remote",
} as const

export type DatabaseType = (typeof DATABASE_TYPES)[keyof typeof DATABASE_TYPES]

export const DATABASE_TYPE_LABELS: Record<DatabaseType, string> = {
  [DATABASE_TYPES.SQLITE]: "SQLite (Local)",
  [DATABASE_TYPES.POSTGRESQL_LOCAL]: "PostgreSQL (Local)",
  [DATABASE_TYPES.POSTGRESQL_REMOTE]: "PostgreSQL (Remote)",
}

// ============================================================================
// ALERT TYPES
// ============================================================================
export const ALERT_TYPES = {
  PROFIT_TARGET: "profit_target",
  STOP_LOSS: "stop_loss",
  TIME_LIMIT: "time_limit",
  CONNECTION_LOST: "connection_lost",
  HIGH_DRAWDOWN: "high_drawdown",
  PRICE: "price",
  POSITION: "position",
  SYSTEM: "system",
  API_ERROR: "api_error",
  LOW_BALANCE: "low_balance",
} as const

export type AlertType = (typeof ALERT_TYPES)[keyof typeof ALERT_TYPES]

// ============================================================================
// STATUS TYPES
// ============================================================================
export const STATUS_TYPES = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  OPEN: "open",
  CLOSED: "closed",
  RUNNING: "running",
  STOPPED: "stopped",
  PAUSED: "paused",
  ERROR: "error",
  WARNING: "warning",
  SUCCESS: "success",
  PENDING: "pending",
  EVALUATING: "evaluating",
  FAILED: "failed",
  SYNCED: "synced",
  PENDING_UPDATE: "pending_update",
  OUT_OF_SYNC: "out_of_sync",
  CANCELLED: "cancelled",
  COMPLETED: "completed",
} as const

export type StatusType = (typeof STATUS_TYPES)[keyof typeof STATUS_TYPES]

// ============================================================================
// POSITION SIDE TYPES
// ============================================================================
export const POSITION_SIDES = {
  LONG: "long",
  SHORT: "short",
} as const

export type PositionSide = (typeof POSITION_SIDES)[keyof typeof POSITION_SIDES]

// ============================================================================
// CONTRACT TYPES
// ============================================================================
export const CONTRACT_TYPES = {
  USDT_PERPETUAL: "usdt-perpetual",
  COIN_PERPETUAL: "coin-perpetual",
  SPOT: "spot",
} as const

export type ContractType = (typeof CONTRACT_TYPES)[keyof typeof CONTRACT_TYPES]

// ============================================================================
// API TYPES
// ============================================================================
export const API_TYPES = {
  SPOT: "spot",
  PERPETUAL_FUTURES: "perpetual_futures",
  UNIFIED: "unified",
  CROSS: "cross",
  ISOLATED: "isolated",
} as const

export type ApiType = (typeof API_TYPES)[keyof typeof API_TYPES]

// ============================================================================
// SYMBOL SELECTION MODES
// ============================================================================
export const SYMBOL_SELECTION_MODES = {
  MAIN: "main",
  FORCED: "forced",
  DEFAULT: "default",
  EXCHANGE: "exchange",
  MANUAL: "manual",
} as const

export type SymbolSelectionMode = (typeof SYMBOL_SELECTION_MODES)[keyof typeof SYMBOL_SELECTION_MODES]

// ============================================================================
// ARRANGEMENT TYPES
// ============================================================================
export const ARRANGEMENT_TYPES = {
  MARKET_CAP: "market_cap",
  MARKET_VOLUME: "market_volume",
  MARKET_VOLATILITY: "market_volatility",
  PRICE_CHANGE: "price_change",
  LIQUIDITY: "liquidity",
  VOLATILITY: "volatility",
  VOLUME_24H: "volume_24h",
} as const

export type ArrangementType = (typeof ARRANGEMENT_TYPES)[keyof typeof ARRANGEMENT_TYPES]

// ============================================================================
// DIRECTION TYPES
// ============================================================================
export const DIRECTION_TYPES = {
  UP: "up",
  DOWN: "down",
  SIDEWAYS: "sideways",
  BULLISH: "bullish",
  BEARISH: "bearish",
  NEUTRAL: "neutral",
} as const

export type DirectionType = (typeof DIRECTION_TYPES)[keyof typeof DIRECTION_TYPES]

// ============================================================================
// SEVERITY TYPES
// ============================================================================
export const SEVERITY_TYPES = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
} as const

export type SeverityType = (typeof SEVERITY_TYPES)[keyof typeof SEVERITY_TYPES]

// ============================================================================
// TRADE MODE TYPES
// ============================================================================
export const TRADE_MODES = {
  PRESET: "preset",
  MAIN: "main",
} as const

export type TradeMode = (typeof TRADE_MODES)[keyof typeof TRADE_MODES]

// ============================================================================
// PRESET TYPES
// ============================================================================
export const PRESET_TYPES = {
  AUTOMATIC: "automatic",
  CONFIGURED: "configured",
} as const

export type PresetTypeValue = (typeof PRESET_TYPES)[keyof typeof PRESET_TYPES]

// ============================================================================
// COMMON INDICATORS
// ============================================================================
export const COMMON_INDICATORS = {
  RSI: "rsi",
  MACD: "macd",
  BOLLINGER: "bollinger",
  SAR: "sar",
  ADX: "adx",
  EMA: "ema",
  SMA: "sma",
  STOCHASTIC: "stochastic",
  ATR: "atr",
  PARABOLIC_SAR: "parabolicSAR", // Added explicit ParabolicSAR entry
} as const

export type CommonIndicator = (typeof COMMON_INDICATORS)[keyof typeof COMMON_INDICATORS]

export const DEFAULT_COMMON_INDICATORS: CommonIndicator[] = [
  COMMON_INDICATORS.RSI,
  COMMON_INDICATORS.MACD,
  COMMON_INDICATORS.BOLLINGER,
  COMMON_INDICATORS.SAR,
  COMMON_INDICATORS.ADX,
  COMMON_INDICATORS.PARABOLIC_SAR, // Added ParabolicSAR to defaults
]

// ============================================================================
// INDICATION CATEGORIES - Main vs Common categorization
// ============================================================================
export const INDICATION_CATEGORIES = {
  MAIN: "main", // Main indications: Direction, Move, Active, Optimal, Auto
  COMMON: "common", // Common indicators: RSI, MACD, Bollinger, SAR, ADX, etc.
} as const

export type IndicationCategory = (typeof INDICATION_CATEGORIES)[keyof typeof INDICATION_CATEGORIES]

export const INDICATION_CATEGORY_LABELS: Record<IndicationCategory, string> = {
  [INDICATION_CATEGORIES.MAIN]: "Main Indications",
  [INDICATION_CATEGORIES.COMMON]: "Common Indicators",
}

export const INDICATION_CATEGORY_DESCRIPTIONS: Record<IndicationCategory, string> = {
  [INDICATION_CATEGORIES.MAIN]: "Step-based position generation: Direction, Move, Active, Optimal",
  [INDICATION_CATEGORIES.COMMON]: "Technical indicators: RSI, MACD, Bollinger, ParabolicSAR, ADX, ATR",
}

// Map indication types to their category
export const INDICATION_TO_CATEGORY: Record<string, IndicationCategory> = {
  // Main indications
  direction: INDICATION_CATEGORIES.MAIN,
  move: INDICATION_CATEGORIES.MAIN,
  active: INDICATION_CATEGORIES.MAIN,
  optimal: INDICATION_CATEGORIES.MAIN,
  auto: INDICATION_CATEGORIES.MAIN,
  // Common indicators
  rsi: INDICATION_CATEGORIES.COMMON,
  macd: INDICATION_CATEGORIES.COMMON,
  bollinger: INDICATION_CATEGORIES.COMMON,
  sar: INDICATION_CATEGORIES.COMMON,
  parabolicSAR: INDICATION_CATEGORIES.COMMON,
  adx: INDICATION_CATEGORIES.COMMON,
  ema: INDICATION_CATEGORIES.COMMON,
  sma: INDICATION_CATEGORIES.COMMON,
  stochastic: INDICATION_CATEGORIES.COMMON,
  atr: INDICATION_CATEGORIES.COMMON,
}

export function getIndicationCategory(indicationType: string): IndicationCategory {
  return INDICATION_TO_CATEGORY[indicationType.toLowerCase()] || INDICATION_CATEGORIES.MAIN
}

export function isMainIndication(indicationType: string): boolean {
  return getIndicationCategory(indicationType) === INDICATION_CATEGORIES.MAIN
}

export function isCommonIndication(indicationType: string): boolean {
  return getIndicationCategory(indicationType) === INDICATION_CATEGORIES.COMMON
}

// ============================================================================
// VOLUME INCREMENT TYPES
// ============================================================================
export const VOLUME_INCREMENT_TYPES = {
  LINEAR: "linear",
  EXPONENTIAL: "exponential",
  FIBONACCI: "fibonacci",
  OPTIMAL: "optimal",
} as const

export type VolumeIncrementType = (typeof VOLUME_INCREMENT_TYPES)[keyof typeof VOLUME_INCREMENT_TYPES]

// ============================================================================
// TP ADJUSTMENT TYPES
// ============================================================================
export const TP_ADJUSTMENT_TYPES = {
  AVERAGE: "average",
  FIRST_ENTRY: "first_entry",
  BREAKEVEN_PLUS: "breakeven_plus",
} as const

export type TpAdjustmentType = (typeof TP_ADJUSTMENT_TYPES)[keyof typeof TP_ADJUSTMENT_TYPES]

// ============================================================================
// VOLUME ADJUSTMENT TYPES
// ============================================================================
export const VOLUME_ADJUSTMENT_TYPES = {
  KEEP: "keep",
  REDUCE: "reduce",
} as const

export type VolumeAdjustmentType = (typeof VOLUME_ADJUSTMENT_TYPES)[keyof typeof VOLUME_ADJUSTMENT_TYPES]

// ============================================================================
// ORDER BY TYPES
// ============================================================================
export const ORDER_BY_TYPES = {
  MARKET_CAP: "market_cap",
  VOLUME_24H: "volume_24h",
  PRICE_CHANGE_24H: "price_change_24h",
  VOLATILITY: "volatility",
} as const

export type OrderByType = (typeof ORDER_BY_TYPES)[keyof typeof ORDER_BY_TYPES]

// ============================================================================
// EXCHANGE TYPES
// ============================================================================
export const EXCHANGE_TYPES = {
  BYBIT: "bybit",
  BINANCE: "binance",
  OKX: "okx",
  KUCOIN: "kucoin",
  GATE: "gate",
  BITGET: "bitget",
  COINEX: "coinex",
  MEXC: "mexc",
} as const

export type ExchangeType = (typeof EXCHANGE_TYPES)[keyof typeof EXCHANGE_TYPES]

// ============================================================================
// ADJUSTMENT TYPES - Volume/Position adjustments
// ============================================================================
export const ADJUSTMENT_TYPES = {
  BLOCK: "block",
  DCA: "dca",
} as const

export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[keyof typeof ADJUSTMENT_TYPES]

export const ADJUSTMENT_TYPE_LABELS: Record<AdjustmentType, string> = {
  [ADJUSTMENT_TYPES.BLOCK]: "Block Adjustment",
  [ADJUSTMENT_TYPES.DCA]: "DCA Adjustment",
}

// ============================================================================
// STRATEGY CATEGORIES - Organize strategies by their purpose
// ============================================================================
export const STRATEGY_CATEGORIES = {
  // Core strategies (Base, Main, Real) - always enabled by default
  CORE: "core",
  // Adjustment strategies (Block, DCA) - volume/position adjustments
  ADJUST: "adjust",
  // Additional strategies (Trailing) - optional enhancements
  ADDITIONAL: "additional",
} as const

export type StrategyCategory = (typeof STRATEGY_CATEGORIES)[keyof typeof STRATEGY_CATEGORIES]

export const STRATEGY_CATEGORY_LABELS: Record<StrategyCategory, string> = {
  [STRATEGY_CATEGORIES.CORE]: "Core Strategies",
  [STRATEGY_CATEGORIES.ADJUST]: "Adjust (Volume/Position)",
  [STRATEGY_CATEGORIES.ADDITIONAL]: "Additional (Enhancement)",
}

export const STRATEGY_TO_CATEGORY: Record<string, StrategyCategory> = {
  // Core strategies
  base: STRATEGY_CATEGORIES.CORE,
  main: STRATEGY_CATEGORIES.CORE,
  real: STRATEGY_CATEGORIES.CORE,
  // Adjust strategies (Block, DCA)
  block: STRATEGY_CATEGORIES.ADJUST,
  dca: STRATEGY_CATEGORIES.ADJUST,
  // Additional strategies (Trailing)
  trailing: STRATEGY_CATEGORIES.ADDITIONAL,
}

export function getStrategyCategory(strategy: string): StrategyCategory {
  return STRATEGY_TO_CATEGORY[strategy.toLowerCase()] || STRATEGY_CATEGORIES.CORE
}

export function isAdjustStrategy(strategy: string): boolean {
  return getStrategyCategory(strategy) === STRATEGY_CATEGORIES.ADJUST
}

export function isAdditionalStrategy(strategy: string): boolean {
  return getStrategyCategory(strategy) === STRATEGY_CATEGORIES.ADDITIONAL
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if a value is a valid indication type
 */
export function isIndicationType(value: string): value is IndicationType {
  return Object.values(INDICATION_TYPES).includes(value as IndicationType)
}

/**
 * Check if a value is a valid strategy type
 */
export function isStrategyType(value: string): value is StrategyType {
  return Object.values(STRATEGY_TYPES).includes(value as StrategyType)
}

/**
 * Check if a value is a valid database type
 */
export function isDatabaseType(value: string): value is DatabaseType {
  return Object.values(DATABASE_TYPES).includes(value as DatabaseType)
}

/**
 * Get label for an indication type
 */
export function getIndicationTypeLabel(type: IndicationType): string {
  return INDICATION_TYPE_LABELS[type] || type
}

/**
 * Get label for a strategy type
 */
export function getStrategyTypeLabel(type: StrategyType): string {
  return STRATEGY_TYPE_LABELS[type] || type
}

/**
 * Get label for a database type
 */
export function getDatabaseTypeLabel(type: DatabaseType): string {
  return DATABASE_TYPE_LABELS[type] || type
}

/**
 * Parse indication types from JSON string or array
 */
export function parseIndicationTypes(value: string | string[]): IndicationType[] {
  const types = typeof value === "string" ? JSON.parse(value) : value
  return types.filter(isIndicationType)
}

/**
 * Parse strategy types from JSON string or array
 */
export function parseStrategyTypes(value: string | string[]): StrategyType[] {
  const types = typeof value === "string" ? JSON.parse(value) : value
  return types.filter(isStrategyType)
}
