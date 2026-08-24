import { signedResultRToMainTradePfRatio } from "@/lib/main-trade-profit-factor"

export const HISTORIC_FOUR_HOUR_BUCKET_HOURS = 4
export const HISTORIC_FOUR_HOUR_BUCKET_MS =
  HISTORIC_FOUR_HOUR_BUCKET_HOURS * 60 * 60 * 1000
export const HISTORIC_FOUR_HOUR_PF_NEUTRAL = 1
export const HISTORIC_FOUR_HOUR_PF_MINIMUM = 1.1
export const HISTORIC_FOUR_HOUR_SCHEMA_VERSION = 2

const REDIS_BUCKET_PREFIX = "b"
const FLOAT_TOLERANCE = 1e-10

type MutableHistoricFourHourBucket = {
  symbols: number
  indicationConfigs: number
  strategyConfigs: number
  indicationsTotal: number
  indicationsBuy: number
  indicationsSell: number
  indicationsNeutral: number
  setResultsTotal: number
  setResultsClosed: number
  setResultsOpen: number
  wins: number
  losses: number
  breakeven: number
  netPnlPct: number
  grossProfitPct: number
  grossLossPct: number
  positionCostPct: number
  positionCostSamples: number
}

export type HistoricFourHourAccumulator = Map<number, MutableHistoricFourHourBucket>

export interface HistoricIndicationStatInput {
  timestamp?: unknown
  signal?: unknown
}

export interface HistoricPositionStatInput {
  entry_time?: unknown
  exit_time?: unknown
  status?: unknown
  result?: unknown
  position_cost_pct?: unknown
}

export interface HistoricFourHourPerformanceStats {
  wins: number
  losses: number
  breakeven: number
  netPnlPct: number
  grossProfitPct: number
  grossLossPct: number
  averageNetPnlPct: number | null
  averagePositionCostPct: number | null
  signedPositionCostMultiple: number | null
  pfCoordinate: number | null
  meetsMinimumPf: boolean
  realizedProfitFactor: number | null
  realizedProfitFactorInfinite: boolean
}

export interface HistoricFourHourMetrics {
  symbols: number
  indicationConfigs: number
  strategyConfigs: number
  indications: {
    total: number
    buy: number
    sell: number
    neutral: number
  }
  setResults: {
    total: number
    closed: number
    open: number
  }
  performance: HistoricFourHourPerformanceStats
}

export interface HistoricFourHourBucketStats extends HistoricFourHourMetrics {
  bucketStartMs: number
  bucketEndMs: number
  bucketStart: string
  bucketEnd: string
}

export interface HistoricFourHourStats {
  schemaVersion: number
  bucketHours: 4
  neutralPf: 1
  minimumPf: 1.1
  generation: string | null
  complete: boolean
  symbolsExpected: number | null
  symbolsProcessed: number | null
  indicationConfigs: number | null
  strategyConfigs: number | null
  rangeStart: string | null
  rangeEnd: string | null
  integrityValid: boolean
  integrityIssues: string[]
  updatedAt: string | null
  bucketCount: number
  summary: HistoricFourHourMetrics
  buckets: HistoricFourHourBucketStats[]
}

export interface HistoricFourHourRedisIncrement {
  field: string
  value: number
}

const REDIS_FIELDS: Readonly<Record<keyof MutableHistoricFourHourBucket, string>> = {
  symbols: "symbols",
  indicationConfigs: "indication_configs",
  strategyConfigs: "strategy_configs",
  indicationsTotal: "indications_total",
  indicationsBuy: "indications_buy",
  indicationsSell: "indications_sell",
  indicationsNeutral: "indications_neutral",
  setResultsTotal: "set_results_total",
  setResultsClosed: "set_results_closed",
  setResultsOpen: "set_results_open",
  wins: "wins",
  losses: "losses",
  breakeven: "breakeven",
  netPnlPct: "net_pnl_pct",
  grossProfitPct: "gross_profit_pct",
  grossLossPct: "gross_loss_pct",
  positionCostPct: "position_cost_pct",
  positionCostSamples: "position_cost_samples",
}

