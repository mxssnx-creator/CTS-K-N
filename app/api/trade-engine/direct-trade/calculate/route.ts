import { type NextRequest, NextResponse } from "next/server"
import { getConnection, getRedisClient, initRedis } from "@/lib/redis-db"
import {
  clampDirectTradeSymbolCount,
  clampDirectTradeVolumeFactor,
  DIRECT_TRADE_VOLUME_FACTOR_DEFAULT,
} from "@/lib/direct-trade-limits"
import { fetchTopSymbols, type SortKey } from "@/lib/top-symbols"
import {
  deleteDirectTradeConfigGeneration,
  createDirectTradeConfigStoreWriter,
} from "@/lib/direct-trade-config-store"
import { fetchDirectTradeMinuteHistory } from "@/lib/direct-trade-market-history"
import { normalizePositionCostPercent, POSITION_COST_PERCENT_DEFAULT } from "@/lib/position-cost"
import { normalizeMainTradePfRatio } from "@/lib/main-trade-profit-factor"
import { DEFAULT_DCA_PROFILE, normalizeDcaProfile, type DcaProfile } from "@/lib/dca-strategy"
import { CANONICAL_FORCED_SYMBOLS, withCanonicalForcedSymbols } from "@/lib/forced-symbols"
import {
  createRedisLockToken,
  releaseOwnedRedisLock,
  renewOwnedRedisLock,
} from "@/lib/redis-lock-utils"
import {
  buildTimeframeCombinations,
  evaluateDirectTradeSets,
  normaliseDirectTradeTimeframes,
  normaliseDirectTradeStrategyTypes,
  normaliseEntryTactics,
  normaliseExitTactics,
  resampleCandles,
  buildDirectTradeTakeProfitPositionCostRatios,
  directTradeTakeProfitPercent,
  calculateDirectTradeProfitFactor,
  averageDirectTradeTakeProfitRatio,
  normaliseDirectTradeTakeProfitRatioRange,
  normaliseDirectTradeTakeProfitRatioStep,
  normaliseDirectTradeTrailingMinTakeProfitRatio,
  DIRECT_TRADE_TRAILING_MIN_TAKE_PROFIT_RATIO_DEFAULT,
  DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT,
  DIRECT_TRADE_RECENT_PF_DEFAULT,
  type DirectTradeEntryTiming,
  type DirectTradeStrategyType,
  type DirectTradeTrailOption,
} from "@/lib/direct-trade-coordination"
import directTradeHistoryPolicy from "@/lib/direct-trade-history-policy.cjs"
import {
  DIRECT_TRADE_CONNECTION_INDEX_KEY,
  directTradeKeyspace,
  normalizeDirectTradeConnectionId,
} from "@/lib/direct-trade-keyspace"

const { clampDirectTradeHistoryHours } = directTradeHistoryPolicy

export const dynamic = "force-dynamic"
// A 32-symbol, bounded 48-90-hour public-history refresh is a real full-grid operation.
// Give long-lived/compatible deployment runtimes enough wall time to page the
// exchange without silently truncating the requested independent evaluation.
export const maxDuration = 300

const DIRECT_TRADE_CALCULATION_LEASE_SECONDS = 330
const DIRECT_STOP_LOSS_RATIO_MIN = 0.25
const DIRECT_STOP_LOSS_RATIO_MAX = 1.5
const DIRECT_INVERSE_STOP_LOSS_RATIO_MAX = 1.5
const DIRECT_STOP_LOSS_RATIO_DEFAULT = 0.75
const DIRECT_INVERSE_STOP_LOSS_RATIO_DEFAULT = 1.25
const DIRECT_STOP_LOSS_RATIO_STEP = 0.25

