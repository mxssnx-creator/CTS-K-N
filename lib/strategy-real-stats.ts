export const REAL_STRATEGY_VARIANTS = ["default", "trailing", "block", "dca"] as const

export type RealStrategyVariant = (typeof REAL_STRATEGY_VARIANTS)[number]

export const ADJUST_POSITION_DIFFERENCE_RATIO_STEP = 0.2

type NumericRecord = Record<string, unknown>

export interface RealVariantPositionStats {
  positions: number
  sets: number
  avgProfitFactor: number
  avgDrawdownTime: number
  passRate: number
  positionCountSource: "confirmed-ledger" | "evaluation-fallback"
}

export interface RealAdjustPositionStats extends RealVariantPositionStats {
  withoutStrategyPositions: number
  withStrategyPositions: number
  positionDifference: number
  differenceRatio: number | null
  differencePercent: number | null
  ratioStep: number
  ratioLevel: number | null
  comparisonAvailable: boolean
}

export interface RealHedgeBaseStats {
  parentSetKey: string
  symbol: string
  longEntries: number
  shortEntries: number
  longSets: number
  shortSets: number
  grossPositions: number
  positionsWithHedge: number
  hedgedPairs: number
  net: number
  /** Remaining, non-offset exposure (0 = fully offset, 1 = one direction only). */
  netExposureRatio: number
  /** Share of long+short legs removed by related-Base hedge netting. */
  hedgeOffsetRatio: number
  /** Backwards-compatible alias for the former Real detail payload. */
  hedgeRatio: number
  lastUpdated: number
}

export interface RealSymbolPositionStats {
  symbol: string
  longPositions: number
  shortPositions: number
  grossPositions: number
  positionsWithHedge: number
  hedgedPairs: number
  unclassifiedPositions: number
}

export interface RealStagePositionStats {
  overall: {
    positions: number
    positionsWithHedge: number
    hedgeReducedPositions: number
    hedgedPairs: number
    longPositions: number
    shortPositions: number
    unclassifiedPositions: number
    hedgeOffsetRatio: number
    hedgeOffsetPercent: number
    positionCountSource: "confirmed-ledger" | "evaluation-fallback"
  }
  strategyTypes: {
    default: RealVariantPositionStats
    trailing: RealVariantPositionStats
  }
  adjustTypes: {
    block: RealAdjustPositionStats
    dca: RealAdjustPositionStats
  }
  symbols: RealSymbolPositionStats[]
  hedge: {
    totalLongEntries: number
    totalShortEntries: number
    totalLongSets: number
    totalShortSets: number
    netEntries: number
    grossPositions: number
    positionsWithHedge: number
    hedgedPairs: number
    baseCount: number
    perBase: RealHedgeBaseStats[]
  }
}