const REDIS_FIELDS_REVERSE = new Map(
  Object.entries(REDIS_FIELDS).map(([property, field]) => [field, property as keyof MutableHistoricFourHourBucket]),
)

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function rounded(value: number, decimals = 10): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function optionalNonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null
}

function isoTimestamp(value: unknown): string | null {
  const epochMs = historicEpochMs(value)
  return epochMs === null ? null : new Date(epochMs).toISOString()
}

function emptyBucket(): MutableHistoricFourHourBucket {
  return {
    symbols: 0,
    indicationConfigs: 0,
    strategyConfigs: 0,
    indicationsTotal: 0,
    indicationsBuy: 0,
    indicationsSell: 0,
    indicationsNeutral: 0,
    setResultsTotal: 0,
    setResultsClosed: 0,
    setResultsOpen: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    netPnlPct: 0,
    grossProfitPct: 0,
    grossLossPct: 0,
    positionCostPct: 0,
    positionCostSamples: 0,
  }
}

function bucketAt(
  accumulator: HistoricFourHourAccumulator,
  bucketStartMs: number,
): MutableHistoricFourHourBucket {
  const existing = accumulator.get(bucketStartMs)
  if (existing) return existing
  const created = emptyBucket()
  accumulator.set(bucketStartMs, created)
  return created
}

/**
 * Normalize exchange/Redis timestamps without local-time interpretation.
 * Numeric epochs below 1e11 are seconds; larger numeric values are ms.
 */
