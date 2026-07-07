/**
 * Comprehensive API Response Types Registry
 * Ensures type safety and correct categories for all API endpoints
 */

// ============ API CATEGORIES ============
export const APICategories = {
  // System Operations
  SYSTEM_HEALTH: 'system.health',
  SYSTEM_DATABASE: 'system.database',
  SYSTEM_SETTINGS: 'system.settings',

  // Connection Management
  CONNECTIONS_CRUD: 'connections.crud',
  CONNECTIONS_STATUS: 'connections.status',
  CONNECTIONS_TEST: 'connections.test',
  CONNECTIONS_ACTIVE: 'connections.active',

  // Trading Operations
  TRADE_ENGINE: 'trading.engine',
  TRADE_ORDERS: 'trading.orders',
  TRADE_POSITIONS: 'trading.positions',
  TRADE_PROGRESSION: 'trading.progression',

  // Data & Analytics
  DATA_MARKET: 'data.market',
  DATA_SYNC: 'data.sync',
  DATA_BACKTEST: 'data.backtest',

  // Monitoring
  MONITORING_ALERTS: 'monitoring.alerts',
  MONITORING_LOGS: 'monitoring.logs',
  MONITORING_STATS: 'monitoring.stats',

  // Indications & Presets
  INDICATION_CONFIG: 'indication.config',
  PRESET_MANAGEMENT: 'preset.management',
  PRESET_TEST: 'preset.test',

  // Audit & Compliance
  AUDIT_LOGS: 'audit.logs',
} as const

// ============ API RESPONSE BASE TYPES ============
export interface APIResponse<T = any> {
  success: boolean
  timestamp: string
  category: string
  data?: T
  error?: string
  details?: any
  statusCode: number
}

export interface APIErrorResponse {
  success: false
  timestamp: string
  category: string
  error: string
  details?: any
  statusCode: number
}

// ============ CONNECTION API TYPES ============
export interface ConnectionStatusResponse extends APIResponse {
  category: 'connections.status'
  data: {
    id: string
    name: string
    exchange: string
    enabled: boolean
    activelyUsing: boolean
    status: 'running' | 'stopped' | 'error'
    trades: number
    positions: number
    state?: any
    progression?: {
      cycles_completed: number
      successful_cycles: number
      failed_cycles: number
      cycle_success_rate: string
      total_trades: number
      successful_trades: number
      trade_success_rate: string
      total_profit: string
      last_cycle_time: string | null
    }
    error?: string
  }[]
}

export interface ConnectionTestResponse extends APIResponse {
  category: 'connections.test'
  data: {
    connection_id: string
    status: 'success' | 'failed'
    message: string
    balance?: number
    balance_currency?: string
    timestamp: string
    error_details?: string
  }
}

export interface ConnectionListResponse extends APIResponse {
  category: 'connections.crud'
  data: {
    connections: any[]
    count: number
    active_count: number
    enabled_count: number
  }
}

// ============ TRADING API TYPES ============
export interface OrderResponse extends APIResponse {
  category: 'trading.orders'
  data: {
    id: string
    user_id: string
    connection_id: string
    symbol: string
    order_type: 'limit' | 'market'
    side: 'BUY' | 'SELL'
    price: number | null
    quantity: number
    remaining_quantity: number
    time_in_force: string
    status: 'pending' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected'
    created_at: string
    updated_at: string
  }
}

export interface PositionResponse extends APIResponse {
  category: 'trading.positions'
  data: {
    id: string
    connection_id: string
    symbol: string
    side: 'long' | 'short'
    quantity: number
    entry_price: number
    current_price: number
    profit_loss: number
    profit_loss_percent: number
    status: 'open' | 'closed' | 'partially_closed'
    opened_at: string
    closed_at?: string
  }[]
}

export interface TradeEngineStatusResponse extends APIResponse {
  category: 'trading.engine'
  data: {
    running: number
    total_trades: number
    total_positions: number
    total_errors: number
    connections: {
      id: string
      name: string
      exchange: string
      enabled: boolean
      activelyUsing: boolean
      status: string
      trades: number
      positions: number
    }[]
    timestamp: string
  }
}

// ============ INDICATION API TYPES ============
export interface ActiveIndicationsResponse extends APIResponse {
  category: 'indication.config'
  data: {
    direction: boolean
    move: boolean
    active: boolean
    optimal: boolean
    auto: boolean
    updated_at?: string
  }
}

export interface IndicationSettingsResponse extends APIResponse {
  category: 'indication.config'
  data: {
    connection_id: string
    indications: any[]
  }
}

// ============ MONITORING API TYPES ============
export interface AlertResponse extends APIResponse {
  category: 'monitoring.alerts'
  data: {
    alerts: {
      id: string
      level: 'critical' | 'warning' | 'info'
      category: string
      message: string
      timestamp: string
      acknowledged: boolean
    }[]
    count: number
    criticalCount: number
    warningCount: number
    infoCount: number
  }
}

export interface HealthCheckResponse extends APIResponse {
  category: 'system.health'
  data: {
    timestamp: string
    overall: 'healthy' | 'degraded' | 'critical'
    components: {
      database: { status: 'healthy' | 'error'; details: string }
      connections: { status: 'healthy' | 'error'; details: string; count: number }
      tradeEngine: { status: 'healthy' | 'error'; details: string; running: number }
      monitoring: { status: 'healthy' | 'error'; details: string }
      positions: { status: 'healthy' | 'error'; count: number }
      orders: { status: 'healthy' | 'error'; count: number }
    }
    workflows: {
      connectionTesting: { status: 'working' | 'broken'; details: string }
      engineStartStop: { status: 'working' | 'broken'; details: string }
      positionManagement: { status: 'working' | 'broken'; details: string }
      orderExecution: { status: 'working' | 'broken'; details: string }
    }
    issues: string[]
  }
}

// ============ AUDIT API TYPES ============
export interface AuditLogResponse extends APIResponse {
  category: 'audit.logs'
  data: {
    logs: {
      id: string
      user_id: string
      action: string
      entity_type: string
      entity_id: string
      details: any
      status: 'success' | 'failed'
      timestamp: string
    }[]
    count: number
    dateRange: {
      start: string
      end: string
    }
  }
}

// ============ SYSTEM API TYPES ============
export interface SystemSettingsResponse extends APIResponse {
  category: 'system.settings'
  data: Record<string, any>
}

// ============ TYPE REGISTRY ============
// Type-only registry for compile-time type checking
export type APIResponseRegistry = {
  'connections.status': ConnectionStatusResponse
  'connections.test': ConnectionTestResponse
  'connections.crud': ConnectionListResponse
  'trading.orders': OrderResponse
  'trading.positions': PositionResponse
  'trading.engine': TradeEngineStatusResponse
  'indication.config': ActiveIndicationsResponse
  'monitoring.alerts': AlertResponse
  'system.health': HealthCheckResponse
  'audit.logs': AuditLogResponse
  'system.settings': SystemSettingsResponse
}

export type APIResponseType = APIResponseRegistry[keyof APIResponseRegistry]