function count(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/**
 * A rollout can encounter a pre-existing v2 ledger whose historic entries do
 * not yet have `by_variant:*` fields. Treat it as confirmed only once the
 * variant subtotal covers the ledger overall; until then callers must keep the
 * explicit evaluation fallback instead of presenting a partial count as exact.
 */
export function hasCompleteRealVariantPositionLedger(
  validPositionsHash: Record<string, string> | null | undefined,
): boolean {
  const hash = validPositionsHash || {}
  const hasFields = REAL_STRATEGY_VARIANTS.some((variant) =>
    Object.prototype.hasOwnProperty.call(hash, `by_variant:${variant}`),
  )
  if (!hasFields) return false
  const variantTotal = REAL_STRATEGY_VARIANTS.reduce(
    (sum, variant) => sum + count(hash[`by_variant:${variant}`]),
    0,
  )
  const overall = count(hash.overall)
  return overall <= 0 || variantTotal >= overall
}

function rounded(value: number, digits = 3): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Resolve a confirmed position's Real-stage category from its exact Set key.
 * Adjust variants take precedence over a trailing Base profile because Block
 * and DCA are the category that changed the position logistics/volume.
 */
export function inferRealStrategyVariant(
  setKey: string,
  explicit?: string | null,
): RealStrategyVariant {
  const normalizedExplicit = String(explicit || "").trim().toLowerCase()
  if ((REAL_STRATEGY_VARIANTS as readonly string[]).includes(normalizedExplicit)) {
    return normalizedExplicit as RealStrategyVariant
  }

  const normalizedKey = String(setKey || "").trim().toLowerCase()
  if (/(?:^|[#|:])block(?=[:#|]|$)/.test(normalizedKey)) return "block"
  if (/(?:^|[#|:])dca(?=[:#|]|$)/.test(normalizedKey)) return "dca"
  if (/(?:^|[#|:])trailing(?=[:#|]|$)/.test(normalizedKey)) return "trailing"
  // Base trailing profiles use compact suffixes such as `:t30-10`.
  if (/(?:^|:)t\d+(?:\.\d+)?-\d+(?:\.\d+)?(?=[:#|]|$)/.test(normalizedKey)) return "trailing"
  return "default"
}

function symbolFromParentSetKey(parentSetKey: string): string {
  const base = String(parentSetKey || "").split("#", 1)[0]
  const symbol = base.split(":", 1)[0]?.trim().toUpperCase()
  return symbol || "UNKNOWN"
}

function buildVariantStats(
  variant: RealStrategyVariant,
  metrics: NumericRecord,
  validPositionsHash: Record<string, string>,
  hasConfirmedVariantCounts: boolean,
): RealVariantPositionStats {
  const confirmedPositions = count(validPositionsHash[`by_variant:${variant}`])
  return {
    positions: hasConfirmedVariantCounts
      ? confirmedPositions
      : count(metrics.positionsCount ?? metrics.entriesCount),
    sets: count(metrics.passedSets ?? metrics.createdSets),
    avgProfitFactor: rounded(count(metrics.avgProfitFactor), 3),
    avgDrawdownTime: rounded(count(metrics.avgDrawdownTime), 1),
    passRate: rounded(count(metrics.passRate), 1),
    positionCountSource: hasConfirmedVariantCounts
      ? "confirmed-ledger"
      : "evaluation-fallback",
  }
}

function ratioLevel(ratio: number): number {
  if (!(ratio > 0)) return 0
  // Any positive difference enters the first 0.2 band; exact 0.2 multiples
  // stay in their own band despite floating-point representation noise.
  return rounded(
    Math.ceil((ratio - Number.EPSILON) / ADJUST_POSITION_DIFFERENCE_RATIO_STEP) *
      ADJUST_POSITION_DIFFERENCE_RATIO_STEP,
    1,
  )
}

function buildAdjustStats(
  stats: RealVariantPositionStats,
  withoutStrategyPositions: number,
): RealAdjustPositionStats {
  const comparisonAvailable = withoutStrategyPositions > 0
  const differenceRatio = comparisonAvailable
    ? stats.positions / withoutStrategyPositions
    : null
  return {
    ...stats,
    withoutStrategyPositions,
    withStrategyPositions: withoutStrategyPositions + stats.positions,
    positionDifference: stats.positions,
    differenceRatio: differenceRatio === null ? null : rounded(differenceRatio, 3),
    differencePercent: differenceRatio === null ? null : rounded(differenceRatio * 100, 1),
    ratioStep: ADJUST_POSITION_DIFFERENCE_RATIO_STEP,
    ratioLevel: differenceRatio === null ? null : ratioLevel(differenceRatio),
    comparisonAvailable,
  }
}

/**
 * Build the canonical Strategy Stage Real position view.
 *
 * Hedge reduction is calculated per related Base Set and then summed. This is
 * intentionally stricter than globally subtracting every short from every
 * long: unrelated strategies and different symbols must never cancel each
 * other in operator statistics.
 */
export function buildRealStagePositionStats(input: {
  validPositionsHash?: Record<string, string> | null
  hedgePosAccHash?: Record<string, string> | null
  strategyVariants?: Partial<Record<RealStrategyVariant | "overall", NumericRecord>> | null
}): RealStagePositionStats {
  const validPositionsHash = input.validPositionsHash || {}
  const hedgeHash = input.hedgePosAccHash || {}
  const variants = input.strategyVariants || {}
  const hasConfirmedVariantCounts = hasCompleteRealVariantPositionLedger(validPositionsHash)

  const defaultStats = buildVariantStats("default", variants.default || {}, validPositionsHash, hasConfirmedVariantCounts)
  const trailingStats = buildVariantStats("trailing", variants.trailing || {}, validPositionsHash, hasConfirmedVariantCounts)
  const blockStats = buildVariantStats("block", variants.block || {}, validPositionsHash, hasConfirmedVariantCounts)
  const dcaStats = buildVariantStats("dca", variants.dca || {}, validPositionsHash, hasConfirmedVariantCounts)
  const withoutAdjustPositions = defaultStats.positions + trailingStats.positions

  const hedgeByBase = new Map<string, {
    long: number
    short: number
    setsLong: number
    setsShort: number
    ts: number
  }>()
  for (const [field, rawValue] of Object.entries(hedgeHash)) {
    const separator = field.lastIndexOf(":")
    if (separator < 1) continue
    const parentSetKey = field.slice(0, separator)
    const suffix = field.slice(separator + 1)
    if (!["long", "short", "sets_long", "sets_short", "ts"].includes(suffix)) continue
    const entry = hedgeByBase.get(parentSetKey) || {
      long: 0,
      short: 0,
      setsLong: 0,
      setsShort: 0,
      ts: 0,
    }
    const value = count(rawValue)
    if (suffix === "long") entry.long = value
    else if (suffix === "short") entry.short = value
    else if (suffix === "sets_long") entry.setsLong = value
    else if (suffix === "sets_short") entry.setsShort = value
    else entry.ts = value
    hedgeByBase.set(parentSetKey, entry)
  }

  const symbolMap = new Map<string, RealSymbolPositionStats>()
  const perBase: RealHedgeBaseStats[] = []
  let totalLongEntries = 0
  let totalShortEntries = 0
  let totalLongSets = 0
  let totalShortSets = 0
  let hedgeGrossPositions = 0
  let hedgeNettedPositions = 0
  let hedgedPairs = 0

  for (const [parentSetKey, entry] of hedgeByBase) {
    const symbol = symbolFromParentSetKey(parentSetKey)
    const grossPositions = entry.long + entry.short
    const positionsWithHedge = Math.abs(entry.long - entry.short)
    const baseHedgedPairs = Math.min(entry.long, entry.short)
    const netExposureRatio = grossPositions > 0 ? positionsWithHedge / grossPositions : 0
    const hedgeOffsetRatio = grossPositions > 0
      ? (grossPositions - positionsWithHedge) / grossPositions
      : 0

    totalLongEntries += entry.long
    totalShortEntries += entry.short
    totalLongSets += entry.setsLong
    totalShortSets += entry.setsShort
    hedgeGrossPositions += grossPositions
    hedgeNettedPositions += positionsWithHedge
    hedgedPairs += baseHedgedPairs

    perBase.push({
      parentSetKey,
      symbol,
      longEntries: entry.long,
      shortEntries: entry.short,
      longSets: entry.setsLong,
      shortSets: entry.setsShort,
      grossPositions,
      positionsWithHedge,
      hedgedPairs: baseHedgedPairs,
      net: entry.long - entry.short,
      netExposureRatio: rounded(netExposureRatio, 3),
      hedgeOffsetRatio: rounded(hedgeOffsetRatio, 3),
      hedgeRatio: rounded(netExposureRatio, 3),
      lastUpdated: entry.ts,
    })

    const symbolEntry = symbolMap.get(symbol) || {
      symbol,
      longPositions: 0,
      shortPositions: 0,
      grossPositions: 0,
      positionsWithHedge: 0,
      hedgedPairs: 0,
      unclassifiedPositions: 0,
    }
    symbolEntry.longPositions += entry.long
    symbolEntry.shortPositions += entry.short
    symbolEntry.grossPositions += grossPositions
    // Sum the per-Base net; do not net unrelated Base strategies together.
    symbolEntry.positionsWithHedge += positionsWithHedge
    symbolEntry.hedgedPairs += baseHedgedPairs
    symbolMap.set(symbol, symbolEntry)
  }

  // Preserve symbols already counted by the confirmed ledger even if an older
  // run did not yet have direction-aware hedge fields. Their direction remains
  // explicitly unclassified instead of being guessed.
  for (const [field, rawValue] of Object.entries(validPositionsHash)) {
    if (!field.startsWith("by_symbol:")) continue
    const symbol = field.slice("by_symbol:".length).trim().toUpperCase() || "UNKNOWN"
    const confirmedForSymbol = count(rawValue)
    const symbolEntry = symbolMap.get(symbol) || {
      symbol,
      longPositions: 0,
      shortPositions: 0,
      grossPositions: 0,
      positionsWithHedge: 0,
      hedgedPairs: 0,
      unclassifiedPositions: 0,
    }
    const unmatched = Math.max(0, confirmedForSymbol - symbolEntry.grossPositions)
    symbolEntry.unclassifiedPositions = unmatched
    symbolEntry.grossPositions += unmatched
    symbolEntry.positionsWithHedge += unmatched
    symbolMap.set(symbol, symbolEntry)
  }

  perBase.sort((left, right) =>
    Math.abs(right.net) - Math.abs(left.net) || left.parentSetKey.localeCompare(right.parentSetKey),
  )
  const symbols = Array.from(symbolMap.values()).sort((left, right) =>
    right.grossPositions - left.grossPositions || left.symbol.localeCompare(right.symbol),
  )

  const confirmedOverall = count(validPositionsHash.overall)
  const evaluationFallback = count(variants.overall?.positionsCount ?? variants.overall?.entriesCount)
  const positions = Math.max(confirmedOverall, hedgeGrossPositions) || evaluationFallback
  const unmatchedOverall = Math.max(0, positions - hedgeGrossPositions)
  const positionsWithHedge = Math.min(positions, hedgeNettedPositions + unmatchedOverall)
  const hedgeReducedPositions = Math.max(0, positions - positionsWithHedge)
  const hedgeOffsetRatio = positions > 0 ? hedgeReducedPositions / positions : 0

  return {
    overall: {
      positions,
      positionsWithHedge,
      hedgeReducedPositions,
      hedgedPairs,
      longPositions: totalLongEntries,
      shortPositions: totalShortEntries,
      unclassifiedPositions: unmatchedOverall,
      hedgeOffsetRatio: rounded(hedgeOffsetRatio, 3),
      hedgeOffsetPercent: rounded(hedgeOffsetRatio * 100, 1),
      positionCountSource: confirmedOverall > 0 || hedgeGrossPositions > 0
        ? "confirmed-ledger"
        : "evaluation-fallback",
    },
    strategyTypes: {
      default: defaultStats,
      trailing: trailingStats,
    },
    adjustTypes: {
      block: buildAdjustStats(blockStats, withoutAdjustPositions),
      dca: buildAdjustStats(dcaStats, withoutAdjustPositions),
    },
    symbols,
    hedge: {
      totalLongEntries,
      totalShortEntries,
      totalLongSets,
      totalShortSets,
      netEntries: totalLongEntries - totalShortEntries,
      grossPositions: hedgeGrossPositions,
      positionsWithHedge: hedgeNettedPositions,
      hedgedPairs,
      baseCount: hedgeByBase.size,
      perBase,
    },
  }
}
