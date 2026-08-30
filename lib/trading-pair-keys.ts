/** Redis key helpers for connection-owned instrument rules. */

function safeConnectionId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 160)
}

export function tradingPairKey(symbol: string, connectionId?: string): string {
  const normalizedSymbol = String(symbol ?? "").trim()
  const scoped = safeConnectionId(connectionId)
  return scoped
    ? `settings:trading_pair:${scoped}:${normalizedSymbol}`
    : `settings:trading_pair:${normalizedSymbol}`
}
