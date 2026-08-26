export const OVERVIEW_STAGE_ROW_FRESH_MS = 5 * 60_000
export const OVERVIEW_STAGE_ROW_MAX_RETAIN_MS = 24 * 60 * 60_000

export type FunctionalOverviewStageSnapshot = {
  created: number
  evaluated: number
  passed: number
  running: number
  weightedPf: number
  pfWeight: number
  symbols: Set<string>
  freshRows: number
  retainedRows: number
  oldestUpdatedAt: number
  latestUpdatedAt: number
  complete: boolean
  connectionCount: number
}

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function parseSymbolValue(value: unknown): Set<string> {
  if (value == null) return new Set()
  let entries: unknown[]
  if (Array.isArray(value)) {
    entries = value
  } else if (typeof value === "object") {
    entries = [value]
  } else {
    const text = String(value).trim()
    if (!text) return new Set()
    try {
      const parsed = JSON.parse(text)
      entries = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      entries = text.split(/[\s,;]+/)
    }
  }
  return new Set(entries
    .map((entry) => {
      if (typeof entry === "string") return entry
      if (entry && typeof entry === "object" && "symbol" in entry) {
        return String((entry as { symbol?: unknown }).symbol || "")
      }
      return ""
    })
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean))
}

/** Resolve the first authoritative active-symbol basket without combining
 * legacy fallbacks that may contain symbols removed from the connection. */
export function resolveOverviewActiveSymbols(
  ...sources: Array<Record<string, unknown> | null | undefined>
): Set<string> {
  for (const source of sources) {
    if (!source) continue
    for (const field of ["selected_symbols", "active_symbols", "force_symbols", "symbols"] as const) {
      const symbols = parseSymbolValue(source[field])
      if (symbols.size > 0) return symbols
    }
  }
  return new Set()
}

export function emptyFunctionalOverviewStageSnapshot(): FunctionalOverviewStageSnapshot {
  return {
    created: 0,
    evaluated: 0,
    passed: 0,
    running: 0,
    weightedPf: 0,
    pfWeight: 0,
    symbols: new Set(),
    freshRows: 0,
    retainedRows: 0,
    oldestUpdatedAt: 0,
    latestUpdatedAt: 0,
    complete: false,
    connectionCount: 0,
  }
}

/**
 * Stage hashes are last-observed per-symbol snapshots, not five-minute event
 * windows. Keep valid rows for the current symbol basket while exposing their
 * freshness separately. Dropping rows at the soft freshness boundary made a
 * healthy long-running pipeline look like it had zero Sets and zero symbols.
 * The Redis hash itself expires after 24 hours; the matching hard retention
 * below also bounds malformed or orphaned rows when no active basket exists.
 */
export function aggregateFunctionalOverviewStage(
  raw: Record<string, string> | null | undefined,
  options: {
    now?: number
    activeSymbols?: Set<string>
    passedField?: "passed" | "logical_passed_sets"
  } = {},
): FunctionalOverviewStageSnapshot {
  const result = emptyFunctionalOverviewStageSnapshot()
  const now = options.now ?? Date.now()
  const activeSymbols = options.activeSymbols ?? new Set<string>()
  const rows = new Map<string, Record<string, number>>()
  for (const [field, value] of Object.entries(raw || {})) {
    const match = field.match(/^s:([^:]+):(created|evaluated|passed|logical_passed_sets|running|apf|ts)$/)
    if (!match) continue
    const symbol = match[1].toUpperCase()
    if (activeSymbols.size > 0 && !activeSymbols.has(symbol)) continue
    const row = rows.get(symbol) || {}
    row[match[2]] = finite(value)
    rows.set(symbol, row)
  }
  for (const [symbol, row] of rows) {
    const timestamp = row.ts || 0
    const ageMs = now - timestamp
    if (timestamp <= 0 || ageMs < -60_000 || ageMs > OVERVIEW_STAGE_ROW_MAX_RETAIN_MS) continue
    const created = Math.max(0, row.created || 0)
    result.created += created
    result.evaluated += Math.max(0, row.evaluated || 0)
    const requestedPassed = row[options.passedField || "passed"]
    // Older snapshots may not carry the logical Real survivor field. Their
    // physical materialisation count can exceed the logical input because one
    // input Set fans out into multiple child/row Sets, so cap that fallback to
    // the matching logical evaluated denominator.
    const passed = requestedPassed ?? Math.min(row.passed || 0, row.evaluated || 0)
    result.passed += Math.max(0, passed)
    result.running += Math.max(0, row.running || 0)
    result.weightedPf += (row.apf || 0) * created
    result.pfWeight += created
    result.symbols.add(symbol)
    result.retainedRows++
    if (ageMs <= OVERVIEW_STAGE_ROW_FRESH_MS) result.freshRows++
    result.oldestUpdatedAt = result.oldestUpdatedAt > 0
      ? Math.min(result.oldestUpdatedAt, timestamp)
      : timestamp
    result.latestUpdatedAt = Math.max(result.latestUpdatedAt, timestamp)
  }
  result.complete = activeSymbols.size > 0
    ? result.symbols.size >= activeSymbols.size
    : result.symbols.size > 0
  result.connectionCount = 1
  return result
}

export function mergeFunctionalOverviewStage(
  target: FunctionalOverviewStageSnapshot,
  source: FunctionalOverviewStageSnapshot,
): void {
  target.created += source.created
  target.evaluated += source.evaluated
  target.passed += source.passed
  target.running += source.running
  target.weightedPf += source.weightedPf
  target.pfWeight += source.pfWeight
  target.freshRows += source.freshRows
  target.retainedRows += source.retainedRows
  target.oldestUpdatedAt = target.oldestUpdatedAt > 0 && source.oldestUpdatedAt > 0
    ? Math.min(target.oldestUpdatedAt, source.oldestUpdatedAt)
    : Math.max(target.oldestUpdatedAt, source.oldestUpdatedAt)
  target.latestUpdatedAt = Math.max(target.latestUpdatedAt, source.latestUpdatedAt)
  target.complete = target.connectionCount === 0
    ? source.complete
    : target.complete && source.complete
  target.connectionCount += source.connectionCount
  for (const symbol of source.symbols) target.symbols.add(symbol)
}
