import { normalizeSymbolList } from "@/lib/trade-engine/symbol-selection-ownership"

export type SymbolSnapshot = Record<string, unknown> | null | undefined

/**
 * Resolve the currently effective basket from runtime snapshots.
 *
 * `connection.symbol_count` is a historical scalar and can outlive the
 * selection that produced it.  Runtime arrays are authoritative because they
 * identify the actual symbols owned by the current worker.  Keeping this
 * policy in one small helper prevents API and UI projections from displaying
 * stale values such as 536/536 after a worker has been reduced to 80 symbols.
 */
const SYMBOL_FIELDS = [
  "force_symbols",
  "selected_symbols",
  "active_symbols",
  "quickstart_symbols",
  "symbols",
  "forceSymbols",
  "selectedSymbols",
  "activeSymbols",
  "quickstartSymbols",
] as const

export function resolveCanonicalSymbols(
  ...snapshots: SymbolSnapshot[]
): { symbols: string[]; count: number; source: string } {
  // Field authority must outrank snapshot order. A connection hash may carry
  // a legacy generic `symbols` array containing the entire exchange catalog
  // (e.g. 536 markets), while the current scoped worker already publishes a
  // smaller `force_symbols`/`active_symbols` basket. Inspecting each snapshot
  // wholesale would let that catalog win before the live selection is seen.
  // Generic `symbols` remains a compatibility fallback only after every
  // semantic selection field has been checked.
  for (const field of SYMBOL_FIELDS) {
    for (const snapshot of snapshots) {
      if (!snapshot || typeof snapshot !== "object") continue
      const record = snapshot as Record<string, unknown>
      const nestedRaw = record.connection_settings ?? record.connectionSettings
      let nested: Record<string, unknown> | null = null
      if (nestedRaw && typeof nestedRaw === "object" && !Array.isArray(nestedRaw)) {
        nested = nestedRaw as Record<string, unknown>
      } else if (typeof nestedRaw === "string" && nestedRaw.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(nestedRaw)
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            nested = parsed as Record<string, unknown>
          }
        } catch {
          // Preserve compatibility with malformed legacy nested settings and
          // continue to the flattened snapshot below.
        }
      }
      // `connection_settings` is the canonical scoped selection on legacy
      // connection rows. The flattened `symbols`/`force_symbols` fields can
      // instead contain the complete exchange catalog (for example 536 X01
      // markets), so nested semantic fields must win when present.
      const candidates = nested ? [nested, record] : [record]
      for (const candidate of candidates) {
        const symbols = normalizeSymbolList(candidate[field])
        if (symbols.length > 0) {
          return { symbols, count: symbols.length, source: field }
        }
      }
    }
  }
  return { symbols: [], count: 0, source: "scalar_fallback" }
}

export function canonicalSymbolCount(
  scalarFallback: unknown,
  ...snapshots: SymbolSnapshot[]
): { count: number; source: string } {
  const resolved = resolveCanonicalSymbols(...snapshots)
  if (resolved.count > 0) return { count: resolved.count, source: resolved.source }
  const parsed = Number(scalarFallback)
  return Number.isFinite(parsed) && parsed > 0
    ? { count: Math.floor(parsed), source: "scalar_fallback" }
    : { count: 0, source: "none" }
}
