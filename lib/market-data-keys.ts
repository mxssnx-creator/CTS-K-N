/**
 * Canonical Redis key builder for market data.
 *
 * Market data is connection-owned: two venues can publish the same symbol
 * with different prices, spreads, sessions, and history.  Keep the legacy
 * symbol-only keys available for explicitly unscoped callers, while every
 * engine-owned read/write can opt into `market_data:{connectionId}:{symbol}`.
 */

function safeConnectionId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 160)
}

export function marketDataKey(
  symbol: string,
  suffix = "",
  connectionId?: string,
): string {
  const scopedConnectionId = safeConnectionId(connectionId)
  const symbolPart = String(symbol ?? "").trim()
  const prefix = scopedConnectionId
    ? `market_data:${scopedConnectionId}:${symbolPart}`
    : `market_data:${symbolPart}`
  return suffix ? `${prefix}:${suffix}` : prefix
}

export function marketDataScopeKey(symbol: string, connectionId?: string): string {
  return marketDataKey(symbol, "", connectionId)
}
