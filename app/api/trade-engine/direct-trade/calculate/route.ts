import { type NextRequest, NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { clampDirectTradeSymbolCount } from "@/lib/direct-trade-limits"
import { fetchTopSymbols, type SortKey } from "@/lib/top-symbols"
import {
  DIRECT_TRADE_CONFIGS_KEY,
  DIRECT_TRADE_CONFIG_MANIFEST_KEY,
  DIRECT_TRADE_ACTIVE_SIGNAL_KEYS_KEY,
  DIRECT_TRADE_EXECUTION_INDEX_KEY,
  DIRECT_TRADE_EXECUTION_SIGNAL_INDEX_KEY,
  deleteDirectTradeConfigGeneration,
  createDirectTradeConfigStoreWriter,
} from "@/lib/direct-trade-config-store"
import { fetchBingXMinuteHistory } from "@/lib/direct-trade-market-history"
import { normalizePositionCostPercent, POSITION_COST_PERCENT_DEFAULT } from "@/lib/position-cost"
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
  normaliseDirectTradeTakeProfitRatioRange,
  normaliseDirectTradeTakeProfitRatioStep,
  DIRECT_TRADE_RECENT_PF_DEFAULT,
  type DirectTradeEntryTiming,
  type DirectTradeStrategyType,
  type DirectTradeTrailOption,
} from "@/lib/direct-trade-coordination"

export const dynamic = "force-dynamic"
// A 32-symbol, 60-hour public-history refresh is a real full-grid operation.
// Give long-lived/compatible deployment runtimes enough wall time to page the
// exchange without silently truncating the requested independent evaluation.
export const maxDuration = 300

const DIRECT_TRADE_CALCULATION_KEY = "direct_trade:calculation"
const DIRECT_TRADE_CALCULATION_PROGRESS_KEY = "direct_trade:calculation-progress"
const DIRECT_TRADE_STATISTICS_INDEX_KEY = "direct_trade:statistics-index"
const DIRECT_TRADE_CALCULATION_LEASE_KEY = "direct_trade:calculation:lease"
const DIRECT_TRADE_CALCULATION_LEASE_SECONDS = 330
const DIRECT_STOP_LOSS_RATIO_MIN = 0.25
const DIRECT_STOP_LOSS_RATIO_MAX = 0.75
const DIRECT_INVERSE_STOP_LOSS_RATIO_MAX = 1.25
const DIRECT_STOP_LOSS_RATIO_STEP = 0.25

interface CalculationRequest {
  symbolCount?: number
  symbolOrder?: SortKey
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
  entryTactics?: string[]
  exitTactics?: string[]
  entryTiming?: DirectTradeEntryTiming
  activityVolumeRatio?: number
  maxHoldMinutes?: number
  positionCostPercent?: number
  takeProfitRatioRange?: [number, number]
  takeProfitRatioStep?: number
  blockVolumeRatio?: number
  blockProfitFactorRatio?: number
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
  const step = Math.max(DIRECT_STOP_LOSS_RATIO_STEP, Math.min(0.75, requestedStep))
  for (let ratio = DIRECT_STOP_LOSS_RATIO_MIN; ratio <= safeMaximum + 0.00001; ratio += step) {
    ratios.push(Number(Math.min(ratio, safeMaximum).toFixed(2)))
  }
  // A reduced grid must still test the configured maximum protection value.
  if (ratios.at(-1) !== Number(safeMaximum.toFixed(2))) ratios.push(Number(safeMaximum.toFixed(2)))
  return ratios
}

type EvaluatedDirectTradeConfig = Awaited<ReturnType<typeof evaluateDirectTradeSets>>[number]