export function historicEpochMs(value: unknown): number | null {
  if (
    typeof value === "number" ||
    (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
  ) {
    let parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return null
    if (parsed < 100_000_000_000) parsed *= 1000
    return Math.floor(parsed)
  }
  if (typeof value !== "string") return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** Fixed elapsed UTC windows: [00:00,04:00), [04:00,08:00), ... */
export function historicFourHourBucketStartMs(value: unknown): number | null {
  const epochMs = historicEpochMs(value)
  if (epochMs === null) return null
  return Math.floor(epochMs / HISTORIC_FOUR_HOUR_BUCKET_MS) * HISTORIC_FOUR_HOUR_BUCKET_MS
}

export function historicFourHourBucketStarts(values: readonly unknown[]): number[] {
  const starts = new Set<number>()
  for (const value of values) {
    const start = historicFourHourBucketStartMs(value)
    if (start !== null) starts.add(start)
  }
  return [...starts].sort((left, right) => left - right)
}

export function createHistoricFourHourAccumulator(): HistoricFourHourAccumulator {
  return new Map()
}

/**
 * Count exhaustive config evaluations once for each symbol/window. The
 * aggregate is persisted exactly once per symbol, so `symbols` is a unique
 * symbol count inside each four-hour window and config counts are transparent
 * config×symbol evaluations rather than sampled/top-K estimates.
 */
export function markHistoricFourHourCoverage(
  accumulator: HistoricFourHourAccumulator,
  bucketStarts: readonly number[],
  options: { indicationConfigs: number; strategyConfigs: number },
): void {
  const indicationConfigs = Math.max(0, Math.floor(finite(options.indicationConfigs)))
  const strategyConfigs = Math.max(0, Math.floor(finite(options.strategyConfigs)))
  for (const bucketStartMs of new Set(bucketStarts)) {
    if (!Number.isFinite(bucketStartMs) || bucketStartMs < 0) continue
    const bucket = bucketAt(accumulator, bucketStartMs)
    bucket.symbols += 1
    bucket.indicationConfigs += indicationConfigs
    bucket.strategyConfigs += strategyConfigs
  }
}

export function recordHistoricFourHourIndications(
  accumulator: HistoricFourHourAccumulator,
  results: readonly HistoricIndicationStatInput[],
  aliasCount = 1,
): void {
  const multiplier = Math.max(0, Math.floor(finite(aliasCount, 1)))
  if (multiplier === 0) return
  for (const result of results) {
    const bucketStartMs = historicFourHourBucketStartMs(result.timestamp)
    if (bucketStartMs === null) continue
    const bucket = bucketAt(accumulator, bucketStartMs)
    const signal = String(result.signal ?? "neutral").trim().toLowerCase()
    bucket.indicationsTotal += multiplier
    if (signal === "buy") bucket.indicationsBuy += multiplier
    else if (signal === "sell") bucket.indicationsSell += multiplier
    else bucket.indicationsNeutral += multiplier
  }
}

/**
 * Assign closed results to their exit window and open results to their entry
 * window. Only closed positions contribute to realised PnL/PF. `result` is
 * already net of PositionCost in the historic calculator, so no second cost
 * deduction occurs here.
 */
export function recordHistoricFourHourPositions(
  accumulator: HistoricFourHourAccumulator,
  positions: readonly HistoricPositionStatInput[],
  aliasCount = 1,
  fallbackPositionCostPct = 0,
): void {
  const multiplier = Math.max(0, Math.floor(finite(aliasCount, 1)))
  const fallbackCost = Math.max(0, finite(fallbackPositionCostPct))
  if (multiplier === 0) return

  for (const position of positions) {
    const closed = String(position.status ?? "").trim().toLowerCase() === "closed"
    const eventTime = closed
      ? position.exit_time ?? position.entry_time
      : position.entry_time ?? position.exit_time
    const bucketStartMs = historicFourHourBucketStartMs(eventTime)
    if (bucketStartMs === null) continue
    const bucket = bucketAt(accumulator, bucketStartMs)
    bucket.setResultsTotal += multiplier

    if (!closed) {
      bucket.setResultsOpen += multiplier
      continue
    }

    const resultPct = finite(position.result)
    const explicitCost = finite(position.position_cost_pct, Number.NaN)
    const positionCostPct = explicitCost > 0 ? explicitCost : fallbackCost
    bucket.setResultsClosed += multiplier
    bucket.netPnlPct += resultPct * multiplier
    if (resultPct > 0) {
      bucket.wins += multiplier
      bucket.grossProfitPct += resultPct * multiplier
    } else if (resultPct < 0) {
      bucket.losses += multiplier
      bucket.grossLossPct += Math.abs(resultPct) * multiplier
    } else {
      bucket.breakeven += multiplier
    }
    if (positionCostPct > 0) {
      bucket.positionCostPct += positionCostPct * multiplier
      bucket.positionCostSamples += multiplier
    }
  }
}

export function historicFourHourRedisIncrements(
  accumulator: HistoricFourHourAccumulator,
): HistoricFourHourRedisIncrement[] {
  const increments: HistoricFourHourRedisIncrement[] = []
  for (const [bucketStartMs, bucket] of [...accumulator.entries()].sort(([left], [right]) => left - right)) {
    for (const [property, field] of Object.entries(REDIS_FIELDS) as Array<[
      keyof MutableHistoricFourHourBucket,
      string,
    ]>) {
      const value = bucket[property]
      if (!Number.isFinite(value) || value === 0) continue
      increments.push({
        field: `${REDIS_BUCKET_PREFIX}:${bucketStartMs}:${field}`,
        value,
      })
    }
  }
  return increments
}

function performanceFromBucket(bucket: MutableHistoricFourHourBucket): HistoricFourHourPerformanceStats {
  const hasCostCoordinate =
    bucket.setResultsClosed > 0 &&
    bucket.positionCostSamples > 0 &&
    bucket.positionCostPct > 0
  const signedPositionCostMultiple = hasCostCoordinate
    ? bucket.netPnlPct / bucket.positionCostPct
    : null
  const pfCoordinate = signedPositionCostMultiple === null
    ? null
    : signedResultRToMainTradePfRatio(signedPositionCostMultiple)
  const realizedProfitFactorInfinite =
    bucket.setResultsClosed > 0 &&
    bucket.grossProfitPct > 0 &&
    bucket.grossLossPct <= FLOAT_TOLERANCE
  const realizedProfitFactor = bucket.grossLossPct > FLOAT_TOLERANCE
    ? rounded(bucket.grossProfitPct / bucket.grossLossPct)
    : null

  return {
    wins: Math.max(0, Math.round(bucket.wins)),
    losses: Math.max(0, Math.round(bucket.losses)),
    breakeven: Math.max(0, Math.round(bucket.breakeven)),
    netPnlPct: rounded(bucket.netPnlPct),
    grossProfitPct: rounded(bucket.grossProfitPct),
    grossLossPct: rounded(bucket.grossLossPct),
    averageNetPnlPct: bucket.setResultsClosed > 0
      ? rounded(bucket.netPnlPct / bucket.setResultsClosed)
      : null,
    averagePositionCostPct: bucket.positionCostSamples > 0
      ? rounded(bucket.positionCostPct / bucket.positionCostSamples)
      : null,
    signedPositionCostMultiple: signedPositionCostMultiple === null
      ? null
      : rounded(signedPositionCostMultiple),
    pfCoordinate,
    meetsMinimumPf:
      pfCoordinate !== null &&
      pfCoordinate + FLOAT_TOLERANCE >= HISTORIC_FOUR_HOUR_PF_MINIMUM,
    realizedProfitFactor,
    realizedProfitFactorInfinite,
  }
}

function metricsFromBucket(bucket: MutableHistoricFourHourBucket): HistoricFourHourMetrics {
  return {
    symbols: Math.max(0, Math.round(bucket.symbols)),
    indicationConfigs: Math.max(0, Math.round(bucket.indicationConfigs)),
    strategyConfigs: Math.max(0, Math.round(bucket.strategyConfigs)),
    indications: {
      total: Math.max(0, Math.round(bucket.indicationsTotal)),
      buy: Math.max(0, Math.round(bucket.indicationsBuy)),
      sell: Math.max(0, Math.round(bucket.indicationsSell)),
      neutral: Math.max(0, Math.round(bucket.indicationsNeutral)),
    },
    setResults: {
      total: Math.max(0, Math.round(bucket.setResultsTotal)),
      closed: Math.max(0, Math.round(bucket.setResultsClosed)),
      open: Math.max(0, Math.round(bucket.setResultsOpen)),
    },
    performance: performanceFromBucket(bucket),
  }
}

function mergeBucket(target: MutableHistoricFourHourBucket, source: MutableHistoricFourHourBucket): void {
  for (const property of Object.keys(REDIS_FIELDS) as Array<keyof MutableHistoricFourHourBucket>) {
    target[property] += source[property]
  }
}

export function parseHistoricFourHourAggregate(
  raw: Record<string, string> | null | undefined,
): HistoricFourHourStats {
  const hash = raw && typeof raw === "object" ? raw : {}
  const buckets = new Map<number, MutableHistoricFourHourBucket>()
  for (const [field, rawValue] of Object.entries(hash)) {
    const match = field.match(/^b:(\d+):([a-z_]+)$/)
    if (!match) continue
    const bucketStartMs = Number(match[1])
    const property = REDIS_FIELDS_REVERSE.get(match[2])
    const value = Number(rawValue)
    if (!property || !Number.isFinite(bucketStartMs) || !Number.isFinite(value)) continue
    bucketAt(buckets, bucketStartMs)[property] += value
  }

  const summaryBucket = emptyBucket()
  const parsedBuckets = [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([bucketStartMs, bucket]) => {
      mergeBucket(summaryBucket, bucket)
      return {
        bucketStartMs,
        bucketEndMs: bucketStartMs + HISTORIC_FOUR_HOUR_BUCKET_MS,
        bucketStart: new Date(bucketStartMs).toISOString(),
        bucketEnd: new Date(bucketStartMs + HISTORIC_FOUR_HOUR_BUCKET_MS).toISOString(),
        ...metricsFromBucket(bucket),
      }
    })

  const updatedAtMs = historicEpochMs(hash.updated_at_ms || hash.updated_at)
  const schemaVersion = Math.max(
    1,
    Math.floor(finite(hash.schema_version, HISTORIC_FOUR_HOUR_SCHEMA_VERSION)),
  )
  const symbolsExpected = optionalNonNegativeInteger(hash.symbols_expected)
  const symbolsProcessed = optionalNonNegativeInteger(hash.symbols_processed)
  const indicationConfigs = optionalNonNegativeInteger(hash.indication_configs)
  const strategyConfigs = optionalNonNegativeInteger(hash.strategy_configs)
  const rangeStart = isoTimestamp(hash.range_start_ms || hash.range_start)
  const rangeEnd = isoTimestamp(hash.range_end_ms || hash.range_end)
  const declaredComplete = hash.complete === "1" || hash.complete === "true"
  const integrityIssues: string[] = []

  if (
    declaredComplete &&
    symbolsExpected !== null &&
    symbolsProcessed !== null &&
    symbolsProcessed < symbolsExpected
  ) {
    integrityIssues.push(
      `Completed coverage is ${symbolsProcessed}/${symbolsExpected} symbols.`,
    )
  }

  for (const bucket of parsedBuckets) {
    const windowLabel = bucket.bucketStart.slice(0, 16)
    if (symbolsExpected !== null && bucket.symbols > symbolsExpected) {
      integrityIssues.push(
        `${windowLabel} contains ${bucket.symbols} symbol evaluations, above the ${symbolsExpected}-symbol generation.`,
      )
    }
    if (
      indicationConfigs !== null &&
      bucket.indicationConfigs !== bucket.symbols * indicationConfigs
    ) {
      integrityIssues.push(`${windowLabel} indication-config coverage is inconsistent.`)
    }
    if (
      strategyConfigs !== null &&
      bucket.strategyConfigs !== bucket.symbols * strategyConfigs
    ) {
      integrityIssues.push(`${windowLabel} strategy-config coverage is inconsistent.`)
    }
    if (
      bucket.indications.total !==
      bucket.indications.buy + bucket.indications.sell + bucket.indications.neutral
    ) {
      integrityIssues.push(`${windowLabel} indication direction totals are inconsistent.`)
    }
    if (bucket.setResults.total !== bucket.setResults.closed + bucket.setResults.open) {
      integrityIssues.push(`${windowLabel} closed/open set-result totals are inconsistent.`)
    }
    if (
      bucket.setResults.closed !==
      bucket.performance.wins + bucket.performance.losses + bucket.performance.breakeven
    ) {
      integrityIssues.push(`${windowLabel} realised outcome totals are inconsistent.`)
    }
    if (
      rangeStart !== null &&
      rangeEnd !== null &&
      (bucket.bucketEndMs <= Date.parse(rangeStart) || bucket.bucketStartMs > Date.parse(rangeEnd))
    ) {
      integrityIssues.push(`${windowLabel} lies outside the declared calculation range.`)
    }
  }

  const uniqueIntegrityIssues = [...new Set(integrityIssues)]

  return {
    schemaVersion,
    bucketHours: HISTORIC_FOUR_HOUR_BUCKET_HOURS,
    neutralPf: HISTORIC_FOUR_HOUR_PF_NEUTRAL,
    minimumPf: HISTORIC_FOUR_HOUR_PF_MINIMUM,
    generation: String(hash.generation || "").trim() || null,
    complete: declaredComplete && uniqueIntegrityIssues.length === 0,
    symbolsExpected,
    symbolsProcessed,
    indicationConfigs,
    strategyConfigs,
    rangeStart,
    rangeEnd,
    integrityValid: uniqueIntegrityIssues.length === 0,
    integrityIssues: uniqueIntegrityIssues,
    updatedAt: updatedAtMs === null ? null : new Date(updatedAtMs).toISOString(),
    bucketCount: parsedBuckets.length,
    summary: metricsFromBucket(summaryBucket),
    buckets: parsedBuckets,
  }
}
