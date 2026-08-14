import { getSettings } from "@/lib/redis-db"
import { withCanonicalForcedSymbols } from "@/lib/forced-symbols"
import { isServerlessDeploymentRuntime } from "@/lib/deployment-runtime"
import { getExplicitLocalSymbolCap } from "@/lib/symbol-selection-defaults"

export interface SymbolSelectionSnapshot {
  epoch: string
  symbols: string[]
  total: number
}

export function normalizeSymbolList(value: unknown): string[] {
  const normalize = (values: unknown[]) =>
    Array.from(new Set(values.map((s) => String(s).trim().toUpperCase()).filter(Boolean)))
  if (Array.isArray(value)) return normalize(value)
  if (typeof value !== "string") return []
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return normalize(parsed)
  } catch {
    // Legacy fields may be comma/newline separated.
  }
  return normalize(trimmed.split(/[\n,]/))
}

export function sameSymbolSelection(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const as = a.map((s) => s.trim()).filter(Boolean).sort()
  const bs = b.map((s) => s.trim()).filter(Boolean).sort()
  return as.every((symbol, index) => symbol === bs[index])
}

/**
 * Resolve the very same effective symbol basket as TradeEngineManager.
 *
 * Local dev/self-hosted production processes can deliberately cap the basket
 * to protect process memory.  Ownership checks must apply that cap too: if
 * the engine evaluates 12 symbols while the Historic writer still owns the
 * uncapped 13-symbol list (the mandatory BCH addition is a common example),
 * every historic generation immediately self-cancels as stale.
 */
function effectiveCanonicalSymbols(state: Record<string, unknown>, storedSymbols: string[]): string[] {
  const localCapActive =
    process.env.NODE_ENV === "development" ||
    (process.env.NODE_ENV === "production" && !isServerlessDeploymentRuntime())
  if (!localCapActive) return withCanonicalForcedSymbols(storedSymbols)

  const stateCap = Number(state.dev_symbol_count_override)
  const cap = Number.isFinite(stateCap) && stateCap >= 1
    ? Math.floor(stateCap)
    : getExplicitLocalSymbolCap()
  return cap ? withCanonicalForcedSymbols(storedSymbols, cap) : withCanonicalForcedSymbols(storedSymbols)
}

export async function getCanonicalSymbolSelection(connectionId: string): Promise<SymbolSelectionSnapshot | null> {
  const state = (await getSettings(`trade_engine_state:${connectionId}`).catch(() => ({}))) as Record<string, unknown>
  // `selected_symbols` is canonical, but older routes only mirrored one of
  // the runtime aliases. Falling back in priority order keeps a mixed-version
  // deployment from binding progress ownership to an empty/stale selection.
  const storedSymbols = [
    state.selected_symbols,
    state.force_symbols,
    state.active_symbols,
    state.symbols,
  ].map(normalizeSymbolList).find((candidate) => candidate.length > 0) || []
  const symbols = effectiveCanonicalSymbols(state, storedSymbols)
  const total = Number(state.config_set_symbols_total)
  if (symbols.length === 0 && (!Number.isFinite(total) || total <= 0)) return null
  return {
    epoch: String(state.symbol_selection_epoch || state.quickstart_symbol_generation || ""),
    symbols,
    total: symbols.length > 0 ? symbols.length : Math.max(0, total || 0),
  }
}

export async function ownsCanonicalSymbolSelection(connectionId: string, activeSymbols: string[]): Promise<boolean> {
  const selection = await getCanonicalSymbolSelection(connectionId)
  if (!selection || selection.symbols.length === 0) return true
  return sameSymbolSelection(selection.symbols, activeSymbols)
}

export function epochOwnsActiveSelection(writerEpoch: unknown, activeEpoch: unknown): boolean {
  const active = String(activeEpoch || "").trim()
  if (!active) return true
  return String(writerEpoch || "").trim() === active
}

export async function ownsCanonicalSymbolSelectionEpoch(connectionId: string, activeSymbols: string[], writerEpoch?: unknown): Promise<boolean> {
  const selection = await getCanonicalSymbolSelection(connectionId)
  if (!selection) return true
  return epochOwnsActiveSelection(writerEpoch ?? selection.epoch, selection.epoch)
    && (selection.symbols.length === 0 || sameSymbolSelection(selection.symbols, activeSymbols))
}

export async function canonicalTotalForSymbols(connectionId: string, activeSymbols: string[]): Promise<number> {
  const selection = await getCanonicalSymbolSelection(connectionId)
  if (selection?.total && selection.total > 0) return selection.total
  return activeSymbols.length
}

export function clampProcessedToTotal(processed: number, total: number): number {
  const safeProcessed = Number.isFinite(processed) && processed > 0 ? Math.floor(processed) : 0
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  return safeTotal > 0 ? Math.min(safeProcessed, safeTotal) : safeProcessed
}
