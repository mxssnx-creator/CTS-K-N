export const EntityTypes = {
  POSITION: 'position',
  PSEUDO_POSITION: 'pseudo_position',
  REAL_POSITION: 'real_position',
  CONNECTION: 'connection',
  MARKET_DATA: 'market_data',
  SETTING: 'setting',
  LOG: 'log',
  ERROR: 'error',
  CONFIG: 'config',
  PRESET: 'preset',
  PRESET_TYPE: 'preset_type',
  STRATEGY: 'strategy',
  INDICATION: 'indication',
  ALERT: 'alert',
  BOT: 'bot',
  BACKTEST: 'backtest',
} as const

export const ConfigSubTypes = {
  AUTO_OPTIMAL: 'auto_optimal',
  MANUAL: 'manual',
  BACKTEST: 'backtest',
} as const

export const OperationTypes = {
  INSERT: 'insert',
  UPDATE: 'update',
  DELETE: 'delete',
  QUERY: 'query',
  BATCH_INSERT: 'batch_insert',
  BATCH_UPDATE: 'batch_update',
  BATCH_DELETE: 'batch_delete',
} as const

export type EntityType = typeof EntityTypes[keyof typeof EntityTypes]
export type ConfigSubType = typeof ConfigSubTypes[keyof typeof ConfigSubTypes]
export type OperationType = typeof OperationTypes[keyof typeof OperationTypes]

// Entity metadata for dynamic operations
export interface EntityMetadata {
  tableName: string
  primaryKey: string
  fields: string[]
  indexes?: string[]
  relationships?: {
    field: string
    references: { entity: EntityType; field: string }
  }[]
}

export const EntityMetadataMap: Record<EntityType, EntityMetadata> = {
  [EntityTypes.CONNECTION]: {
    tableName: 'exchange_connections',
    primaryKey: 'id',
    fields: ['id', 'name', 'exchange', 'api_type', 'connection_method', 'api_key', 'api_secret', 'is_enabled', 'is_live_trade', 'created_at'],
    indexes: ['exchange', 'is_enabled'],
  },
  [EntityTypes.PSEUDO_POSITION]: {
    tableName: 'pseudo_positions',
    primaryKey: 'id',
    fields: ['id', 'connection_id', 'symbol', 'indication_type', 'takeprofit_factor', 'stoploss_ratio', 'trailing_enabled', 'trail_start', 'trail_stop', 'entry_price', 'current_price', 'profit_factor', 'position_cost', 'status', 'created_at', 'updated_at'],
    indexes: ['connection_id', 'status', 'symbol'],
    relationships: [
      { field: 'connection_id', references: { entity: EntityTypes.CONNECTION, field: 'id' } }
    ],
  },
  [EntityTypes.REAL_POSITION]: {
    tableName: 'real_positions',
    primaryKey: 'id',
    fields: ['id', 'connection_id', 'exchange_position_id', 'symbol', 'strategy_type', 'volume', 'entry_price', 'current_price', 'takeprofit', 'stoploss', 'profit_loss', 'status', 'opened_at', 'closed_at'],
    indexes: ['connection_id', 'status', 'symbol'],
    relationships: [
      { field: 'connection_id', references: { entity: EntityTypes.CONNECTION, field: 'id' } }
    ],
  },
  [EntityTypes.MARKET_DATA]: {
    tableName: 'market_data',
    primaryKey: 'id',
    fields: ['id', 'connection_id', 'symbol', 'price', 'timestamp'],
    indexes: ['connection_id', 'symbol', 'timestamp'],
    relationships: [
      { field: 'connection_id', references: { entity: EntityTypes.CONNECTION, field: 'id' } }
    ],
  },
  [EntityTypes.SETTING]: {
    tableName: 'system_settings',
    primaryKey: 'key',
    fields: ['key', 'value', 'updated_at'],
    indexes: ['key'],
  },
  [EntityTypes.LOG]: {
    tableName: 'logs',
    primaryKey: 'id',
    fields: ['id', 'level', 'category', 'message', 'details', 'timestamp'],
    indexes: ['level', 'category', 'timestamp'],
  },
  [EntityTypes.ERROR]: {
    tableName: 'errors',
    primaryKey: 'id',
    fields: ['id', 'type', 'message', 'stack', 'context', 'resolved', 'timestamp'],
    indexes: ['type', 'resolved', 'timestamp'],
  },
  [EntityTypes.CONFIG]: {
    tableName: 'auto_optimal_configurations',
    primaryKey: 'id',
    fields: ['id', 'name', 'symbol_mode', 'exchange_order_by', 'symbol_limit', 'indication_type', 'indication_params', 'takeprofit_min', 'takeprofit_max', 'stoploss_min', 'stoploss_max', 'trailing_enabled', 'trailing_only', 'min_profit_factor', 'min_profit_factor_positions', 'max_drawdown_time_hours', 'use_block', 'use_dca', 'additional_strategies_only', 'calculation_days', 'max_positions_per_direction', 'max_positions_per_symbol'],
    indexes: ['indication_type'],
  },
  [EntityTypes.PRESET_TYPE]: {
    tableName: 'preset_types',
    primaryKey: 'id',
    fields: [
      'id', 'name', 'description', 'preset_trade_type',
      'max_positions_per_indication', 'max_positions_per_direction', 'max_positions_per_range',
      'timeout_per_indication', 'timeout_after_position',
      'block_enabled', 'block_only', 'dca_enabled', 'dca_only',
      'auto_evaluate', 'evaluation_interval_hours', 'last_evaluation_at',
      'is_active', 'created_at', 'updated_at'
    ],
    indexes: ['is_active'],
  },
  [EntityTypes.POSITION]: {
    tableName: 'pseudo_positions',
    primaryKey: 'id',
    fields: ['id', 'connection_id', 'symbol', 'status'],
    indexes: ['connection_id', 'status'],
  },
  [EntityTypes.PRESET]: {
    tableName: 'presets',
    primaryKey: 'id',
    fields: ['id', 'name', 'is_active'],
    indexes: ['is_active'],
  },
  [EntityTypes.STRATEGY]: {
    tableName: 'strategies',
    primaryKey: 'id',
    fields: ['id', 'type', 'status'],
    indexes: ['type', 'status'],
  },
  [EntityTypes.INDICATION]: {
    tableName: 'indications',
    primaryKey: 'id',
    fields: ['id', 'type', 'status'],
    indexes: ['type', 'status'],
  },
  [EntityTypes.ALERT]: {
    tableName: 'alerts',
    primaryKey: 'id',
    fields: ['id', 'type', 'status'],
    indexes: ['type', 'status'],
  },
  [EntityTypes.BOT]: {
    tableName: 'bots',
    primaryKey: 'id',
    fields: ['id', 'name', 'status'],
    indexes: ['status'],
  },
  [EntityTypes.BACKTEST]: {
    tableName: 'backtests',
    primaryKey: 'id',
    fields: ['id', 'status', 'result'],
    indexes: ['status'],
  },
}