function createCalculationSummaryAccumulator(details: {
  symbols: string[]
  historyHours: number
  timeframes: string[]
  combinations: number
  entryTactics: string[]
  exitTactics: string[]
  strategyTypes: DirectTradeStrategyType[]
  entryTiming: DirectTradeEntryTiming
  minRecentProfitFactor: number
  recentEvaluationPositions: number
  positionCostPercent: number
  takeProfitRatioRange: [number, number]
  takeProfitRatioStep: number
  takeProfitPositionCostRatios: number[]
  activityVolumeRatio: number
  maxHoldMinutes: number
  blockRange: [number, number]
  blockVolumeRatio: number
  blockProfitFactorRatio: number
}) {
  const countBy = <T extends string>(entries: T[]): Record<T, { evaluated: number; valid: number }> => {
    const output = {} as Record<T, { evaluated: number; valid: number }>
    for (const entry of entries) output[entry] = { evaluated: 0, valid: 0 }
    return output
  }
  const byTimeframe: Record<string, { evaluated: number; valid: number }> = {}
  const byEntryTactic = countBy(details.entryTactics)
  const byExitTactic = countBy(details.exitTactics)
  const byStrategyType = countBy(details.strategyTypes)
  let evaluatedSets = 0
  let validSets = 0
  let totalScore = 0
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
  }> = {}
  const append = (config: EvaluatedDirectTradeConfig) => {
    const timeframe = byTimeframe[config.timeframe] || (byTimeframe[config.timeframe] = { evaluated: 0, valid: 0 })
    evaluatedSets++
    totalScore += config.score
    timeframe.evaluated++
    if (config.valid) {
      validSets++
      timeframe.valid++
    }
    byEntryTactic[config.entryTactic].evaluated++
    if (config.valid) byEntryTactic[config.entryTactic].valid++
    byExitTactic[config.exitTactic].evaluated++
    if (config.valid) byExitTactic[config.exitTactic].valid++
    byStrategyType[config.strategyType].evaluated++
    if (config.valid) byStrategyType[config.strategyType].valid++
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
      blockEnabled: details.blockRange[1] > 0,
      blockEvaluatedSets,
      blockValidSets,
      blockDeactivatedSets: blockEvaluatedSets - blockValidSets,
      byBlockCount: Object.fromEntries(Object.entries(byBlockCount).map(([blockCount, value]) => [blockCount, {
        ...value,
        meanObservedPF: value.observedPfCount > 0 ? value.observedPfSum / value.observedPfCount : null,
        meanMinimumPF: value.evaluated > 0 ? value.minimumPfSum / value.evaluated : 0,
        meanProfitFactorDifference: value.evaluated > 0 ? value.differenceSum / value.evaluated : 0,
        meanProfitFactorToMinimumDifference: value.evaluated > 0 ? value.marginSum / value.evaluated : 0,
      }])),
      avgScore: evaluatedSets > 0 ? totalScore / evaluatedSets : 0,
      byTimeframe,
      byEntryTactic,
      byExitTactic,
      byStrategyType,
    }),
  }
}

type StatisticsRow = Pick<EvaluatedDirectTradeConfig,
  "setKey" | "symbol" | "direction" | "signalDirection" | "strategyType" | "timeframe" | "entryTactic" | "exitTactic" |
  "valid" | "deactivationReason" | "profitFactor" | "profitFactorInfinite" | "winRate" |
  "totalTrades" | "maxDrawdownTimeMin" | "score" | "totalPnl" | "bestMarketExitPnl" | "positionCostPercent" |
  "lastPositionPnl" | "lastPositionBestMarketExitPnl" | "lastPositionDrawdownTimeMin" | "lastPositionExitReason" |
  "recentPositionCount" | "recentProfitFactor" | "recentProfitFactorInfinite" | "recentWinRate" |
  "recentTotalPnl" | "recentAvgDrawdownTimeMin" | "blockCount" | "blockProfitFactorRatio" |
  "blockValid" | "blockDeactivationReason" | "blockObservedProfitFactor" |
  "blockObservedProfitFactorInfinite" | "blockNormalProfitFactor" | "blockMinimumProfitFactor" |
  "blockConfiguredMinimumProfitFactor" | "blockProfitFactorDifference" | "blockComparisonAvailable" |
  "blockProfitFactorToMinimumDifference" |
  "blockProfitFactorWindow" | "blockProfitFactorSampleCount" | "blockAvgDrawdownTimeMin" |
  "blockMaxDrawdownTimeMin" | "blockTotalPnl" | "blockVolumeIncrementRatio" |
  "blockCalculatedVolumeMultiplier"
