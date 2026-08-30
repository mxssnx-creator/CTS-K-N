/**
 * Shared database types.
 * All types are re-exported from here so redis-db.ts doesn't need modification.
 * Components that need `Connection` should import from "@/lib/db-types" OR "@/lib/redis-db"
 * (redis-db re-exports everything from here).
 */

/** Full exchange connection record as stored in the in-memory Redis layer. */
export interface Connection {
  id: string
  name: string
  exchange: string
  market_type?: "crypto" | "forex" | string
  asset_class?: "crypto" | "forex" | string
  account_id?: string
  account_server?: string
  account_password?: string
  account_password_configured?: boolean
  bridge_token?: string
  bridge_token_configured?: boolean
  bridge_configured?: boolean
  bridge_url?: string
  terminal_path?: string
  api_key?: string
  api_secret?: string
  api_passphrase?: string
  api_type?: string
  contract_type?: string
  connection_method?: string
  connection_library?: string
  symbol_suffix?: string
  api_base_url?: string
  quotes_base_url?: string
  charts_url?: string
  quantity_unit?: "base_units" | "lots" | "contracts" | string
  lot_size?: number | string
  position_cost_percent?: number | string
  spread_buffer_pips?: number | string
  spread_multiplier?: number | string
  positions_average?: number | string
  average_count?: number | string
  max_spread_pips?: number | string
  volume_kind?: string
  execution_mode?: string
  forex_execution_mode?: "read_only" | "mt5_bridge" | string
  read_only?: boolean | string
  margin_type?: string
  position_mode?: string
  is_testnet?: boolean | string
  is_predefined?: boolean | string
  is_inserted?: boolean | string
  is_active_inserted?: boolean | string
  is_assigned?: boolean | string
  is_enabled?: boolean | string
  is_enabled_dashboard?: boolean | string
  is_active?: boolean | string
  is_dashboard_inserted?: boolean | string
  is_live_trade?: boolean | string
  is_preset_trade?: boolean | string
  demo_mode?: boolean | string
  created_at?: string
  updated_at?: string
  [key: string]: any
}

export interface Trade {
  id: string
  connection_id: string
  symbol: string
  side: "buy" | "sell" | string
  size?: number | string
  price?: number | string
  pnl?: number | string
  status?: string
  created_at?: string
  updated_at?: string
  [key: string]: any
}

export interface Position {
  id: string
  connection_id: string
  symbol: string
  side: "long" | "short" | string
  size?: number | string
  entry_price?: number | string
  mark_price?: number | string
  unrealized_pnl?: number | string
  status?: string
  created_at?: string
  updated_at?: string
  [key: string]: any
}