interface CalculationRequest {
  connectionId?: string
  symbolCount?: number
  symbolOrder?: SortKey
  volumeFactor?: number
  minVolFactor?: number
  maxSlRatio?: number
  inverseMaxSlRatio?: number
  slRatioStep?: number
  timeframes?: string[]
  strategyTypes?: string[]
  blockRange?: [number, number]
  trailingEnabled?: boolean
  minProfitFactor?: number
  minRecentProfitFactor?: number
  recentEvaluationPositions?: number
  maxDrawdownTimeMin?: number
  historyHours?: number
  requestedHistoryHours?: number
  entryTactics?: string[]
  exitTactics?: string[]
  entryTiming?: DirectTradeEntryTiming
  activityVolumeRatio?: number
  maxHoldMinutes?: number
  positionCostPercent?: number
  takeProfitRatioRange?: [number, number]
  takeProfitRatioStep?: number
  trailingMinTakeProfitRatio?: number
  blockVolumeRatio?: number
  blockProfitFactorRatio?: number
  dcaProfile?: unknown
  recalculate?: boolean
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function stopLossRatios(
  maxSlRatio: number,
  absoluteMaximum = DIRECT_STOP_LOSS_RATIO_MAX,
  requestedStep = DIRECT_STOP_LOSS_RATIO_STEP,
): number[] {
  const ratios: number[] = []
  const safeMaximum = Math.min(
    absoluteMaximum,
    Math.max(DIRECT_STOP_LOSS_RATIO_MIN, maxSlRatio),
  )
  const step = Math.max(DIRECT_STOP_LOSS_RATIO_STEP, Math.min(DIRECT_STOP_LOSS_RATIO_MAX, requestedStep))
  for (let ratio = DIRECT_STOP_LOSS_RATIO_MIN; ratio <= safeMaximum + 0.00001; ratio += step) {
    ratios.push(Number(Math.min(ratio, safeMaximum).toFixed(2)))
  }
  // A reduced grid must still test the configured maximum protection value.
  if (ratios.at(-1) !== Number(safeMaximum.toFixed(2))) ratios.push(Number(safeMaximum.toFixed(2)))
  return ratios
}

type EvaluatedDirectTradeConfig = Awaited<ReturnType<typeof evaluateDirectTradeSets>>[number]

type CalculationAxisBucket = {
  evaluated: number
  valid: number
  disabled: number
  totalPnl: number
  netProfit: number
  netLoss: number
}

type FinishedCalculationAxisBucket = CalculationAxisBucket & {
  averagePnlPerSet: number
  profitFactor: number | null
  profitFactorInfinite: boolean
}

function createCalculationAxisBucket(): CalculationAxisBucket {
  return {
    evaluated: 0,
    valid: 0,
    disabled: 0,
    totalPnl: 0,
    netProfit: 0,
    netLoss: 0,
  }
}

function appendCalculationAxisBucket(
  bucket: CalculationAxisBucket,
  config: EvaluatedDirectTradeConfig,
): void {
  bucket.evaluated++
  bucket.valid += config.valid ? 1 : 0
  bucket.disabled += config.valid ? 0 : 1
  bucket.totalPnl += Number(config.totalPnl) || 0
  bucket.netProfit += Number(config.netProfit ?? config.grossProfit) || 0
  bucket.netLoss += Number(config.netLoss ?? config.grossLoss) || 0
}

function finishCalculationAxis(
  axis: Record<string, CalculationAxisBucket>,
): Record<string, FinishedCalculationAxisBucket> {
  return Object.fromEntries(Object.entries(axis).map(([key, bucket]) => {
    const pf = calculateDirectTradeProfitFactor(bucket.netProfit, bucket.netLoss)
    return [key, {
      ...bucket,
      averagePnlPerSet: bucket.evaluated > 0 ? bucket.totalPnl / bucket.evaluated : 0,
      profitFactor: pf.profitFactor,
      profitFactorInfinite: pf.profitFactorInfinite,
    }]
  }))
}

function exactNumericAxisKey(value: unknown): string {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? String(Number(parsed.toFixed(6))) : "unknown"
}

function createCalculationSummaryAccumulator(details: {
  symbols: string[]
  historyHours: number
  requestedHistoryHours: number
  timeframes: string[]
  combinations: number
  entryTactics: string[]
  exitTactics: string[]
  strategyTypes: DirectTradeStrategyType[]
  entryTiming: DirectTradeEntryTiming
  minRecentProfitFactor: number
  recentEvaluationPositions: number
  positionCostPercent: number
  minVolFactor: number
  takeProfitRatioRange: [number, number]
  takeProfitRatioStep: number
  trailingMinTakeProfitRatio: number
  takeProfitPositionCostRatios: number[]
  activityVolumeRatio: number
  maxHoldMinutes: number
  blockRange: [number, number]
  blockVolumeRatio: number
  blockProfitFactorRatio: number
  dcaProfile: DcaProfile
}) {
  const countBy = <T extends string>(entries: T[]): Record<T, CalculationAxisBucket> => {
    const output = {} as Record<T, CalculationAxisBucket>
    for (const entry of entries) output[entry] = createCalculationAxisBucket()
    return output
  }
  const byTimeframe: Record<string, CalculationAxisBucket> = {}
  const byEntryTactic = countBy(details.entryTactics)
  const byExitTactic = countBy(details.exitTactics)
  const byStrategyType = countBy(details.strategyTypes)
  const byDirection = countBy(["long", "short"])
  const byStopLossRatio: Record<string, CalculationAxisBucket> = {}
  const byStopLossPercent: Record<string, CalculationAxisBucket> = {}
  const byTakeProfitPositionCostRatio: Record<string, CalculationAxisBucket> = {}
  const byTakeProfitPercent: Record<string, CalculationAxisBucket> = {}
  let evaluatedSets = 0
  let validSets = 0
  const eligibleSymbols = new Set<string>()
  const eligibleSymbolDirections = new Set<string>()
  const eligibleSymbolDirectionsByDirection = {
    long: new Set<string>(),
    short: new Set<string>(),
  }
  let totalScore = 0
  let baseGrossProfit = 0
  let baseGrossLoss = 0
  let baseNetProfit = 0
  let baseNetLoss = 0
  let selectedBlockGrossProfit = 0
  let selectedBlockGrossLoss = 0
  let selectedBlockNetProfit = 0
  let selectedBlockNetLoss = 0
  let selectedBlockPnl = 0
  let selectedBlockCount = 0
  let selectedBlockRealizedVolumeTotal = 0
  let blockLedgerGrossProfit = 0
  let blockLedgerGrossLoss = 0
  let blockLedgerNetProfit = 0
  let blockLedgerNetLoss = 0
  let blockEvaluatedSets = 0
  let blockValidSets = 0
  const byBlockCount: Record<string, {
    evaluated: number
    valid: number
    disabled: number
    observedPfSum: number
    observedPfCount: number
    infinitePf: number
    minimumPfSum: number
    differenceSum: number
    marginSum: number
    totalPnl: number
    grossProfitSum: number
    grossLossSum: number
    netProfitSum: number
    netLossSum: number
    realizedVolumeSum: number
  }> = {}
  const append = (config: EvaluatedDirectTradeConfig) => {
    const timeframe = byTimeframe[config.timeframe] || (byTimeframe[config.timeframe] = createCalculationAxisBucket())
    evaluatedSets++
    totalScore += config.score
    baseGrossProfit += Number(config.grossProfit) || 0
    baseGrossLoss += Number(config.grossLoss) || 0
    baseNetProfit += Number(config.netProfit ?? config.grossProfit) || 0
    baseNetLoss += Number(config.netLoss ?? config.grossLoss) || 0
    appendCalculationAxisBucket(timeframe, config)
    if (config.valid) {
      validSets++
      eligibleSymbols.add(config.symbol)
      eligibleSymbolDirections.add(`${config.symbol}|${config.direction}`)
      eligibleSymbolDirectionsByDirection[config.direction].add(config.symbol)
    }
    appendCalculationAxisBucket(byEntryTactic[config.entryTactic], config)
    appendCalculationAxisBucket(byExitTactic[config.exitTactic], config)
    appendCalculationAxisBucket(byStrategyType[config.strategyType], config)
    appendCalculationAxisBucket(byDirection[config.direction], config)

    const stopLossRatio = Number(config.takeprofit) > 0
      ? Number(config.stoploss) / Number(config.takeprofit)
      : Number.NaN
    const axes: Array<[Record<string, CalculationAxisBucket>, string]> = [
      [byStopLossRatio, exactNumericAxisKey(stopLossRatio)],
      [byStopLossPercent, exactNumericAxisKey(config.stoploss)],
      [byTakeProfitPositionCostRatio, exactNumericAxisKey(config.takeProfitPositionCostRatio)],
      [byTakeProfitPercent, exactNumericAxisKey(config.takeprofit)],
    ]
    for (const [axis, key] of axes) {
      appendCalculationAxisBucket(axis[key] || (axis[key] = createCalculationAxisBucket()), config)
    }
    for (const block of config.blockEvaluations || []) {
      blockEvaluatedSets++
      if (block.valid) blockValidSets++
      const count = byBlockCount[String(block.blockCount)] || (byBlockCount[String(block.blockCount)] = {
        evaluated: 0,
        valid: 0,
        disabled: 0,
        observedPfSum: 0,
        observedPfCount: 0,
        infinitePf: 0,
        minimumPfSum: 0,
        differenceSum: 0,
        marginSum: 0,
        totalPnl: 0,
        grossProfitSum: 0,
        grossLossSum: 0,
        netProfitSum: 0,
        netLossSum: 0,
        realizedVolumeSum: 0,
      })
      count.evaluated++
      count.valid += block.valid ? 1 : 0
      count.disabled += block.valid ? 0 : 1
      count.observedPfSum += block.blockObservedProfitFactor ?? 0
      count.observedPfCount += block.blockObservedProfitFactorInfinite ? 0 : Number.isFinite(Number(block.blockObservedProfitFactor)) ? 1 : 0
      count.infinitePf += block.blockObservedProfitFactorInfinite ? 1 : 0
      count.minimumPfSum += block.blockMinimumProfitFactor
      count.differenceSum += block.blockProfitFactorDifference
      count.marginSum += block.blockProfitFactorToMinimumDifference
      count.totalPnl += block.blockTotalPnl
      count.grossProfitSum += Number(block.blockGrossProfit) || 0
      count.grossLossSum += Number(block.blockGrossLoss) || 0
      count.netProfitSum += Number(block.blockNetProfit ?? block.blockGrossProfit) || 0
      count.netLossSum += Number(block.blockNetLoss ?? block.blockGrossLoss) || 0
      count.realizedVolumeSum += Number(block.blockRealizedVolumeMultiplier) || 0
      blockLedgerGrossProfit += Number(block.blockGrossProfit) || 0
      blockLedgerGrossLoss += Number(block.blockGrossLoss) || 0
      blockLedgerNetProfit += Number(block.blockNetProfit ?? block.blockGrossProfit) || 0
      blockLedgerNetLoss += Number(block.blockNetLoss ?? block.blockGrossLoss) || 0
    }
    const selectedBlock = config.blockCount > 0
      ? (config.blockEvaluations || []).find((block) => block.blockCount === config.blockCount)
      : null
    if (selectedBlock) {
      selectedBlockCount++
      selectedBlockGrossProfit += Number(selectedBlock.blockGrossProfit) || 0
      selectedBlockGrossLoss += Number(selectedBlock.blockGrossLoss) || 0
      selectedBlockNetProfit += Number(selectedBlock.blockNetProfit ?? selectedBlock.blockGrossProfit) || 0
      selectedBlockNetLoss += Number(selectedBlock.blockNetLoss ?? selectedBlock.blockGrossLoss) || 0
      selectedBlockPnl += Number(selectedBlock.blockTotalPnl) || 0
      selectedBlockRealizedVolumeTotal += Number(selectedBlock.blockRealizedVolumeMultiplier) || 0
    }
  }
  return {
    append,
    finish: () => ({
      calculatedAt: new Date().toISOString(),
      ...details,
      evaluatedSets,
      validSets,
      deactivatedSets: evaluatedSets - validSets,
      requestedHistoryHours: details.requestedHistoryHours,
      historyExpanded: details.historyHours > details.requestedHistoryHours,
      eligibleSymbols: [...eligibleSymbols].sort(),
      eligibleSymbolCount: eligibleSymbols.size,
      eligibleSymbolDirectionCount: eligibleSymbolDirections.size,
      eligibleSymbolDirectionsByDirection: {
        long: eligibleSymbolDirectionsByDirection.long.size,
        short: eligibleSymbolDirectionsByDirection.short.size,
      },
      blockEnabled: details.blockRange[1] > 0,
      blockEvaluatedSets,
      blockValidSets,
      blockDeactivatedSets: blockEvaluatedSets - blockValidSets,
      // PF is the aggregate ratio of summed positive/negative net PNL
      // components. Averaging per-row PF values or averaging the TP ratio
      // range is not a portfolio statistic.
      pfBasis: "aggregate_ratio_weighted_net_pnl",
      takeProfitRatioAverage: averageDirectTradeTakeProfitRatio(details.takeProfitPositionCostRatios),
      takeProfitPercentAverage: details.takeProfitPositionCostRatios.length > 0
        ? details.takeProfitPositionCostRatios.reduce((sum, ratio) => sum + directTradeTakeProfitPercent(details.positionCostPercent, ratio), 0) / details.takeProfitPositionCostRatios.length
        : 0,
      baseGrossProfit,
      baseGrossLoss,
      baseNetProfit,
      baseNetLoss,
      ...(() => {
        const pf = calculateDirectTradeProfitFactor(baseNetProfit, baseNetLoss)
        return { baseProfitFactor: pf.profitFactor, baseProfitFactorInfinite: pf.profitFactorInfinite }
      })(),
      selectedBlockGrossProfit,
      selectedBlockGrossLoss,
      selectedBlockNetProfit,
      selectedBlockNetLoss,
      ...(() => {
        const pf = calculateDirectTradeProfitFactor(selectedBlockNetProfit, selectedBlockNetLoss)
        return { selectedBlockProfitFactor: pf.profitFactor, selectedBlockProfitFactorInfinite: pf.profitFactorInfinite }
      })(),
      selectedBlockCount,
      selectedBlockPnl,
      selectedBlockMeanRealizedVolumeMultiplier: selectedBlockCount > 0
        ? selectedBlockRealizedVolumeTotal / selectedBlockCount
        : 0,
      blockLedgerGrossProfit,
      blockLedgerGrossLoss,
      blockLedgerNetProfit,
      blockLedgerNetLoss,
      ...(() => {
        const pf = calculateDirectTradeProfitFactor(blockLedgerNetProfit, blockLedgerNetLoss)
        return { blockLedgerProfitFactor: pf.profitFactor, blockLedgerProfitFactorInfinite: pf.profitFactorInfinite }
      })(),
      byBlockCount: Object.fromEntries(Object.entries(byBlockCount).map(([blockCount, value]) => [blockCount, {
        ...value,
        meanObservedPF: value.observedPfCount > 0 ? value.observedPfSum / value.observedPfCount : null,
        aggregateObservedPF: value.netLossSum > 0 ? value.netProfitSum / value.netLossSum : null,
        aggregateObservedPFInfinite: value.netLossSum === 0 && value.netProfitSum > 0,
        meanRealizedVolumeMultiplier: value.evaluated > 0
          ? value.realizedVolumeSum / value.evaluated
          : 0,
        meanMinimumPF: value.evaluated > 0 ? value.minimumPfSum / value.evaluated : 0,
        meanProfitFactorDifference: value.evaluated > 0 ? value.differenceSum / value.evaluated : 0,
        meanProfitFactorToMinimumDifference: value.evaluated > 0 ? value.marginSum / value.evaluated : 0,
      }])),
      avgScore: evaluatedSets > 0 ? totalScore / evaluatedSets : 0,
      byTimeframe: finishCalculationAxis(byTimeframe),
      byEntryTactic: finishCalculationAxis(byEntryTactic),
      byExitTactic: finishCalculationAxis(byExitTactic),
      byStrategyType: finishCalculationAxis(byStrategyType),
      byDirection: finishCalculationAxis(byDirection),
      byStopLossRatio: finishCalculationAxis(byStopLossRatio),
      byStopLossPercent: finishCalculationAxis(byStopLossPercent),
      byTakeProfitPositionCostRatio: finishCalculationAxis(byTakeProfitPositionCostRatio),
      byTakeProfitPercent: finishCalculationAxis(byTakeProfitPercent),
    }),
  }
}

type StatisticsRow = Pick<EvaluatedDirectTradeConfig,
  "setKey" | "symbol" | "direction" | "signalDirection" | "strategyType" | "timeframe" | "entryTactic" | "exitTactic" |
  "valid" | "deactivationReason" | "profitFactor" | "profitFactorInfinite" | "winRate" |
  "totalTrades" | "maxDrawdownTimeMin" | "score" | "totalPnl" | "bestMarketExitPnl" | "positionCostPercent" |
  "takeprofit" | "takeProfitPositionCostRatio" | "stoploss" |
  "lastPositionPnl" | "lastPositionBestMarketExitPnl" | "lastPositionDrawdownTimeMin" | "lastPositionExitReason" |
  "recentPositionCount" | "recentProfitFactor" | "recentProfitFactorInfinite" | "recentWinRate" |
  "recentTotalPnl" | "recentAvgDrawdownTimeMin" | "blockCount" | "blockProfitFactorRatio" |
  "blockValid" | "blockDeactivationReason" | "blockObservedProfitFactor" |
  "blockObservedProfitFactorInfinite" | "blockNormalProfitFactor" | "blockMinimumProfitFactor" |
  "blockConfiguredMinimumProfitFactor" | "blockProfitFactorDifference" | "blockComparisonAvailable" |
  "blockProfitFactorToMinimumDifference" |
  "blockProfitFactorWindow" | "blockProfitFactorSampleCount" | "blockAvgDrawdownTimeMin" |
  "blockMaxDrawdownTimeMin" | "blockTotalPnl" | "blockVolumeIncrementRatio" |
  "blockCalculatedVolumeMultiplier" | "blockRealizedVolumeMultiplier"
>

// `Pick<>` is compile-time only. Passing the original evaluated config into
// the Statistics accumulator used to retain and later stringify every nested
// `blockEvaluations` ledger even though StatisticsRow does not declare it.
// At the 32-symbol grid that duplicated the twelve-count ledger across every
// top-row filter and exceeded V8's maximum string length. Keep this explicit
// runtime projection next to the type so the read model remains genuinely
// compact as new evaluation fields are added.
const STATISTICS_ROW_FIELDS = [
  "setKey", "symbol", "direction", "signalDirection", "strategyType", "timeframe",
  "entryTactic", "exitTactic", "valid", "deactivationReason", "profitFactor",
  "profitFactorInfinite", "winRate", "totalTrades", "maxDrawdownTimeMin", "score",
  "totalPnl", "bestMarketExitPnl", "positionCostPercent", "takeprofit",
  "takeProfitPositionCostRatio", "stoploss", "lastPositionPnl",
  "lastPositionBestMarketExitPnl", "lastPositionDrawdownTimeMin", "lastPositionExitReason",
  "recentPositionCount", "recentProfitFactor", "recentProfitFactorInfinite", "recentWinRate",
  "recentTotalPnl", "recentAvgDrawdownTimeMin", "blockCount", "blockProfitFactorRatio",
  "blockValid", "blockDeactivationReason", "blockObservedProfitFactor",
  "blockObservedProfitFactorInfinite", "blockNormalProfitFactor", "blockMinimumProfitFactor",
  "blockConfiguredMinimumProfitFactor", "blockProfitFactorDifference", "blockComparisonAvailable",
  "blockProfitFactorToMinimumDifference", "blockProfitFactorWindow", "blockProfitFactorSampleCount",
  "blockAvgDrawdownTimeMin", "blockMaxDrawdownTimeMin", "blockTotalPnl",
  "blockVolumeIncrementRatio", "blockCalculatedVolumeMultiplier", "blockRealizedVolumeMultiplier",
] as const satisfies readonly (keyof StatisticsRow)[]

function compactStatisticsRow(config: EvaluatedDirectTradeConfig): StatisticsRow {
  const row: Partial<StatisticsRow> = {}
  for (const field of STATISTICS_ROW_FIELDS) {
    const value = config[field]
    if (value !== undefined) (row as Record<string, unknown>)[field] = value
  }
  return row as StatisticsRow
}

function statisticsFilterKey(timeframe: string, direction: string, state: string, strategyType = "all"): string {
  return `${timeframe}\u0001${direction}\u0001${state}\u0001${strategyType}`
}

/**
 * Build a compact score-sorted read model while configs stream through the
 * evaluator. The UI never needs to deserialize the full independent grid on
 * refresh, and the calculation never keeps that complete grid in V8 heap.
 */
function createStatisticsIndexAccumulator() {
  const totals: Record<string, number> = {}
  const topRows: Record<string, StatisticsRow[]> = {}
  const insertTopRow = (rows: StatisticsRow[], config: StatisticsRow) => {
    if (rows.length >= 100 && config.score <= rows[rows.length - 1].score) return
    let index = rows.findIndex((row) => config.score > row.score)
    if (index < 0) index = rows.length
    rows.splice(index, 0, config)
    if (rows.length > 100) rows.pop()
  }
  const append = (config: EvaluatedDirectTradeConfig) => {
    const row = compactStatisticsRow(config)
    const state = config.valid ? "valid" : "inactive"
    for (const timeframe of ["all", config.timeframe]) {
      for (const direction of ["all", config.direction]) {
        for (const activityState of ["all", state]) {
          for (const strategyType of ["all", config.strategyType]) {
            const key = statisticsFilterKey(timeframe, direction, activityState, strategyType)
            totals[key] = (totals[key] || 0) + 1
            const rows = topRows[key] || (topRows[key] = [])
            insertTopRow(rows, row)
          }
        }
      }
    }
  }
  return {
    append,
    finish: () => {
      // The same selected row participates in up to sixteen filter buckets.
      // Normalise it once and persist integer references instead of repeating
      // the full row in JSON for every timeframe/direction/state/type view.
      const rows: StatisticsRow[] = []
      const rowIndexes = new Map<StatisticsRow, number>()
      const topRowIndexes: Record<string, number[]> = {}
      for (const [key, selectedRows] of Object.entries(topRows)) {
        topRowIndexes[key] = selectedRows.map((row) => {
          const existing = rowIndexes.get(row)
          if (existing !== undefined) return existing
          const index = rows.length
          rows.push(row)
          rowIndexes.set(row, index)
          return index
        })
      }
      return {
        schemaVersion: 2,
        version: new Date().toISOString(),
        totals,
        rows,
        topRowIndexes,
      }
    },
  }
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  const worker = async () => {
    while (next < values.length) {
      const index = next++
      results[index] = await mapper(values[index])
    }
  }
  // Public API backpressure only: every requested symbol and every requested
  // configuration is still evaluated; we merely avoid a burst that would make
  // the venue reject its own historical data requests.
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, worker))
  return results
}