>

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
  const append = (config: StatisticsRow) => {
    const state = config.valid ? "valid" : "inactive"
    for (const timeframe of ["all", config.timeframe]) {
      for (const direction of ["all", config.direction]) {
        for (const activityState of ["all", state]) {
          for (const strategyType of ["all", config.strategyType]) {
            const key = statisticsFilterKey(timeframe, direction, activityState, strategyType)
            totals[key] = (totals[key] || 0) + 1
            const rows = topRows[key] || (topRows[key] = [])
            insertTopRow(rows, config)
          }
        }
      }
    }
  }
  return {
    append,
    finish: () => ({
      version: new Date().toISOString(),
      totals,
      topRows,
    }),
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
  try {
    const body: CalculationRequest = await request.json().catch(() => ({}))
    const symbolCount = clampDirectTradeSymbolCount(body.symbolCount)
    const symbolOrder: SortKey = body.symbolOrder || "volatility_1h"
    // 0.1 is the smallest supported Direct-Trade volume factor. This default
    // intentionally applies to simulation and live execution alike.
    const minVolFactor = Math.max(0.1, numberOr(body.minVolFactor, 0.1))
    const maxSlRatio = numberOr(body.maxSlRatio, DIRECT_STOP_LOSS_RATIO_MAX)
    const inverseMaxSlRatio = numberOr(body.inverseMaxSlRatio, DIRECT_INVERSE_STOP_LOSS_RATIO_MAX)
    const slRatioStep = Math.max(DIRECT_STOP_LOSS_RATIO_STEP, Math.min(0.75, numberOr(body.slRatioStep, DIRECT_STOP_LOSS_RATIO_STEP)))
    const timeframes = normaliseDirectTradeTimeframes(body.timeframes)
    const timeframeSets = buildTimeframeCombinations(timeframes)
    const strategyTypes = normaliseDirectTradeStrategyTypes(body.strategyTypes)
    const blockRange: [number, number] = Array.isArray(body.blockRange) && body.blockRange.length === 2
      ? [Math.max(0, Math.floor(numberOr(body.blockRange[0], 1))), Math.max(0, Math.floor(numberOr(body.blockRange[1], 12)))]
      : [1, 12]
    blockRange.sort((left, right) => left - right)
    const trailingEnabled = body.trailingEnabled !== false
    const minProfitFactor = Math.max(0.8, numberOr(body.minProfitFactor, 0.8))
    // A 12-position recent window avoids accepting a historical PF that is
    // already contradicted by the latest closed positions. The shared strict
    // default is checked by the deterministic full-matrix paper test.
    const minRecentProfitFactor = Math.max(0.8, numberOr(body.minRecentProfitFactor, DIRECT_TRADE_RECENT_PF_DEFAULT))
    const recentEvaluationPositions = Math.max(3, Math.floor(numberOr(body.recentEvaluationPositions, 12)))
    const maxDrawdownTimeMin = Math.max(1, numberOr(body.maxDrawdownTimeMin, 10))
    const historyHours = Math.max(1, numberOr(body.historyHours, 48))
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
    const takeProfitRange = takeProfitPositionCostRatios.map((ratio) =>
      directTradeTakeProfitPercent(positionCostPercent, ratio),
    )
    const blockVolumeRatio = Math.max(0.1, Math.min(10, numberOr(body.blockVolumeRatio, 1)))
    const blockProfitFactorRatio = Math.max(0.2, Math.min(5, numberOr(body.blockProfitFactorRatio, 0.8)))

    // A manual dashboard refresh and the long-running processor can arrive at
    // the same time. The complete grid is an atomic snapshot, so only one
    // owner may fetch/evaluate/publish it. Renewing keeps the lock valid for a
    // full maximum-symbol historical pass instead of allowing a second worker
    // to start after a short, stale TTL.
    await initRedis()
    const client = getRedisClient()
    const token = createRedisLockToken("direct-trade-calculation")
    const acquired = await client.set(DIRECT_TRADE_CALCULATION_LEASE_KEY, token, {
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
        DIRECT_TRADE_CALCULATION_LEASE_KEY,
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

    const top = await fetchTopSymbols("bingx", symbolCount, symbolOrder)
    const symbols = top.symbols.slice(0, symbolCount).map((ticker) => ticker.symbol)
    if (symbols.length === 0) return NextResponse.json({ error: "No symbols available" }, { status: 400 })
    const calculationStartedAt = new Date().toISOString()
    let completedSymbols = 0
    let evaluatedSets = 0
    // This compact progress record is the only object written during a long
    // calculation. The complete config grid is published atomically at the
    // end, so consumers never deserialize or observe a half-built list.
    await client.set(DIRECT_TRADE_CALCULATION_PROGRESS_KEY, JSON.stringify({
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
      timeframes,
      combinations: timeframeSets.length,
      entryTactics,
      exitTactics,
      strategyTypes,
      entryTiming,
      minRecentProfitFactor,
      recentEvaluationPositions,
      positionCostPercent,
      takeProfitRatioRange: normaliseDirectTradeTakeProfitRatioRange(body.takeProfitRatioRange),
      takeProfitRatioStep: normaliseDirectTradeTakeProfitRatioStep(body.takeProfitRatioStep),
      takeProfitPositionCostRatios,
      activityVolumeRatio,
      maxHoldMinutes,
      blockRange,
      blockVolumeRatio,
      blockProfitFactorRatio,
    })
    const statisticsAccumulator = createStatisticsIndexAccumulator()
    const configStoreWriter = await createDirectTradeConfigStoreWriter(client)
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
        if (!config.blockEvaluations?.length) return config
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
        const minuteCandles = await fetchBingXMinuteHistory(symbol, historyHours)
        if (minuteCandles.length >= 30) {
          const candlesByTimeframe = {
            "1m": minuteCandles,
            "10m": resampleCandles(minuteCandles, 10),
            "15m": resampleCandles(minuteCandles, 15),
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
            // uses its selected 1m/10m/15m coordination combination.
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
                  tpRange: plan.tpRange,
                  takeProfitPositionCostRatios,
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
        await client.set(DIRECT_TRADE_CALCULATION_PROGRESS_KEY, JSON.stringify({
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
      transaction.set(DIRECT_TRADE_CONFIG_MANIFEST_KEY, JSON.stringify(preparedConfigStore.manifest))
      transaction.del(DIRECT_TRADE_CONFIGS_KEY)
    } else {
      transaction.set(DIRECT_TRADE_CONFIGS_KEY, preparedConfigStore.legacyJson || "[]")
      transaction.del(DIRECT_TRADE_CONFIG_MANIFEST_KEY)
    }
    transaction.set(DIRECT_TRADE_EXECUTION_INDEX_KEY, JSON.stringify(executionIndexes))
    transaction.set(DIRECT_TRADE_EXECUTION_SIGNAL_INDEX_KEY, JSON.stringify(executionSignalIndex))
    // A previous pulse describes the old generation. Do not let a worker pair
    // it with this freshly published grid: the next pulse builds a matching
    // causal selection before any eligible config is processed.
    transaction.del(DIRECT_TRADE_ACTIVE_SIGNAL_KEYS_KEY)
    transaction.set(DIRECT_TRADE_CALCULATION_KEY, JSON.stringify(summary))
    transaction.set(DIRECT_TRADE_STATISTICS_INDEX_KEY, JSON.stringify(statsIndex))
    transaction.set(DIRECT_TRADE_CALCULATION_PROGRESS_KEY, JSON.stringify({
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
      void deleteDirectTradeConfigGeneration(client, preparedConfigStore.previousManifest)
    }

    // The processor receives only eligible execution candidates. The complete
    // independent result grid remains in Redis for audit/statistics, avoiding
    // a very large response that could stall the production event loop.
    return NextResponse.json({
      success: true,
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
      await calculationLease.client.set(DIRECT_TRADE_CALCULATION_PROGRESS_KEY, JSON.stringify({
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
        DIRECT_TRADE_CALCULATION_LEASE_KEY,
        calculationLease.token,
      ).catch(() => undefined)
    }
  }
}
