#!/usr/bin/env node
/*
 * Deterministic max-symbol Direct-Trade evaluator load and reporting test.
 *
 * It uses a configurable synthetic 1m market path (48h by default), then evaluates the complete
 * 5m/15m/30m combination matrix and every default-enabled Direct-Trade
 * strategy lineage for every requested symbol. No network, Redis,
 * credentials, or order endpoint is touched.
 */
const {
  buildTimeframeCombinations,
  buildDirectTradeTakeProfitPositionCostRatios,
  directTradeTakeProfitPercent,
  evaluateDirectTradeSets,
  resampleCandles,
  DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT,
} = require("../lib/direct-trade-coordination.ts")
const {
  DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS,
} = require("../lib/direct-trade-position-capacity.cjs")

const symbolCount = Math.max(1, Math.floor(Number(process.env.DIRECT_TRADE_MATRIX_SYMBOLS) || 32))
const startSymbolIndex = Math.max(0, Math.floor(Number(process.env.DIRECT_TRADE_MATRIX_START_SYMBOL) || 0))
const historyHours = Math.max(1, Math.floor(Number(process.env.DIRECT_TRADE_MATRIX_HOURS) || 48))
const minProfitFactor = Math.max(
  0.8,
  Number(process.env.DIRECT_TRADE_MATRIX_MIN_PF) || DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT,
)
const minRecentProfitFactor = Math.max(0.8, Number(process.env.DIRECT_TRADE_MATRIX_MIN_RECENT_PF) || 25)
const recentEvaluationPositions = Math.max(3, Math.floor(Number(process.env.DIRECT_TRADE_MATRIX_RECENT_POSITIONS) || 12))
const positionCostPercent = Math.max(0.02, Math.min(1, Number(process.env.DIRECT_TRADE_MATRIX_POSITION_COST_PERCENT) || 0.1))
const calibrationRecentPfThresholds = [...new Set(
  String(process.env.DIRECT_TRADE_MATRIX_RECENT_PF_THRESHOLDS || "10,12,15,20,25,30,40,50")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0.8),
)].sort((left, right) => left - right)
// Paper-test-only capacity: this does not change the engine's configured
// production limits or create orders. It models best-first selection across
// otherwise independent, valid historical candidates.
const maxSimulatedPositions = Math.max(
  1,
  Math.floor(Number(process.env.DIRECT_TRADE_MATRIX_MAX_POSITIONS) || DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS),
)
const maxPositionsPerSymbol = Math.max(1, Math.floor(Number(process.env.DIRECT_TRADE_MATRIX_MAX_PER_SYMBOL) || 12))
const maxPositionsPerDirection = Math.max(1, Math.floor(Number(process.env.DIRECT_TRADE_MATRIX_MAX_PER_DIRECTION) || 6))
const progressEnabled = process.env.DIRECT_TRADE_MATRIX_PROGRESS === "1"
const reportFile = String(process.env.DIRECT_TRADE_MATRIX_REPORT_FILE || "").trim()
const summaryOnly = process.env.DIRECT_TRADE_MATRIX_SUMMARY_ONLY === "1"

function minuteSeries(symbolIndex) {
  return Array.from({ length: historyHours * 60 }, (_, index) => {
    const close = 100
      + Math.sin((index + symbolIndex * 31) / (13 + symbolIndex % 7)) * (1.4 + (symbolIndex % 5) * 0.23)
      + Math.cos((index + symbolIndex * 11) / (41 + symbolIndex % 9)) * 0.8
      + index * (0.0012 + (symbolIndex % 4) * 0.00035)
    return {
      time: index * 60_000,
      open: close - 0.03,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 100 + ((index * (symbolIndex + 3)) % 29),
    }
  })
}
const start = Date.now()
let evaluatedSets = 0
let validSets = 0
const recentPfCalibration = Object.fromEntries(calibrationRecentPfThresholds.map((threshold) => [threshold, 0]))
const byStrategyType = Object.create(null)
const bySymbol = []
const bestFirstCandidatesByLane = new Map()

function createMetrics() {
  return {
    evaluated: 0,
    valid: 0,
    finitePfTotal: 0,
    finitePfCount: 0,
    infinitePfCount: 0,
    ddtTotal: 0,
    pnlTotal: 0,
    recentFinitePfTotal: 0,
    recentFinitePfCount: 0,
    recentInfinitePfCount: 0,
      recentPfBands: {
      insufficient: 0,
      below_0_8: 0,
      from_0_8_to_1: 0,
      from_1_to_1_5: 0,
      from_1_5_to_2: 0,
      at_least_2: 0,
        infinite: 0,
      },
      deactivationReasons: {},
  }
}

