/** Canonical operator-neutral symbol-selection defaults. */
export const DEFAULT_SYMBOL_COUNT = 1
export const DEFAULT_SYMBOL_ORDER = "volatility_1h" as const

/**
 * Return an explicitly configured local process cap, or null when no cap was
 * supplied. Absence must not silently expand the durable operator basket.
 */
export function getExplicitLocalSymbolCap(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = String(env.V0_DEV_SYMBOL_COUNT ?? "").trim()
  if (!raw) return null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) return null
  return Math.max(1, Math.min(1_000, Math.floor(parsed)))
}

export function getDefaultSymbolCount(
  env: Record<string, string | undefined> = process.env,
): number {
  return getExplicitLocalSymbolCap(env) ?? DEFAULT_SYMBOL_COUNT
}
