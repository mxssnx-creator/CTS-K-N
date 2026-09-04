import {
  calculateClosedPositionSignedResultR,
  type ClosedPositionLike,
} from "@/lib/trade-engine/closed-position-aggregation"
import { MAIN_TRADE_BASE_PF_RATIO_DEFAULT } from "@/lib/main-trade-profit-factor"
import { isRealizedPnlAccountingPending } from "@/lib/live-position-pnl"

export const CONNECTION_STAGE_PF_WINDOW = 50

const finite = (value: unknown, fallback = 0): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const nonNegative = (value: unknown): number => Math.max(0, finite(value))

const rounded = (value: number, decimals = 4): number => {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

const firstPositive = (...values: unknown[]): number | null => {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}

function parsedObject(value: unknown): Record<string, any> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value !== "string") return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export interface ClosedStagePosition extends ClosedPositionLike {
  closedAt?: number
  updatedAt?: number
  createdAt?: number
  positionCostPct?: number
  realProfitFactorAtEntry?: number
  real_profit_factor_at_entry?: number
  upstreamRealProfitFactor?: number
  netEffectivePF?: number
  blockObservedProfitFactor?: number
  presetProfitFactor?: number
  prevPos?: { profitFactor?: number } | string
}

export interface RealLivePfComparison {
  window: number
  availableClosedPositions: number
  matchedPositions: number
  missingRealSnapshots: number
  realProfitFactor: number | null
  liveProfitFactor: number | null
  liveInfinite: boolean
  ratio: number | null
  ratioPercent: number | null
  difference: number | null
  differencePercent: number | null
  baseline: 1
  status: "unavailable" | "below" | "parity" | "above"
}

export function resolveRealProfitFactorSnapshot(position: ClosedStagePosition): number | null {
  const prevPos = parsedObject(position.prevPos)
  return firstPositive(
    position.realProfitFactorAtEntry,
    position.real_profit_factor_at_entry,
    position.upstreamRealProfitFactor,
    position.netEffectivePF,
    position.blockObservedProfitFactor,
    position.presetProfitFactor,
    prevPos?.profitFactor,
  )
}

function closedTimestamp(position: ClosedStagePosition): number {
  return Math.max(0, finite(position.closedAt ?? position.updatedAt ?? position.createdAt))
}

function hasClosedOutcome(position: ClosedStagePosition): boolean {
  if (isRealizedPnlAccountingPending(position)) return false
  const entry = firstPositive(
    position.averageExecutionPrice,
    position.entryPrice,
    position.entry_price,
  )
  if (!entry) return false
  const exit = firstPositive(
    position.closePrice,
    position.exitPrice,
    position.lastPrice,
    position.markPrice,
    position.current_price,
  )
  if (exit) return true
  return [position.realizedPnL, position.realized_pnl, position.pnl]
    .some((value) => value !== undefined && value !== null && Number.isFinite(Number(value)))
}

/**
 * Compare the upstream Real-stage PF snapshot with the realized Live PF for
 * the same newest closed physical positions. Ratio 1.0 is parity; 1.5 is
 * 150% of the Real-stage PF. Legacy rows without a Real snapshot stay visible
 * through `missingRealSnapshots` but never contaminate the matched sample.
 */