function recordRecentPf(metrics, set) {
  if (set.recentPositionCount < recentEvaluationPositions) {
    metrics.recentPfBands.insufficient++
    return
  }
  if (set.recentProfitFactorInfinite) {
    metrics.recentInfinitePfCount++
    metrics.recentPfBands.infinite++
    return
  }
  const pf = Number(set.recentProfitFactor)
  if (!Number.isFinite(pf)) {
    metrics.recentPfBands.insufficient++
    return
  }
  metrics.recentFinitePfCount++
  metrics.recentFinitePfTotal += pf
  if (pf < 0.8) metrics.recentPfBands.below_0_8++
  else if (pf < 1) metrics.recentPfBands.from_0_8_to_1++
  else if (pf < 1.5) metrics.recentPfBands.from_1_to_1_5++
  else if (pf < 2) metrics.recentPfBands.from_1_5_to_2++
  else metrics.recentPfBands.at_least_2++
}

function candidateCompare(left, right) {
  if (left.score !== right.score) return left.score - right.score
  return left.setKey.localeCompare(right.setKey)
}

// A min-heap holds only the requested best-first paper candidates, so the
// load test does not retain a multi-million-row config grid merely to report
// the calibrated active-position capacity check.
function addBestFirstCandidate(candidate) {
  // Retain only the candidates that can possibly survive the exact worker
  // caps. Keeping the best `maxPositionsPerDirection` candidates per
  // symbol+direction is sufficient because a symbol can never admit more
  // than that lane's limit; the later global selection enforces the combined
  // per-symbol and global limits in score order.
  const laneKey = `${candidate.symbol}|${candidate.direction}`
  const lane = bestFirstCandidatesByLane.get(laneKey) || []
  lane.push(candidate)
  lane.sort((left, right) => candidateCompare(right, left))
  if (lane.length > maxPositionsPerDirection) lane.length = maxPositionsPerDirection
  bestFirstCandidatesByLane.set(laneKey, lane)
}

const fixedTrailOptions = [
  { trailing: true, trailStart: 0.3, trailStop: 0.2, mode: "fixed" },
  { trailing: true, trailStart: 0.5, trailStop: 0.3, mode: "fixed" },
  { trailing: true, trailStart: 1, trailStop: 0.5, mode: "fixed" },
]
const autoTrailOptions = [0.75, 1, 1.25].map((autoTrailSensitivity) => ({
  trailing: true,
  trailStart: 0.5,
  trailStop: 0.3,
  mode: "auto",
  autoTrailSensitivity,
}))
const noTrailingOption = { trailing: false, trailStart: 0, trailStop: 0, mode: "none" }
const takeProfitPositionCostRatios = buildDirectTradeTakeProfitPositionCostRatios([4, 8], 2)
const takeProfitRange = takeProfitPositionCostRatios.map((ratio) =>
  directTradeTakeProfitPercent(positionCostPercent, ratio),
)

