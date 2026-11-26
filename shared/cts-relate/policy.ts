export const RELATE_SOURCES = [
  "config", "overall", "symbol", "direction", "indication", "strategy", "coordination", "range",
] as const

export type RelateSource = typeof RELATE_SOURCES[number]
export type RelateScope = "set" | "overall"
export type RelateVolumeFactors = Partial<Record<RelateSource, number>>

export const RELATE_LABELS: Record<RelateSource, string> = {
  config: "Exact Set", overall: "All symbols", symbol: "Single symbol", direction: "Direction",
  indication: "Indication", strategy: "Strategy", coordination: "Coordination", range: "Range",
}

export function normalizeRelateFactors(raw: unknown): RelateVolumeFactors {
  const factors: RelateVolumeFactors = {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return factors
  const values = raw as Record<string, unknown>
  for (const source of RELATE_SOURCES) {
    const factor = values[source]
    if (typeof factor === "number" && Number.isFinite(factor)) factors[source] = Math.min(8, Math.max(0, factor))
  }
  return factors
}

export function relateKeys(context: string, config: string, symbol: string, direction: string,
  indication: string, strategy: string, coordination: string, range: string): Record<RelateSource, string> {
  return {
    config: JSON.stringify([context, "config", config]),
    overall: JSON.stringify([context, "overall"]),
    symbol: JSON.stringify([context, "symbol", symbol, direction]),
    direction: JSON.stringify([context, "direction", direction]),
    indication: JSON.stringify([context, "indication", indication, direction]),
    strategy: JSON.stringify([context, "strategy", strategy, direction]),
    coordination: JSON.stringify([context, "coordination", coordination, direction]),
    range: JSON.stringify([context, "range", range, direction]),
  }
}

interface RelateSizingPolicy {
  steps: number
  ratio: number
  lastN: number
  minTrades: number
  minPF: number
  maxMultiplier: number
  activeStep?: number
}

/** Returns the newest consecutive loss count, or null for an unqualified window. */
export function relateLossLevel(samples: readonly (number | undefined)[], policy: RelateSizingPolicy): number | null {
  const count = Math.min(samples.length, policy.lastN)
  if (count < policy.minTrades) return null
  let gain = 0
  let loss = 0
  let level = 0
  for (let index = 0; index < count; index++) {
    const result = samples[index]
    if (result === undefined || !Number.isFinite(result)) return null
    if (result > 0) gain += result
    if (result < 0) {
      loss -= result
      if (index === level && level < policy.steps) level++
    }
  }
  if (!(gain > loss) || !Number.isFinite(gain + loss) || (loss > 0 && gain / loss < policy.minPF)) return null
  return level
}

export function relateMultiplier(level: number, policy: RelateSizingPolicy): number {
  return Math.min(policy.maxMultiplier, (1 + policy.ratio) ** level)
}

/** Divide additional exposure among relation shares. Inactive shares stay idle. */
export function weightedRelateDecision(exactLevel: number | null, policy: RelateSizingPolicy,
  scope: RelateScope | undefined, factors: RelateVolumeFactors | undefined,
  levelOf: (source: RelateSource) => number | null): { multiplier: number; active: boolean } {
  const firstActive = policy.activeStep ?? 0
  if (exactLevel === null) return { multiplier: 1, active: firstActive === 0 }
  const sources = scope === "overall" ? RELATE_SOURCES : ["config"] as const
  let weight = 0
  let addition = 0
  let active = firstActive === 0
  for (const source of sources) {
    const factor = factors?.[source] ?? 1
    if (!(factor > 0)) continue
    weight += factor
    const level = source === "config" ? exactLevel : levelOf(source)
    if (level !== null && level >= firstActive) {
      active = true
      addition += factor * (relateMultiplier(level, policy) - 1)
    }
  }
  if (weight === 0) return { multiplier: 1, active }
  // In single-relation mode the factor can reduce the configured share of risk.
  const denominator = scope === "overall" ? weight : Math.max(1, weight)
  return { multiplier: Math.min(policy.maxMultiplier, 1 + addition / denominator), active }
}

export function weightedRelateAllocation(exactLevel: number | null, policy: RelateSizingPolicy,
  scope: RelateScope | undefined, factors: RelateVolumeFactors | undefined,
  levelOf: (source: RelateSource) => number | null): number {
  return weightedRelateDecision(exactLevel, policy, scope, factors, levelOf).multiplier
}
