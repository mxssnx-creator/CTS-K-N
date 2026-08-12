/** Strict canonical direction parsing. Unknown values are data errors, never an implicit long. */
export function normalizeTradeDirection(...values: unknown[]): "long" | "short" | null {
  for (const value of values) {
    const normalized = String(value ?? "").trim().toLowerCase()
    if (normalized === "long" || normalized === "buy") return "long"
    if (normalized === "short" || normalized === "sell") return "short"
  }
  return null
}

/**
 * Resolve redundant direction fields without hiding contradictory lineage.
 * Unknown/empty fields are ignored; two valid opposite values fail closed.
 */
export function resolveConsistentTradeDirection(
  ...values: unknown[]
): "long" | "short" | null {
  let resolved: "long" | "short" | null = null
  for (const value of values) {
    const candidate = normalizeTradeDirection(value)
    if (!candidate) continue
    if (resolved && candidate !== resolved) return null
    resolved = candidate
  }
  return resolved
}

/**
 * Resolve authoritative position fields first and consult order-side or
 * legacy fallbacks only when no authoritative field contains a direction.
 *
 * Exchange position payloads sometimes expose both `positionSide=LONG` and
 * `side=SELL`: the former names the open hedge leg while the latter may name
 * the last/order action. Treating those fields as peers would reject a valid
 * Long leg. Contradictory authoritative fields still fail closed.
 */
export function resolveAuthoritativeTradeDirection(
  authoritativeValues: readonly unknown[],
  fallbackValues: readonly unknown[] = [],
): "long" | "short" | null {
  const hasAuthoritativeDirection = authoritativeValues.some(
    (value) => normalizeTradeDirection(value) !== null,
  )
  return hasAuthoritativeDirection
    ? resolveConsistentTradeDirection(...authoritativeValues)
    : resolveConsistentTradeDirection(...fallbackValues)
}