for (let localSymbolIndex = 0; localSymbolIndex < symbolCount; localSymbolIndex++) {
  const symbolIndex = startSymbolIndex + localSymbolIndex
  // Validate identity within one symbol and release it at the boundary. A
  // global Set of the full matrix made the harness retain millions of long
  // strings and obscured the runtime's actual memory behaviour.
  const symbolUniqueKeys = new Set()
  let symbolEvaluatedSets = 0
  const minuteCandles = minuteSeries(symbolIndex)
  const candlesByTimeframe = {
    "5m": resampleCandles(minuteCandles, 5),
    "15m": resampleCandles(minuteCandles, 15),
    "30m": resampleCandles(minuteCandles, 30),
  }
  const symbolMetrics = Object.create(null)
  for (const timeframeSet of buildTimeframeCombinations(["5m", "15m", "30m"])) {
    for (const direction of ["long", "short"]) {
      const plans = [
        { strategyType: "standard", signalDirection: direction, tpRange: takeProfitRange, slRatios: [0.25, 0.5, 0.75], trailOptions: [noTrailingOption] },
        { strategyType: "trailing_fixed", signalDirection: direction, tpRange: takeProfitRange, slRatios: [0.25, 0.5, 0.75], trailOptions: fixedTrailOptions },
        { strategyType: "trailing_auto", signalDirection: direction, tpRange: takeProfitRange, slRatios: [0.25, 0.5, 0.75], trailOptions: autoTrailOptions },
        { strategyType: "combination", signalDirection: direction, tpRange: takeProfitRange, slRatios: [0.25, 0.5, 0.75], trailOptions: [noTrailingOption, ...fixedTrailOptions, ...autoTrailOptions] },
        { strategyType: "inverse", signalDirection: direction === "long" ? "short" : "long", tpRange: takeProfitRange, slRatios: [0.25, 0.5, 0.75, 1, 1.25], trailOptions: [noTrailingOption, ...fixedTrailOptions] },
        { strategyType: "high_protection", signalDirection: direction, tpRange: takeProfitRange, slRatios: [0.75], trailOptions: [noTrailingOption, ...autoTrailOptions] },
        { strategyType: "dca", signalDirection: direction, tpRange: takeProfitRange, slRatios: [1], trailOptions: [noTrailingOption] },
      ]
      for (const plan of plans) {
        const sets = evaluateDirectTradeSets({
          symbol: `LOAD${symbolIndex}USDT`,
          direction,
          signalDirection: plan.signalDirection,
          strategyType: plan.strategyType,
          candlesByTimeframe,
          timeframeSet,
          historyHours,
          volumeRatio: 0.1,
          tpRange: plan.tpRange,
          takeProfitPositionCostRatios,
          slRatios: plan.slRatios,
          trailOptions: plan.trailOptions,
          entryTactics: ["momentum", "mean_reversion", "breakout", "relative"],
          exitTactics: ["bracket", "momentum_reversal", "relative", "time"],
          entryTiming: "current",
          activityVolumeRatio: 1,
          maxHoldMinutes: 120,
          positionCostPercent,
          blockRange: [1, 12],
          minProfitFactor,
          minRecentProfitFactor,
          recentPositionWindow: recentEvaluationPositions,
          minRecentPositions: recentEvaluationPositions,
          maxDrawdownTimeMin: 10,
        })
        evaluatedSets += sets.length
        symbolEvaluatedSets += sets.length
        validSets += sets.filter((set) => set.valid).length
        const allTypeMetrics = byStrategyType[plan.strategyType] || (byStrategyType[plan.strategyType] = createMetrics())
        const symbolTypeMetrics = symbolMetrics[plan.strategyType] || (symbolMetrics[plan.strategyType] = createMetrics())
        for (const set of sets) {
          // Re-evaluate only the final finite recent-PF gate against each
          // threshold. This keeps a single full matrix run sufficient to
          // calibrate the default without retaining the complete grid.
          const hasFiniteRecentPf = set.recentPositionCount >= recentEvaluationPositions
            && set.recentProfitFactor != null
            && !set.recentProfitFactorInfinite
          const passesOtherEligibility = set.totalTrades >= 3
            && (set.profitFactorInfinite || (set.profitFactor ?? 0) >= minProfitFactor)
            && set.winRate >= 0.4
            && set.maxDrawdownTimeMin <= 10
          if (hasFiniteRecentPf && passesOtherEligibility) {
            for (const threshold of calibrationRecentPfThresholds) {
              if (set.recentProfitFactor >= threshold) recentPfCalibration[threshold]++
            }
          }
          for (const metrics of [allTypeMetrics, symbolTypeMetrics]) {
            metrics.evaluated++
            if (set.valid) metrics.valid++
            else metrics.deactivationReasons[set.deactivationReason || "unknown"] = (metrics.deactivationReasons[set.deactivationReason || "unknown"] || 0) + 1
            metrics.ddtTotal += set.avgDrawdownTimeMin
            metrics.pnlTotal += set.totalPnl
            if (set.profitFactorInfinite) metrics.infinitePfCount++
            else if (typeof set.profitFactor === "number") {
              metrics.finitePfCount++
              metrics.finitePfTotal += set.profitFactor
            }
            recordRecentPf(metrics, set)
          }
          if (set.valid) {
            addBestFirstCandidate({
              symbol: set.symbol,
              direction: set.direction,
              strategyType: set.strategyType,
              setKey: set.setKey,
              score: set.score,
              historicalOrders: set.totalTrades,
              profitFactor: set.profitFactor,
              profitFactorInfinite: set.profitFactorInfinite,
              avgDrawdownTimeMin: set.avgDrawdownTimeMin,
              recentPositionCount: set.recentPositionCount,
              recentProfitFactor: set.recentProfitFactor,
              recentProfitFactorInfinite: set.recentProfitFactorInfinite,
              recentAvgDrawdownTimeMin: set.recentAvgDrawdownTimeMin,
            })
          }
        }
        for (const set of sets) symbolUniqueKeys.add(set.setKey)
      }
    }
  }
  if (symbolUniqueKeys.size !== symbolEvaluatedSets) {
    throw new Error(`Independent set integrity failed for LOAD${symbolIndex}USDT: ${symbolUniqueKeys.size}/${symbolEvaluatedSets} unique keys`)
  }
  symbolUniqueKeys.clear()
  bySymbol.push({ symbol: `LOAD${symbolIndex}USDT`, metrics: symbolMetrics })
  // The max-symbol debug matrix intentionally exercises a very large amount
  // of short-lived Set data. Yield an observable progress checkpoint and, when
  // explicitly enabled by the harness, collect it at a symbol boundary so the
  // load test measures engine work rather than delayed V8 reclamation.
  if (typeof global.gc === "function") global.gc()
  if (progressEnabled) {
    console.error(JSON.stringify({
      test: "direct-trade-matrix-progress",
      completedSymbols: localSymbolIndex + 1,
      totalSymbols: symbolCount,
      evaluatedSets,
      validSets,
      elapsedMs: Date.now() - start,
      heapMiB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    }))
  }
}