export function calculateRealLivePfComparison(
  positions: ClosedStagePosition[],
  window = CONNECTION_STAGE_PF_WINDOW,
): RealLivePfComparison {
  const normalizedWindow = Math.max(1, Math.floor(finite(window, CONNECTION_STAGE_PF_WINDOW)))
  const newest = [...(Array.isArray(positions) ? positions : [])]
    .sort((left, right) => closedTimestamp(right) - closedTimestamp(left))
    .filter(hasClosedOutcome)
    .slice(0, normalizedWindow)
  const matched = newest
    .map((position) => ({
      position,
      realPf: resolveRealProfitFactorSnapshot(position),
    }))
    .filter((row): row is { position: ClosedStagePosition; realPf: number } => row.realPf !== null)

  if (matched.length === 0) {
    return {
      window: normalizedWindow,
      availableClosedPositions: newest.length,
      matchedPositions: 0,
      missingRealSnapshots: newest.length,
      realProfitFactor: null,
      liveProfitFactor: null,
      liveInfinite: false,
      ratio: null,
      ratioPercent: null,
      difference: null,
      differencePercent: null,
      baseline: 1,
      status: "unavailable",
    }
  }

  let realPfSum = 0
  let liveGrossProfit = 0
  let liveGrossLoss = 0
  for (const { position, realPf } of matched) {
    realPfSum += realPf
    const cost = firstPositive(position.positionCostPct) ?? 0.1
    const liveResult = calculateClosedPositionSignedResultR(position, cost)
    if (liveResult > 0) liveGrossProfit += liveResult
    else if (liveResult < 0) liveGrossLoss += Math.abs(liveResult)
  }
  const realProfitFactor = realPfSum / matched.length
  const liveInfinite = liveGrossLoss === 0 && liveGrossProfit > 0
  const liveProfitFactor = liveGrossLoss > 0
    ? liveGrossProfit / liveGrossLoss
    : liveInfinite ? 999 : 0
  const ratio = realProfitFactor > 0 ? liveProfitFactor / realProfitFactor : null
  const difference = ratio === null ? null : ratio - 1
  const status = ratio === null
    ? "unavailable"
    : ratio > 1.005 ? "above" : ratio < 0.995 ? "below" : "parity"

  return {
    window: normalizedWindow,
    availableClosedPositions: newest.length,
    matchedPositions: matched.length,
    missingRealSnapshots: newest.length - matched.length,
    realProfitFactor: rounded(realProfitFactor),
    liveProfitFactor: rounded(liveProfitFactor),
    liveInfinite,
    ratio: ratio === null ? null : rounded(ratio),
    ratioPercent: ratio === null ? null : rounded(ratio * 100, 1),
    difference: difference === null ? null : rounded(difference),
    differencePercent: difference === null ? null : rounded(difference * 100, 1),
    baseline: 1,
    status,
  }
}

export interface StageOverviewInput {
  base: {
    totalOpen: number
    validOpen: number
    pfMinimum: number
  }
  main: {
    validOpen: number
    overallOpen: number
    breakdown?: {
      standard?: number
      trailing?: number
      positionCount?: number
      block?: number
      /** Calculated Block rows, including replacements excluded from Overall. */
      blockCalculated?: number
      dca?: number
    }
    /** Whether the Normal/default execution family is enabled. */
    normalEnabled?: boolean
    blockOnlyEnabled?: boolean
    trailingEnabled?: boolean
    blockEnabled?: boolean
    dcaEnabled?: boolean
  }
  real: {
    valid: number
    active: number
    activeExactSets?: number
  }
  live: {
    bySymbol?: Array<{ symbol?: string; long?: number; short?: number }>
    positions?: Array<{
      status?: string
      orderId?: string
      stopLossOrderId?: string
      takeProfitOrderId?: string
      securityStopOrderId?: string
    }>
    ordersPlaced?: number
  }
  cycle?: {
    base?: { total?: number; valid?: number }
    main?: { valid?: number; overall?: number }
    real?: { valid?: number; active?: number; activeExactSets?: number }
    live?: { total?: number; mirrored?: number; executable?: number }
  }
  snapshot?: {
    updatedAt?: number
    maxAgeMs?: number
    engineRunning?: boolean
    coverage?: {
      processed?: number
      total?: number
      complete?: boolean
    }
    stages?: Record<string, {
      covered?: number
      total?: number
      oldestUpdatedAt?: number
      latestUpdatedAt?: number
      fresh?: boolean
      complete?: boolean
    }>
  }
  closedPositions?: ClosedStagePosition[]
}

