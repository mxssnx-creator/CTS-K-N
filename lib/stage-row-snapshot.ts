/**
 * Freshness budget for one complete Base → Main → Row-Real → Row-Live pass.
 *
 * A fixed five-minute TTL is shorter than an exhaustive high-load pass over a
 * large basket. Earlier symbols then expired while later symbols were still
 * being evaluated, so an otherwise healthy 128-symbol run could never publish
 * a complete card snapshot. The budget scales with the selected basket while
 * staying bounded; stopped engines still zero current-open values separately.
 */
export const STAGE_ROW_SNAPSHOT_MIN_FRESH_MS = 5 * 60_000
export const STAGE_ROW_SNAPSHOT_PER_SYMBOL_MS = 15_000
export const STAGE_ROW_SNAPSHOT_MAX_FRESH_MS = 45 * 60_000

/** Current pipeline coverage is the intersection of fresh symbol snapshots.
 * Historical bootstrap counters are a separate progress measure. */
export function summarizeStagePipelineCoverage(
  hashes: readonly Record<string, string>[],
  options: { symbols: ReadonlySet<string>; maxAgeMs: number; now?: number },
): { processed: number; total: number; complete: boolean } {
  const now = options.now ?? Date.now()
  const expected = new Set([...options.symbols].map(symbol => symbol.toUpperCase()))
  if (!expected.size) for (const hash of hashes) for (const key of Object.keys(hash)) {
    if (key.startsWith("s:") && key.endsWith(":ts")) expected.add(key.slice(2, -3).toUpperCase())
  }
  const fresh = hashes.map(hash => new Set(Object.keys(hash).flatMap(key => {
    if (!key.startsWith("s:") || !key.endsWith(":ts")) return []
    const symbol = key.slice(2, -3).toUpperCase(), timestamp = Number(hash[key])
    return expected.has(symbol) && Number.isFinite(timestamp) && timestamp > 0
      && timestamp <= now && now - timestamp <= options.maxAgeMs ? [symbol] : []
  })))
  const processed = hashes.length ? [...expected].filter(symbol => fresh.every(stage => stage.has(symbol))).length : 0
  return { processed, total: expected.size, complete: expected.size > 0 && processed === expected.size }
}

export function resolveStageRowSnapshotFreshMs(expectedSymbols: unknown): number {
  const parsed = Number(expectedSymbols)
  const symbols = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1
  return Math.min(
    STAGE_ROW_SNAPSHOT_MAX_FRESH_MS,
    Math.max(
      STAGE_ROW_SNAPSHOT_MIN_FRESH_MS,
      2 * 60_000 + symbols * STAGE_ROW_SNAPSHOT_PER_SYMBOL_MS,
    ),
  )
}

/** Sum the measured current symbols; coverage describes missing work separately. */
export function sumFreshStageRowField(
  hash: Record<string, string>,
  field: string,
  options: { symbols: ReadonlySet<string>; maxAgeMs: number; now?: number },
): number {
  const now = options.now ?? Date.now()
  let total = 0
  for (const key of Object.keys(hash)) {
    if (!key.startsWith("s:") || !key.endsWith(":ts")) continue
    const symbol = key.slice(2, -3)
    if (options.symbols.size > 0 && !options.symbols.has(symbol.toUpperCase())) continue
    const timestamp = Number(hash[key])
    if (!(timestamp > 0) || !Number.isFinite(timestamp) || now - timestamp > options.maxAgeMs) continue
    const value = Number(hash[`s:${symbol}:${field}`])
    if (Number.isFinite(value) && value > 0) total += value
  }
  return total
}

/** Evaluation fractions describe the same fresh, selected symbol samples. */
export function summarizeFreshStageEvaluation(
  hash: Record<string, string>,
  options: { symbols: ReadonlySet<string>; maxAgeMs: number; now?: number; passedField?: string },
): { evaluated: number; passed: number; failed: number; passRatio: number } {
  const evaluated = sumFreshStageRowField(hash, "evaluated", options)
  const passed = Math.min(evaluated, sumFreshStageRowField(hash, options.passedField ?? "passed", options))
  return {
    evaluated,
    passed,
    failed: evaluated - passed,
    passRatio: evaluated > 0 ? Math.round(passed / evaluated * 1000) / 10 : 0,
  }
}