if (evaluatedSets === 0) throw new Error("Independent set integrity failed: no sets were evaluated")

function compactMetrics(metrics) {
  return {
    evaluated: metrics.evaluated,
    valid: metrics.valid,
    meanFinitePF: metrics.finitePfCount > 0 ? Number((metrics.finitePfTotal / metrics.finitePfCount).toFixed(3)) : null,
    infinitePF: metrics.infinitePfCount,
    recentPositionPF: {
      meanFinite: metrics.recentFinitePfCount > 0 ? Number((metrics.recentFinitePfTotal / metrics.recentFinitePfCount).toFixed(3)) : null,
      infinite: metrics.recentInfinitePfCount,
      bands: metrics.recentPfBands,
    },
    deactivationReasons: metrics.deactivationReasons,
    meanDDTMinutes: metrics.evaluated > 0 ? Number((metrics.ddtTotal / metrics.evaluated).toFixed(3)) : 0,
    totalSimulatedPnl: Number(metrics.pnlTotal.toFixed(3)),
  }
}

const strategyReport = Object.fromEntries(Object.entries(byStrategyType).map(([type, metrics]) => [type, compactMetrics(metrics)]))
const sampleIndices = [...new Set([0, Math.floor(symbolCount / 3), Math.floor(symbolCount * 2 / 3), symbolCount - 1])]
const symbolReport = sampleIndices.map((index) => ({
  symbol: bySymbol[index].symbol,
  strategyTypes: Object.fromEntries(Object.entries(bySymbol[index].metrics).map(([type, metrics]) => [type, compactMetrics(metrics)])),
}))

const bestFirstPaperCandidates = [...bestFirstCandidatesByLane.values()]
  .flat()
  .sort((left, right) => candidateCompare(right, left))
