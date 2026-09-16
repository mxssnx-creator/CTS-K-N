/**
 * Retention for the Direct-Trade positions document.
 *
 * The document is a single JSON value that is read and rewritten in full on
 * every Direct-Trade touch, so its size is paid on each access. Production
 * grew it to 10 MB for one connection (1861 rows, every one of them already
 * closed) which showed up as 10 ms GETs in the Redis slowlog and dominated
 * the command mix.
 *
 * Retention is lossless for anything still alive: every non-terminal row is
 * kept unconditionally, whatever the count. Only settled history is bounded,
 * newest first, because the durable ledger and the trade history already hold
 * it — this document is a working set, not an archive.
 */
export const DIRECT_TRADE_CLOSED_POSITION_RETENTION = 250

const TERMINAL_STATUSES = new Set(["closed", "cancelled", "canceled", "rejected", "error", "expired"])

function statusOf(position: unknown): string {
  return String((position as Record<string, unknown> | null)?.status ?? "").trim().toLowerCase()
}

export function isTerminalDirectTradePosition(position: unknown): boolean {
  return TERMINAL_STATUSES.has(statusOf(position))
}

function settledAt(position: unknown): number {
  const row = (position || {}) as Record<string, unknown>
  for (const key of ["closedAt", "closed_at", "updatedAt", "updated_at", "createdAt", "created_at"]) {
    const value = Number(row[key])
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

/**
 * Keep every live row plus the newest `limit` settled rows, preserving the
 * caller's ordering for the rows that survive.
 */
export function applyDirectTradePositionRetention<T>(
  positions: readonly T[],
  limit = DIRECT_TRADE_CLOSED_POSITION_RETENTION,
): T[] {
  if (!Array.isArray(positions) || positions.length === 0) return []
  const bound = Math.max(0, Math.floor(Number(limit)))
  const terminalIndexes: number[] = []
  for (let index = 0; index < positions.length; index++) {
    if (isTerminalDirectTradePosition(positions[index])) terminalIndexes.push(index)
  }
  if (terminalIndexes.length <= bound) return [...positions]

  const keptTerminal = new Set(
    terminalIndexes
      .slice()
      .sort((a, b) => settledAt(positions[b]) - settledAt(positions[a]))
      .slice(0, bound),
  )
  return positions.filter((position, index) =>
    !isTerminalDirectTradePosition(position) || keptTerminal.has(index))
}