export function buildConnectionStageOverview(input: StageOverviewInput) {
  const now = Date.now()
  const baseTotal = nonNegative(input.base?.totalOpen)
  const baseValid = nonNegative(input.base?.validOpen)
  const mainValid = nonNegative(input.main?.validOpen)
  const mainOverall = nonNegative(input.main?.overallOpen)
  const breakdown = {
    standard: nonNegative(input.main?.breakdown?.standard),
    trailing: nonNegative(input.main?.breakdown?.trailing),
    positionCount: nonNegative(input.main?.breakdown?.positionCount),
    block: nonNegative(input.main?.breakdown?.block),
    dca: nonNegative(input.main?.breakdown?.dca),
  }
  const blockCalculated = nonNegative(
    input.main?.breakdown?.blockCalculated ?? input.main?.breakdown?.block,
  )
  const breakdownTotal = Object.values(breakdown).reduce((sum, value) => sum + value, 0)
  const liveBySymbol = (input.live?.bySymbol || []).map((row) => ({
    symbol: String(row?.symbol || "").toUpperCase(),
    long: nonNegative(row?.long),
    short: nonNegative(row?.short),
  })).filter((row) => row.symbol)
  const longPositions = liveBySymbol.reduce((sum, row) => sum + row.long, 0)
  const shortPositions = liveBySymbol.reduce((sum, row) => sum + row.short, 0)

  const pendingStatuses = new Set([
    "pending", "placed", "pending_fill", "placed_unconfirmed", "partially_filled", "opening",
  ])
  const exposedStatuses = new Set([
    "open", "filled", "partially_filled", "simulated", "closing", "closing_partial",
  ])
  const pendingEntryIds = new Set<string>()
  const controlOrderIds = new Set<string>()
  for (const position of input.live?.positions || []) {
    const status = String(position?.status || "").toLowerCase()
    const entryOrderId = String(position?.orderId || "").trim()
    if (entryOrderId && pendingStatuses.has(status)) pendingEntryIds.add(entryOrderId)
    if (exposedStatuses.has(status)) {
      for (const value of [position?.stopLossOrderId, position?.takeProfitOrderId, position?.securityStopOrderId]) {
        const id = String(value || "").trim()
        if (id) controlOrderIds.add(id)
      }
    }
  }
  const runningOrderIds = new Set([...pendingEntryIds, ...controlOrderIds])

  const snapshotUpdatedAt = Math.max(0, finite(input.snapshot?.updatedAt))
  const snapshotAgeMs = snapshotUpdatedAt > 0 ? Math.max(0, now - snapshotUpdatedAt) : null
  const snapshotMaxAgeMs = Math.max(5 * 60_000, finite(input.snapshot?.maxAgeMs, 5 * 60_000))
  const coverageTotal = nonNegative(input.snapshot?.coverage?.total)
  const coverageProcessed = Math.min(
    nonNegative(input.snapshot?.coverage?.processed),
    coverageTotal || Number.MAX_SAFE_INTEGER,
  )
  const stageSnapshots = Object.fromEntries(
    Object.entries(input.snapshot?.stages || {}).map(([stage, value]) => [stage, {
      covered: nonNegative(value?.covered),
      total: nonNegative(value?.total),
      oldestUpdatedAt: Math.max(0, finite(value?.oldestUpdatedAt)),
      latestUpdatedAt: Math.max(0, finite(value?.latestUpdatedAt)),
      fresh: value?.fresh === true,
      complete: value?.complete === true,
    }]),
  )

  const errors: string[] = []
  if (baseValid > baseTotal) errors.push(`Base Valid ${baseValid} exceeds Base Total ${baseTotal}`)
  if (mainOverall < mainValid) errors.push(`Main Overall ${mainOverall} is below Main Valid ${mainValid}`)
  if (nonNegative(input.real?.active) > nonNegative(input.real?.valid)) {
    errors.push(`Real Active ${nonNegative(input.real?.active)} exceeds Real Valid ${nonNegative(input.real?.valid)}`)
  }
  const breakdownComplete = mainOverall === 0 || breakdownTotal === mainOverall
  if (!breakdownComplete) {
    errors.push(`Main breakdown ${breakdownTotal} does not equal Overall ${mainOverall}`)
  }

  return {
    schemaVersion: 3,
    semantics: "latest-cycle-and-current-open-stage-relations",
    snapshot: {
      updatedAt: snapshotUpdatedAt,
      ageMs: snapshotAgeMs,
      fresh: input.snapshot?.engineRunning === true && snapshotAgeMs !== null && snapshotAgeMs <= snapshotMaxAgeMs,
      maxAgeMs: snapshotMaxAgeMs,
      complete: input.snapshot?.coverage?.complete === true,
      engineRunning: input.snapshot?.engineRunning === true,
      coverage: {
        processed: coverageProcessed,
        total: coverageTotal,
        percent: coverageTotal > 0 ? rounded((coverageProcessed / coverageTotal) * 100, 1) : 0,
        complete: input.snapshot?.coverage?.complete === true,
      },
      stages: stageSnapshots,
    },
    latestCycle: {
      base: {
        total: nonNegative(input.cycle?.base?.total),
        valid: nonNegative(input.cycle?.base?.valid),
      },
      main: {
        valid: nonNegative(input.cycle?.main?.valid),
        overall: nonNegative(input.cycle?.main?.overall),
      },
      real: {
        valid: nonNegative(input.cycle?.real?.valid),
        active: nonNegative(input.cycle?.real?.active),
        activeExactSets: nonNegative(input.cycle?.real?.activeExactSets),
      },
      live: {
        total: nonNegative(input.cycle?.live?.total),
        mirrored: nonNegative(input.cycle?.live?.mirrored),
        executable: nonNegative(input.cycle?.live?.executable),
      },
    },
    base: {
      total: baseTotal,
      valid: baseValid,
      pfMinimum: finite(input.base?.pfMinimum, MAIN_TRADE_BASE_PF_RATIO_DEFAULT),
      validPercent: baseTotal > 0 ? rounded((baseValid / baseTotal) * 100, 1) : 0,
    },
    main: {
      valid: mainValid,
      overall: mainOverall,
      additional: Math.max(0, mainOverall - mainValid),
      expansionPercent: mainValid > 0 ? rounded((mainOverall / mainValid) * 100, 1) : 0,
      breakdown,
      blockCalculated,
      breakdownComplete,
      normalEnabled: input.main?.normalEnabled !== false,
      blockOnlyEnabled: input.main?.blockOnlyEnabled === true,
      executionPolicy: {
        blockOnlyEnabled: input.main?.blockOnlyEnabled === true,
        normalEnabled: input.main?.normalEnabled !== false,
        trailingEnabled: input.main?.trailingEnabled !== false,
        blockEnabled: input.main?.blockEnabled !== false,
        dcaEnabled: input.main?.dcaEnabled === true,
      },
    },
    real: {
      valid: nonNegative(input.real?.valid),
      active: nonNegative(input.real?.active),
      activeExactSets: nonNegative(input.real?.activeExactSets),
      activePercent: nonNegative(input.real?.valid) > 0
        ? rounded((nonNegative(input.real?.active) / nonNegative(input.real?.valid)) * 100, 1)
        : 0,
      positionCountRelation: "one-active-count-per-base-lineage",
    },
    live: {
      total: longPositions + shortPositions,
      long: longPositions,
      short: shortPositions,
      symbols: liveBySymbol.length,
      bySymbol: liveBySymbol,
      orders: {
        placed: nonNegative(input.live?.ordersPlaced),
        running: runningOrderIds.size,
        pendingEntry: pendingEntryIds.size,
        control: controlOrderIds.size,
      },
    },
    pfComparison: calculateRealLivePfComparison(input.closedPositions || []),
    integrity: {
      valid: errors.length === 0,
      errors,
    },
  }
}