const selectedPerSymbol = new Map()
const selectedPerLane = new Map()
const bestFirstPositions = []
for (const candidate of bestFirstPaperCandidates) {
  if (bestFirstPositions.length >= maxSimulatedPositions) break
  const laneKey = `${candidate.symbol}|${candidate.direction}`
  const symbolCount = selectedPerSymbol.get(candidate.symbol) || 0
  const directionCount = selectedPerLane.get(laneKey) || 0
  if (symbolCount >= maxPositionsPerSymbol || directionCount >= maxPositionsPerDirection) continue
  bestFirstPositions.push(candidate)
  selectedPerSymbol.set(candidate.symbol, symbolCount + 1)
  selectedPerLane.set(laneKey, directionCount + 1)
}
const positionReport = {
  requestedMax: maxSimulatedPositions,
  maxPositionsPerSymbol,
  maxPositionsPerDirection,
  effectiveCapacity: Math.min(maxSimulatedPositions, symbolCount * maxPositionsPerSymbol),
  selected: bestFirstPositions.length,
  byDirection: {},
  bySymbol: {},
}
for (const position of bestFirstPositions) {
  const direction = positionReport.byDirection[position.direction] || (positionReport.byDirection[position.direction] = {
    positions: 0,
    historicalOrders: 0,
    finitePF: 0,
    finitePFCount: 0,
    infinitePF: 0,
    totalDDTMinutes: 0,
    recentFinitePF: 0,
    recentFinitePFCount: 0,
    recentInfinitePF: 0,
  })
  const symbol = positionReport.bySymbol[position.symbol] || (positionReport.bySymbol[position.symbol] = {
    longPositions: 0,
    shortPositions: 0,
    historicalOrders: 0,
  })
  direction.positions++
  direction.historicalOrders += position.historicalOrders
  direction.totalDDTMinutes += position.avgDrawdownTimeMin
  if (position.profitFactorInfinite) direction.infinitePF++
  else if (typeof position.profitFactor === "number") {
    direction.finitePF += position.profitFactor
    direction.finitePFCount++
  }
  if (position.recentPositionCount >= recentEvaluationPositions) {
    if (position.recentProfitFactorInfinite) direction.recentInfinitePF++
    else if (typeof position.recentProfitFactor === "number") {
      direction.recentFinitePF += position.recentProfitFactor
      direction.recentFinitePFCount++
    }
  }
  if (position.direction === "long") symbol.longPositions++
  else symbol.shortPositions++
  symbol.historicalOrders += position.historicalOrders
}
for (const direction of Object.values(positionReport.byDirection)) {
  direction.averageHistoricalOrdersPerPosition = Number((direction.historicalOrders / direction.positions).toFixed(3))
  direction.meanFinitePF = direction.finitePFCount > 0 ? Number((direction.finitePF / direction.finitePFCount).toFixed(3)) : null
  direction.recentPositionPF = {
    meanFinite: direction.recentFinitePFCount > 0 ? Number((direction.recentFinitePF / direction.recentFinitePFCount).toFixed(3)) : null,
    infinite: direction.recentInfinitePF,
  }
  direction.meanDDTMinutes = Number((direction.totalDDTMinutes / direction.positions).toFixed(3))
  delete direction.finitePF
  delete direction.finitePFCount
  delete direction.totalDDTMinutes
  delete direction.recentFinitePF
  delete direction.recentFinitePFCount
  delete direction.recentInfinitePF
}

const report = {
  test: "direct-trade-matrix",
  symbols: symbolCount,
  startSymbolIndex,
  endSymbolIndex: startSymbolIndex + symbolCount - 1,
  historicHours: historyHours,
  historicalPFMinimum: minProfitFactor,
  recentPositionPFMinimum: minRecentProfitFactor,
  recentEvaluationPositions,
  positionCostPercent,
  takeProfitRatioRange: [4, 8],
  takeProfitRatioStep: 2,
  takeProfitPositionCostRatios,
  evaluatedSets,
  validSets,
  validRatePercent: Number(((validSets / evaluatedSets) * 100).toFixed(3)),
  recentPfCalibration: Object.fromEntries(calibrationRecentPfThresholds.map((threshold) => [threshold, {
    validSets: recentPfCalibration[threshold],
    validRatePercent: Number(((recentPfCalibration[threshold] / evaluatedSets) * 100).toFixed(3)),
  }])),
  byStrategyType: strategyReport,
  sampleSymbols: symbolReport,
  bestFirstPaperPositions: positionReport,
  // Keep only lane-capped candidates in the machine-readable debug report so
  // split high-load runs can compute the exact global worker-cap selection.
  bestFirstPaperCandidates,
  // The default 32-symbol 90-hour grid remains bounded even when a user
  // selects every strategy/type: the range is precise, while only the four
  // 4-step Set values are materialised by default.
  projectedDefault32SymbolSets: Math.round((evaluatedSets / symbolCount) * 32),
  elapsedMs: Date.now() - start,
  heapMiB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
}
const serializedReport = JSON.stringify(report)
if (reportFile) require("node:fs").writeFileSync(reportFile, `${serializedReport}\n`, "utf8")
console.log(summaryOnly ? JSON.stringify({
  test: report.test,
  symbols: report.symbols,
  historicHours: report.historicHours,
  evaluatedSets: report.evaluatedSets,
  validSets: report.validSets,
  elapsedMs: report.elapsedMs,
  heapMiB: report.heapMiB,
}) : serializedReport)
