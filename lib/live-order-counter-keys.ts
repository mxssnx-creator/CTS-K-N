export const LIVE_ORDER_COUNTER_SCHEMA_VERSION = 2

/**
 * Versioned because v1 data could contain synthetic opposite-side orders and
 * shared-side Set writes. Keeping v1 untouched preserves forensic history
 * while every current writer/reader starts from independent side accounting.
 */
export function liveOrdersBySymbolKey(connectionId: string): string {
  return `live_orders_by_symbol_v${LIVE_ORDER_COUNTER_SCHEMA_VERSION}:${connectionId}`
}
