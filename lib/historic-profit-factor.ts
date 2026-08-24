export const HISTORIC_REALIZED_PROFIT_FACTOR_MAX = 9.999

export type HistoricProfitFactorSource =
  | "prehistoric-closed-results"
  | "no-closed-prehistoric-results"
  | "unavailable"
  | "invalid-prehistoric-aggregate"

export interface HistoricProfitFactorResolution {
  value: number
  count: number
  available: boolean
  source: HistoricProfitFactorSource
}

function ownsNonEmptyField(hash: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(hash, field) &&
    String(hash[field] ?? "").trim() !== ""
}

/**
 * Resolve the classic realised PF for one completed prehistoric projection.
 *
 * The dedicated prehistoric fields are the only valid source. A current
 * Base/Main/Real coordination PF describes a different population and must
 * never replace a valid historic zero (all losses), nor supply a sample count
 * when the historic run has no closed positions.
 */
export function resolveHistoricProfitFactor(
  prehistoric: Record<string, unknown> | null | undefined,
): HistoricProfitFactorResolution {
  const hash = prehistoric || {}
  const hasValue = ownsNonEmptyField(hash, "historic_avg_profit_factor")
  const hasCount = ownsNonEmptyField(hash, "historic_avg_profit_factor_count")

  if (!hasValue && !hasCount) {
    return { value: 0, count: 0, available: false, source: "unavailable" }
  }
  if (!hasValue || !hasCount) {
    return {
      value: 0,
      count: 0,
      available: false,
      source: "invalid-prehistoric-aggregate",
    }
  }

  const rawValue = Number(hash.historic_avg_profit_factor)
  const rawCount = Number(hash.historic_avg_profit_factor_count)
  if (
    !Number.isFinite(rawValue) || rawValue < 0 ||
    !Number.isFinite(rawCount) || rawCount < 0 || !Number.isInteger(rawCount)
  ) {
    return {
      value: 0,
      count: 0,
      available: false,
      source: "invalid-prehistoric-aggregate",
    }
  }

  if (rawCount === 0) {
    return {
      value: 0,
      count: 0,
      available: false,
      source: "no-closed-prehistoric-results",
    }
  }

  return {
    value: Math.min(HISTORIC_REALIZED_PROFIT_FACTOR_MAX, rawValue),
    count: rawCount,
    available: true,
    source: "prehistoric-closed-results",
  }
}
