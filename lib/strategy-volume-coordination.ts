export interface StrategyVolumePart {
  setKey: string
  direction: "long" | "short"
  ratio: number
  quality?: number
}

export interface HedgedStrategyVolume {
  direction: "long" | "short" | "flat"
  longRatio: number
  shortRatio: number
  netRatio: number
  longSetCount: number
  shortSetCount: number
  netSetCount: number
  /** Only unmatched dominant-direction ratios own physical exchange volume. */
  memberRatios: Record<string, number>
}

const round = (value: number) => Number(Math.max(0, value).toFixed(12))

/**
 * Hedge independent Strategy-Set ratios before one physical live order.
 * Higher-quality dominant Sets survive first; the final Set may survive only
 * partially. Every returned member ratio is therefore auditable and their
 * sum is exactly the one-order net ratio.
 */
export function hedgeStrategyVolumeParts(parts: readonly StrategyVolumePart[]): HedgedStrategyVolume {
  const normalized = parts
    .map((part) => ({
      setKey: String(part.setKey || "").trim(),
      direction: part.direction === "short" ? "short" as const : "long" as const,
      ratio: round(Number.isFinite(Number(part.ratio)) ? Number(part.ratio) : 0),
      quality: Number.isFinite(Number(part.quality)) ? Number(part.quality) : 0,
    }))
    .filter((part) => part.setKey && part.ratio > 0)
  const long = normalized.filter((part) => part.direction === "long")
  const short = normalized.filter((part) => part.direction === "short")
  const longRatio = round(long.reduce((sum, part) => sum + part.ratio, 0))
  const shortRatio = round(short.reduce((sum, part) => sum + part.ratio, 0))
  const signedNet = longRatio - shortRatio
  const tolerance = Math.max(1e-12, Math.max(longRatio, shortRatio) * 1e-10)
  if (Math.abs(signedNet) <= tolerance) {
    return {
      direction: "flat",
      longRatio,
      shortRatio,
      netRatio: 0,
      longSetCount: long.length,
      shortSetCount: short.length,
      netSetCount: 0,
      memberRatios: {},
    }
  }

  const direction: "long" | "short" = signedNet > 0 ? "long" : "short"
  const netRatio = round(Math.abs(signedNet))
  const dominant = (direction === "long" ? long : short)
    .slice()
    .sort((a, b) => b.quality - a.quality || a.setKey.localeCompare(b.setKey))
  const memberRatios: Record<string, number> = {}
  let remaining = netRatio
  for (const part of dominant) {
    if (remaining <= tolerance) break
    const contribution = round(Math.min(part.ratio, remaining))
    if (contribution > 0) memberRatios[part.setKey] = contribution
    remaining = round(remaining - contribution)
  }

  return {
    direction,
    longRatio,
    shortRatio,
    netRatio,
    longSetCount: long.length,
    shortSetCount: short.length,
    netSetCount: Object.keys(memberRatios).length,
    memberRatios,
  }
}