export async function POST(request: NextRequest) {
  let calculationLease: { client: ReturnType<typeof getRedisClient>; token: string } | null = null
  let calculationLeaseHeld = false
  let leaseRenewalTimer: ReturnType<typeof setInterval> | undefined
  let calculationConnectionId: string | null = null
  try {
    const body: CalculationRequest = await request.json().catch(() => ({}))
    const connectionId = normalizeDirectTradeConnectionId(body.connectionId)
    calculationConnectionId = connectionId
    const keys = directTradeKeyspace(connectionId)
    const symbolCount = Math.max(
      CANONICAL_FORCED_SYMBOLS.length,
      clampDirectTradeSymbolCount(body.symbolCount),
    )
    const symbolOrder: SortKey = body.symbolOrder || "volatility_1h"
    // The factor is a base-sizing input. Exchange minimums are enforced only
    // at live order submission, so historical evaluation is not inflated by
    // venue floors and the UI range remains identical to runtime sizing.
    const minVolFactor = clampDirectTradeVolumeFactor(
      body.volumeFactor ?? body.minVolFactor,
      DIRECT_TRADE_VOLUME_FACTOR_DEFAULT,
    )
    const maxSlRatio = numberOr(body.maxSlRatio, DIRECT_STOP_LOSS_RATIO_DEFAULT)
    const inverseMaxSlRatio = numberOr(body.inverseMaxSlRatio, DIRECT_INVERSE_STOP_LOSS_RATIO_DEFAULT)
    const slRatioStep = Math.max(DIRECT_STOP_LOSS_RATIO_STEP, Math.min(0.75, numberOr(body.slRatioStep, DIRECT_STOP_LOSS_RATIO_STEP)))
    const timeframes = normaliseDirectTradeTimeframes(body.timeframes)
    const timeframeSets = buildTimeframeCombinations(timeframes)
    const strategyTypes = normaliseDirectTradeStrategyTypes(body.strategyTypes)
    const blockRange: [number, number] = Array.isArray(body.blockRange) && body.blockRange.length === 2
      ? [Math.max(0, Math.floor(numberOr(body.blockRange[0], 1))), Math.max(0, Math.floor(numberOr(body.blockRange[1], 12)))]
      : [1, 12]
    blockRange.sort((left, right) => left - right)
    const trailingEnabled = body.trailingEnabled !== false
    const minProfitFactor = normalizeMainTradePfRatio(
      body.minProfitFactor,
      DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT,
    )
    // A 12-position recent window avoids accepting a historical PF that is
    // already contradicted by the latest closed positions. The shared strict
    // default is checked by the deterministic full-matrix paper test.
    const minRecentProfitFactor = normalizeMainTradePfRatio(
      body.minRecentProfitFactor,
      DIRECT_TRADE_RECENT_PF_DEFAULT,
    )
    const recentEvaluationPositions = Math.max(3, Math.floor(numberOr(body.recentEvaluationPositions, 12)))
    const maxDrawdownTimeMin = Math.max(1, numberOr(body.maxDrawdownTimeMin, 10))
    const historyHours = clampDirectTradeHistoryHours(body.historyHours, 48)
    const requestedHistoryHours = Math.min(
      historyHours,
      clampDirectTradeHistoryHours(body.requestedHistoryHours, historyHours),
    )
    const entryTactics = normaliseEntryTactics(body.entryTactics)
    const exitTactics = normaliseExitTactics(body.exitTactics)
    const entryTiming: DirectTradeEntryTiming = body.entryTiming === "last_confirmed" ? "last_confirmed" : "current"
    const activityVolumeRatio = Math.max(0, numberOr(body.activityVolumeRatio, 1))
    const maxHoldMinutes = Math.max(1, numberOr(body.maxHoldMinutes, 120))
    const positionCostPercent = normalizePositionCostPercent(body.positionCostPercent ?? POSITION_COST_PERCENT_DEFAULT)
    const takeProfitPositionCostRatios = buildDirectTradeTakeProfitPositionCostRatios(
      normaliseDirectTradeTakeProfitRatioRange(body.takeProfitRatioRange),
      normaliseDirectTradeTakeProfitRatioStep(body.takeProfitRatioStep),
    )
    const trailingMinTakeProfitRatio = normaliseDirectTradeTrailingMinTakeProfitRatio(
      body.trailingMinTakeProfitRatio,
      DIRECT_TRADE_TRAILING_MIN_TAKE_PROFIT_RATIO_DEFAULT,
    )
    const takeProfitRange = takeProfitPositionCostRatios.map((ratio) =>
      directTradeTakeProfitPercent(positionCostPercent, ratio),
    )
    const blockVolumeRatio = Math.max(0.1, Math.min(10, numberOr(body.blockVolumeRatio, 1)))
    const blockProfitFactorRatio = Math.max(0.2, Math.min(5, numberOr(body.blockProfitFactorRatio, 0.8)))
    const dcaProfile = normalizeDcaProfile(body.dcaProfile ?? DEFAULT_DCA_PROFILE)

    // A manual dashboard refresh and the long-running processor can arrive at
    // the same time. The complete grid is an atomic snapshot, so only one
    // owner may fetch/evaluate/publish it. Renewing keeps the lock valid for a
    // full maximum-symbol historical pass instead of allowing a second worker
    // to start after a short, stale TTL.
    await initRedis()
    const client = getRedisClient()
    const connection = connectionId ? await getConnection(connectionId) : null
    if (connectionId && !connection) {
      return NextResponse.json({ error: `Direct-Trade connection ${connectionId} was not found` }, { status: 404 })
    }
    const exchange = String(connection?.exchange || connection?.exchange_name || (connectionId ? "" : "bingx"))
      .trim()
      .toLowerCase()
    if (exchange !== "bingx" && exchange !== "bybit") {
      return NextResponse.json({
        error: `Direct-Trade historical processing is not supported for exchange ${exchange || "unknown"}`,
      }, { status: 409 })
    }
    if (connectionId) await client.sadd(DIRECT_TRADE_CONNECTION_INDEX_KEY, connectionId)
    const token = createRedisLockToken("direct-trade-calculation")
    const acquired = await client.set(keys.calculationLease, token, {
      NX: true,
      EX: DIRECT_TRADE_CALCULATION_LEASE_SECONDS,
    })
    if (acquired !== "OK") {
      return NextResponse.json({
        error: "A Direct-Trade calculation is already in progress",
        retryAfterSeconds: 10,
      }, { status: 409 })
    }
    calculationLease = { client, token }
    calculationLeaseHeld = true
    let renewalInFlight = false
    leaseRenewalTimer = setInterval(() => {
      if (renewalInFlight || !calculationLease) return
      renewalInFlight = true
      void renewOwnedRedisLock(
        calculationLease.client,
        keys.calculationLease,
        calculationLease.token,
        DIRECT_TRADE_CALCULATION_LEASE_SECONDS,
      ).then((renewed) => {
        calculationLeaseHeld = renewed
      }).catch(() => {
        calculationLeaseHeld = false
      }).finally(() => {
        renewalInFlight = false
      })
    }, 15_000)

    const top = await fetchTopSymbols(exchange, symbolCount, symbolOrder)
    const symbols = withCanonicalForcedSymbols(
      top.symbols.slice(0, symbolCount).map((ticker) => ticker.symbol),
      symbolCount,
    )
    if (symbols.length === 0) return NextResponse.json({ error: "No symbols available" }, { status: 400 })
    const calculationStartedAt = new Date().toISOString()
    let completedSymbols = 0
    let evaluatedSets = 0
    // This compact progress record is the only object written during a long
    // calculation. The complete config grid is published atomically at the
    // end, so consumers never deserialize or observe a half-built list.
    await client.set(keys.calculationProgress, JSON.stringify({
      status: "running",
      startedAt: calculationStartedAt,
      completedSymbols,
      totalSymbols: symbols.length,
      evaluatedSets,
    }))

    const noTrailingOption: DirectTradeTrailOption = { trailing: false, trailStart: 0, trailStop: 0, mode: "none" }
    const fixedTrailOptions: DirectTradeTrailOption[] = trailingEnabled
      ? [
          { trailing: true, trailStart: 0.3, trailStop: 0.2, mode: "fixed" },
          { trailing: true, trailStart: 0.5, trailStop: 0.3, mode: "fixed" },
          { trailing: true, trailStart: 1, trailStop: 0.5, mode: "fixed" },
        ]
      : []
    const autoTrailOptions: DirectTradeTrailOption[] = trailingEnabled
      ? [0.75, 1, 1.25].map((autoTrailSensitivity) => ({
          trailing: true,
          // Runtime values are calculated from the last activity/movement
          // window. These documented fallbacks only protect older workers.
          trailStart: 0.5,
          trailStop: 0.3,
          mode: "auto" as const,
          autoTrailSensitivity,
        }))
      : []
    const slRatios = stopLossRatios(maxSlRatio, DIRECT_STOP_LOSS_RATIO_MAX, slRatioStep)
    const inverseSlRatios = stopLossRatios(inverseMaxSlRatio, DIRECT_INVERSE_STOP_LOSS_RATIO_MAX, slRatioStep)
    const summaryAccumulator = createCalculationSummaryAccumulator({
      symbols,
      historyHours,
      requestedHistoryHours,
      timeframes,
      combinations: timeframeSets.length,
      entryTactics,
      exitTactics,
      strategyTypes,
      entryTiming,
      minRecentProfitFactor,
      recentEvaluationPositions,
      positionCostPercent,
      minVolFactor,
      takeProfitRatioRange: normaliseDirectTradeTakeProfitRatioRange(body.takeProfitRatioRange),
      takeProfitRatioStep: normaliseDirectTradeTakeProfitRatioStep(body.takeProfitRatioStep),
      trailingMinTakeProfitRatio,
      takeProfitPositionCostRatios,
      activityVolumeRatio,
      maxHoldMinutes,
      blockRange,
      blockVolumeRatio,
      blockProfitFactorRatio,
      dcaProfile,
    })
    const statisticsAccumulator = createStatisticsIndexAccumulator()
    const configStoreWriter = await createDirectTradeConfigStoreWriter(client, connectionId)
    // Global indexes stay compact (integer references plus signal buckets),
    // while the associated rich config rows stream straight to storage.
    const executionCandidates: Array<{ index: number; score: number; signalKey: string | null }> = []
    let nextConfigIndex = 0
    const appendEvaluatedConfigs = async (rows: EvaluatedDirectTradeConfig[]) => {
      for (const config of rows) {
        summaryAccumulator.append(config)
        statisticsAccumulator.append(config)
        if (config.valid) {
          executionCandidates.push({
            index: nextConfigIndex,
            score: Number.isFinite(config.score) ? config.score : 0,
            signalKey: typeof config.entrySignalKey === "string" && config.entrySignalKey ? config.entrySignalKey : null,
          })
        }
        nextConfigIndex++
      }
      // Count 1..N is fully aggregated above and the selected Block lane is
      // already present on the stored row. Do not duplicate a large nested
      // object twelve times inside every Redis config; the compact calculation
      // summary owns the complete count-indexed audit view.
      await configStoreWriter.append(rows.map((config) => {
        const { blockEvaluations: _blockEvaluations, ...compact } = config
        return compact as EvaluatedDirectTradeConfig
      }))
    }
    // CPU-bound set evaluation is deterministic JavaScript. Sequential symbol
    // draining avoids retaining four symbol grids at once; public history is
    // still rate-safe and each config reaches the streaming writer immediately.
    await mapWithConcurrency(symbols, 1, async (symbol) => {
      let symbolEvaluated = 0
      try {
        const minuteCandles = await fetchDirectTradeMinuteHistory(exchange, symbol, historyHours)
        if (minuteCandles.length >= 30) {
          const candlesByTimeframe = {
            "5m": resampleCandles(minuteCandles, 5),
            "15m": resampleCandles(minuteCandles, 15),
            "30m": resampleCandles(minuteCandles, 30),
          } as const
          for (const timeframeSet of timeframeSets) {
            for (const direction of ["long", "short"] as const) {
          const plans: Array<{
            strategyType: DirectTradeStrategyType
            signalDirection: "long" | "short"
            tpRange: number[]
            slRatios: number[]
            trailOptions: DirectTradeTrailOption[]
          }> = []
          if (strategyTypes.includes("standard")) {
            plans.push({ strategyType: "standard", signalDirection: direction, tpRange: takeProfitRange, slRatios, trailOptions: [noTrailingOption] })
          }
          if (strategyTypes.includes("trailing_fixed") && fixedTrailOptions.length > 0) {
            plans.push({ strategyType: "trailing_fixed", signalDirection: direction, tpRange: takeProfitRange, slRatios, trailOptions: fixedTrailOptions })
          }
          if (strategyTypes.includes("trailing_auto") && autoTrailOptions.length > 0) {
            plans.push({ strategyType: "trailing_auto", signalDirection: direction, tpRange: takeProfitRange, slRatios, trailOptions: autoTrailOptions })
          }
          if (strategyTypes.includes("combination")) {
            // Formerly named Complex: retain independent config identities for
            // every normal, fixed and adaptive trailing leg, while each set
            // uses its selected 5m/15m/30m coordination combination.
            plans.push({
              strategyType: "combination",
              signalDirection: direction,
              tpRange: takeProfitRange,
              slRatios,
              trailOptions: trailingEnabled
                ? [noTrailingOption, ...fixedTrailOptions, ...autoTrailOptions]
                : [noTrailingOption],
            })
          }
          if (strategyTypes.includes("inverse")) {
            plans.push({
              strategyType: "inverse",
              signalDirection: direction === "long" ? "short" : "long",
              tpRange: takeProfitRange,
              slRatios: inverseSlRatios,
              // Inverse orders have both non-trailing and independently
              // trailed variants. With trailing disabled the normal leg still
              // evaluates; it never silently disappears from the matrix.
              trailOptions: trailingEnabled
                ? [noTrailingOption, ...fixedTrailOptions]
                : [noTrailingOption],
            })
          }
          if (strategyTypes.includes("high_protection")) {
            // Extended TP/SL triggers form their own lineage. Their SL is
            // locked to 75% of TP and is never merged with the normal grid.
            plans.push({
              strategyType: "high_protection",
              signalDirection: direction,
              tpRange: takeProfitRange,
              slRatios: [0.75],
              trailOptions: trailingEnabled
                ? [noTrailingOption, ...autoTrailOptions]
                : [noTrailingOption],
            })
          }
          if (strategyTypes.includes("dca")) {
            // The optimized DCA lineage has one hard protection value derived
            // from its final adverse step plus a 0.35% safety distance. The
            // evaluator applies that exact floor to every selected TP target.
            plans.push({
              strategyType: "dca",
              signalDirection: direction,
              tpRange: takeProfitRange,
              slRatios: [1],
              trailOptions: [noTrailingOption],
            })
          }
              for (const plan of plans) {
                const evaluated = evaluateDirectTradeSets({
                  symbol,
                  direction,
                  signalDirection: plan.signalDirection,
                  strategyType: plan.strategyType,
                  candlesByTimeframe,
                  timeframeSet,
                  historyHours,
                  volumeRatio: blockVolumeRatio,
                  blockVolumeRatio,
                  tpRange: plan.tpRange,
                  takeProfitPositionCostRatios,
                  trailingMinTakeProfitRatio,
                  slRatios: plan.slRatios,
                  trailOptions: plan.trailOptions,
                  entryTactics,
                  exitTactics,
                  entryTiming,
                  activityVolumeRatio,
                  maxHoldMinutes,
                  positionCostPercent,
                  blockRange,
                  blockProfitFactorRatio,
                  dcaProfile,
                  minProfitFactor,
                  minRecentProfitFactor,
                  recentPositionWindow: recentEvaluationPositions,
                  minRecentPositions: recentEvaluationPositions,
                  maxDrawdownTimeMin,
                })
                symbolEvaluated += evaluated.length
                await appendEvaluatedConfigs(evaluated)
              }
            }
          }
        }
      } finally {
        completedSymbols++
        evaluatedSets += symbolEvaluated
        await client.set(keys.calculationProgress, JSON.stringify({
          status: "running",
          startedAt: calculationStartedAt,
          completedSymbols,
          totalSymbols: symbols.length,
          evaluatedSets,
        }))
      }
      return undefined
    })
    // Only compact integer references are sorted. Rich evaluation rows remain
    // streamed to their immutable chunks, while every active execution slice
    // begins with the highest independently validated score.
    executionCandidates.sort((left, right) => right.score - left.score || left.index - right.index)
    const executionIndexes = executionCandidates.map((candidate) => candidate.index)
    const executionSignalIndex: Record<string, number[]> = {}
    for (const candidate of executionCandidates) {
      if (!candidate.signalKey) continue
      ;(executionSignalIndex[candidate.signalKey] ||= []).push(candidate.index)
    }
    const summary = summaryAccumulator.finish()
    const statsIndex = statisticsAccumulator.finish()
    if (!calculationLeaseHeld) {
      return NextResponse.json({
        error: "Direct-Trade calculation lease was lost before publishing",
      }, { status: 409 })
    }
    // Write chunks before publication. The manifest becomes current only in
    // this transaction, so readers see either the prior complete generation
    // or the new complete generation – never an in-between grid.
    const preparedConfigStore = await configStoreWriter.finish()
    const transaction = client.multi()
    if (preparedConfigStore.manifest) {
      transaction.set(keys.configManifest, JSON.stringify(preparedConfigStore.manifest))
      transaction.del(keys.configs)
    } else {
      transaction.set(keys.configs, preparedConfigStore.legacyJson || "[]")
      transaction.del(keys.configManifest)
    }
    transaction.set(keys.executionIndex, JSON.stringify(executionIndexes))
    transaction.set(keys.executionSignalIndex, JSON.stringify(executionSignalIndex))
    // A previous pulse describes the old generation. Do not let a worker pair
    // it with this freshly published grid: the next pulse builds a matching
    // causal selection before any eligible config is processed.
    transaction.del(keys.activeSignals)
    transaction.set(keys.calculation, JSON.stringify(summary))
    transaction.set(keys.statisticsIndex, JSON.stringify(statsIndex))
    transaction.set(keys.calculationProgress, JSON.stringify({
      status: "ready",
      startedAt: calculationStartedAt,
      completedAt: summary.calculatedAt,
      completedSymbols: symbols.length,
      totalSymbols: symbols.length,
      evaluatedSets: summary.evaluatedSets,
    }))
    await transaction.exec()
    // Old generations are no longer reachable once the manifest transaction
    // has committed. Cleanup is batched and cannot affect the current keys.
    if (preparedConfigStore.previousManifest) {
      void deleteDirectTradeConfigGeneration(client, preparedConfigStore.previousManifest, connectionId)
    }

    // The processor receives only eligible execution candidates. The complete
    // independent result grid remains in Redis for audit/statistics, avoiding
    // a very large response that could stall the production event loop.
    return NextResponse.json({
      success: true,
      connectionId,
      exchange,
      timestamp: summary.calculatedAt,
      symbols,
      symbolCount: symbols.length,
      configTotal: summary.evaluatedSets,
      executionConfigTotal: executionIndexes.length,
      configStorage: preparedConfigStore.manifest
        ? { mode: "chunked", chunks: preparedConfigStore.manifest.chunks }
        : { mode: "legacy", chunks: 0 },
      summary,
    })
  } catch (error) {
    console.error("[Direct-Trade] Calculate error:", error)
    if (calculationLease?.client) {
      await calculationLease.client.set(directTradeKeyspace(calculationConnectionId).calculationProgress, JSON.stringify({
        status: "error",
        completedSymbols: 0,
        totalSymbols: 0,
        evaluatedSets: 0,
        error: error instanceof Error ? error.message : String(error),
        failedAt: new Date().toISOString(),
      })).catch(() => undefined)
    }
    return NextResponse.json({ error: "Calculation failed", details: String(error) }, { status: 500 })
  } finally {
    if (leaseRenewalTimer) clearInterval(leaseRenewalTimer)
    if (calculationLease) {
      await releaseOwnedRedisLock(
        calculationLease.client,
        directTradeKeyspace(calculationConnectionId).calculationLease,
        calculationLease.token,
      ).catch(() => undefined)
    }
  }
}
