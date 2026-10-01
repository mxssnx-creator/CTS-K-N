/**
 * Per-symbol rows of the indication statistics that carry nothing.
 *
 * statistics/indications returned 73 MB on 2026-10-01: each of 45 signal sources and each of 8 main types
 * lists ALL 548 candidate symbols with four analytics windows (~3 KB each), and in a source only 2 of the 548
 * had a single trade in any window. A row is empty when no window holds a trade, no position is open and nothing
 * is disabled; those rows are left out unless the caller asks for everything (includeInactive=1).
 */
export interface SymbolStatsRow {
  symbol: string
  disabled?: boolean
  disabledDirections?: { long?: boolean; short?: boolean }
  openPositions?: number
  windows?: Record<string, { trades?: number } | undefined>
}

export function symbolRowHasContent(row: SymbolStatsRow): boolean {
  if (row.disabled || row.disabledDirections?.long || row.disabledDirections?.short) return true
  if ((row.openPositions ?? 0) > 0) return true
  return Object.values(row.windows || {}).some((window) => (window?.trades ?? 0) > 0)
}

export function pruneInactiveSymbolRows<T extends SymbolStatsRow>(rows: readonly T[], includeInactive: boolean): T[] {
  return includeInactive ? [...rows] : rows.filter(symbolRowHasContent)
}
