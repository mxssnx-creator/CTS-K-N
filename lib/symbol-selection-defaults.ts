import { CANONICAL_FORCED_SYMBOLS } from "@/lib/forced-symbols"

/** Canonical operator-neutral symbol-selection defaults. */
export const DEFAULT_SYMBOL_COUNT = CANONICAL_FORCED_SYMBOLS.length
export const DEFAULT_SYMBOL_ORDER = "volatility_1h" as const

/**
 * Return an explicitly configured local process cap, or null when no cap was
 * supplied. Absence must not silently expand the durable operator basket.
 */
export function getExplicitLocalSymbolCap(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = String(env.V0_DEV_SYMBOL_COUNT ?? "").trim()
  // Keep the local InlineLocalRedis preview bounded when no env vars are
  // supplied. Operators can raise the cap explicitly with V0_DEV_SYMBOL_COUNT.
  if (!raw) return env.NODE_ENV === "development" ? CANONICAL_FORCED_SYMBOLS.length : null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) return null
  return Math.max(CANONICAL_FORCED_SYMBOLS.length, Math.min(1_000, Math.floor(parsed)))
}

export function getDefaultSymbolCount(
  env: Record<string, string | undefined> = process.env,
): number {
  return getExplicitLocalSymbolCap(env) ?? DEFAULT_SYMBOL_COUNT
}
