export interface EffectiveSecurityStop {
  required: boolean
  orderId: string
  price: number
  status: string
  armed: boolean
}

type SecurityStopCandidate = {
  required: boolean
  orderId: string
  price: number
  status: string
}

function finitePositive(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function candidate(value: Record<string, any>): SecurityStopCandidate {
  return {
    required: value.securityStopRequired === true,
    orderId: String(value.securityStopOrderId || "").trim(),
    price: finitePositive(value.securityStopPrice),
    status: String(value.securityStopStatus || "").trim().toLowerCase(),
  }
}

function coverageRows(position: Record<string, any>): Record<string, any>[] {
  const coverage = position.controlOrderSetCoverage
  if (Array.isArray(coverage)) {
    return coverage.filter((row): row is Record<string, any> => Boolean(row && typeof row === "object"))
  }
  if (coverage && typeof coverage === "object") {
    return Object.values(coverage)
      .filter((row): row is Record<string, any> => Boolean(row && typeof row === "object"))
  }
  return []
}

function candidatesFor(position: Record<string, any>): SecurityStopCandidate[] {
  return [candidate(position), ...coverageRows(position).map(candidate)]
}

/** Every distinct venue order currently represented as an armed security stop. */
export function collectArmedSecurityStopOrderIds(
  position: object | null | undefined,
): string[] {
  const source: Record<string, any> = position && typeof position === "object"
    ? position as Record<string, any>
    : {}
  return Array.from(new Set(
    candidatesFor(source)
      .filter((value) => Boolean(value.orderId) && value.price > 0 && value.status === "armed")
      .map((value) => value.orderId),
  ))
}

function candidateScore(value: SecurityStopCandidate): number {
  const isArmed = Boolean(value.orderId) && value.price > 0 && value.status === "armed"
  if (isArmed) return 100
  if (value.status === "pending") return 80
  if (["capacity_blocked", "ownership_mismatch", "invalid_range", "system_close"].includes(value.status)) return 70
  if (value.required) return 50
  if (value.orderId || value.price > 0 || value.status) return 20
  return 0
}

/**
 * Resolve the one physical symbol/direction security stop from either the
 * elected owner's top-level fields or a member row's shared coverage record.
 * An actually armed candidate wins over stale pending/missing coverage so all
 * API and UI surfaces report the same slot state.
 */
export function resolveEffectiveSecurityStop(
  position: object | null | undefined,
): EffectiveSecurityStop {
  const source: Record<string, any> = position && typeof position === "object"
    ? position as Record<string, any>
    : {}
  const candidates = candidatesFor(source)
  const required = candidates.some((value) =>
    value.required || (Boolean(value.orderId) && value.price > 0 && value.status === "armed"),
  )
  const selected = [...candidates].sort((left, right) => candidateScore(right) - candidateScore(left))[0]
    || candidate({})
  const armed = Boolean(selected.orderId) && selected.price > 0 && selected.status === "armed"
  return {
    required,
    orderId: selected.orderId,
    price: selected.price,
    status: selected.status || (required ? "missing" : "unsupported"),
    armed,
  }
}
