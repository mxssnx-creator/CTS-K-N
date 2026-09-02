#!/usr/bin/env node
/*
 * Direct-Trade historic Block on/off comparison.
 *
 * This is paper-only and deterministic: it does not use credentials, Redis,
 * exchange endpoints, or order routes. Both blockRange paths are evaluated
 * against the same candles and exact strategy matrix. The Base market PF/DDT
 * remains causal and comparable, while the Block Count 1..N PF floors,
 * eligibility and volume-weighted PnL are reported from their own ledger.
 */
const {
  buildTimeframeCombinations,
  buildDirectTradeTakeProfitPositionCostRatios,
  directTradeTakeProfitPercent,
  evaluateDirectTradeSets,
  resampleCandles,
  DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT,
  DIRECT_TRADE_RECENT_PF_DEFAULT,
} = require("../lib/direct-trade-coordination.ts")
const {
  calculateBlockMinimumProfitFactor,
  calculateBlockVolumeIncrementRatio,
  calculateBlockVolumeMultiplier,
} = require("../lib/block-count-state.ts")

const symbolCount = Math.max(1, Math.floor(Number(process.env.DIRECT_TRADE_BLOCK_SYMBOLS) || 4))
const startSymbolIndex = Math.max(0, Math.floor(Number(process.env.DIRECT_TRADE_BLOCK_START_SYMBOL) || 0))
// Ninety minutes does not contain enough independent 30m signal pulses to
// exercise staged Count lanes and can make every Count PF trivially equal.
// Use the same exact 48-hour horizon as Direct-Trade overview/warmup by
// default; callers may still request a shorter diagnostic explicitly.
const historyMinutes = Math.max(30, Math.floor(Number(process.env.DIRECT_TRADE_BLOCK_HISTORY_MINUTES) || 48 * 60))
const historyHours = historyMinutes / 60
const positionCostPercent = Math.max(0.02, Math.min(1, Number(process.env.DIRECT_TRADE_BLOCK_POSITION_COST_PERCENT) || 0.1))
const blockMinimum = Math.max(1, Math.floor(Number(process.env.DIRECT_TRADE_BLOCK_MIN_COUNT) || 1))
const blockMaximum = Math.max(blockMinimum, Math.min(12, Math.floor(Number(process.env.DIRECT_TRADE_BLOCK_MAX_COUNT) || 12)))
const blockVolumeRatio = Math.max(0.1, Math.min(10, Number(process.env.DIRECT_TRADE_BLOCK_VOLUME_RATIO) || 1))
const blockIncrementSteps = Math.max(1, Math.min(5, Math.floor(Number(process.env.DIRECT_TRADE_BLOCK_INCREMENT_STEPS) || 2)))
const blockProfitFactorRatio = Math.max(0.2, Math.min(5, Number(process.env.DIRECT_TRADE_BLOCK_PF_RATIO) || 1.1))
const minProfitFactor = Math.max(
  0.8,
  Number(process.env.DIRECT_TRADE_BLOCK_MIN_PF) || DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT,
)
// Keep the paper Block comparison on the same PositionCost-relative recent-PF
// coordinate as Direct-Trade itself. The historical `25` fallback was from the
// old percentage-style scale and falsely filtered otherwise eligible sets.
const minRecentProfitFactor = Math.max(
  0.8,
  Number(process.env.DIRECT_TRADE_BLOCK_MIN_RECENT_PF) || DIRECT_TRADE_RECENT_PF_DEFAULT,
)
const recentEvaluationPositions = Math.max(3, Math.floor(Number(process.env.DIRECT_TRADE_BLOCK_RECENT_POSITIONS) || 12))
const maxDrawdownTimeMin = Math.max(1, Number(process.env.DIRECT_TRADE_BLOCK_MAX_DDT_MIN) || 10)
const reportFile = String(process.env.DIRECT_TRADE_BLOCK_REPORT_FILE || "").trim()
const progressEnabled = process.env.DIRECT_TRADE_BLOCK_PROGRESS === "1"

function minuteSeries(symbolIndex) {
  return Array.from({ length: historyMinutes }, (_, index) => {
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

function createMetrics() {
  return {
    evaluated: 0,
    valid: 0,
    finitePfTotal: 0,
    finitePfCount: 0,
    infinitePf: 0,
    averageDdtTotal: 0,
    maximumDdtMin: 0,
    basePnl: 0,
    scaledPnl: 0,
    baseGrossProfit: 0,
    baseGrossLoss: 0,
    selectedBlockGrossProfit: 0,
    selectedBlockGrossLoss: 0,
    selectedBlockPnl: 0,
    selectedBlockCount: 0,
    disabledByReason: {},
    byStrategyType: {},
    byBlockCount: {},
    ddtBuckets: {},
    blockLedger: {
      evaluated: 0,
      valid: 0,
      observedPfTotal: 0,
      observedPfCount: 0,
      infinitePf: 0,
      minimumPfTotal: 0,
      differenceTotal: 0,
      marginTotal: 0,
      totalPnl: 0,
      grossProfit: 0,
      grossLoss: 0,
      byCount: {},
    },
  }
}

function metricFor(metrics, key, factory = createMetrics) {
  return metrics[key] || (metrics[key] = factory())
}

function recordSet(metrics, set, scale) {
  metrics.evaluated++
  if (set.valid) metrics.valid++
  else {
    const reason = set.deactivationReason || "unknown"
    metrics.disabledByReason[reason] = (metrics.disabledByReason[reason] || 0) + 1
  }
  if (set.profitFactorInfinite) metrics.infinitePf++
  else if (Number.isFinite(Number(set.profitFactor))) {
    metrics.finitePfCount++
    metrics.finitePfTotal += Number(set.profitFactor)
  }
  metrics.averageDdtTotal += Number(set.avgDrawdownTimeMin) || 0
  metrics.maximumDdtMin = Math.max(metrics.maximumDdtMin, Number(set.maxDrawdownTimeMin) || 0)
  metrics.basePnl += Number(set.totalPnl) || 0
  metrics.baseGrossProfit += Number(set.netProfit ?? set.grossProfit) || 0
  metrics.baseGrossLoss += Number(set.netLoss ?? set.grossLoss) || 0
  const selected = set.blockCount > 0
    ? (set.blockEvaluations || []).find((block) => block.blockCount === set.blockCount)
    : null
  const realizedPnl = selected ? Number(selected.blockTotalPnl) || 0 : (Number(set.totalPnl) || 0) * scale
  metrics.scaledPnl += realizedPnl
  if (selected) {
    metrics.selectedBlockCount++
    metrics.selectedBlockGrossProfit += Number(selected.blockGrossProfit) || 0
    metrics.selectedBlockGrossLoss += Number(selected.blockGrossLoss) || 0
    metrics.selectedBlockPnl += Number(selected.blockTotalPnl) || 0
  }
  const ddtHours = (Number(set.maxDrawdownTimeMin) || 0) / 60
  const bucket = Math.floor(ddtHours / 4) * 4
  const bucketKey = `${bucket}-${bucket + 4}h`
  const bucketStats = metricFor(metrics.ddtBuckets, bucketKey, () => ({ configs: 0, valid: 0, maxDdtMin: 0, ddtTotal: 0 }))
  bucketStats.configs++
  if (set.valid) bucketStats.valid++
  bucketStats.maxDdtMin = Math.max(bucketStats.maxDdtMin, Number(set.maxDrawdownTimeMin) || 0)
  bucketStats.ddtTotal += Number(set.avgDrawdownTimeMin) || 0
  const typeStats = metricFor(metrics.byStrategyType, set.strategyType)
  typeStats.evaluated = (typeStats.evaluated || 0) + 1
  typeStats.valid = (typeStats.valid || 0) + (set.valid ? 1 : 0)
  typeStats.disabled = (typeStats.disabled || 0) + (set.valid ? 0 : 1)
  const count = Math.max(0, Math.floor(Number(set.blockCount) || 0))
  const countStats = metricFor(metrics.byBlockCount, String(count), () => ({ configs: 0, valid: 0, disabled: 0, maxDdtMin: 0, scaledPnl: 0 }))
  countStats.configs++
  countStats.valid += set.valid ? 1 : 0
  countStats.disabled += set.valid ? 0 : 1
  countStats.maxDdtMin = Math.max(countStats.maxDdtMin, Number(set.maxDrawdownTimeMin) || 0)
  countStats.scaledPnl += realizedPnl
}

function recordBlockLedger(metrics, set) {
  for (const block of set.blockEvaluations || []) {
    const ledger = metrics.blockLedger
    ledger.evaluated++
    if (block.valid) ledger.valid++
    if (block.blockObservedProfitFactorInfinite) ledger.infinitePf++
    else if (Number.isFinite(Number(block.blockObservedProfitFactor))) {
      ledger.observedPfCount++
      ledger.observedPfTotal += Number(block.blockObservedProfitFactor)
    }
    ledger.minimumPfTotal += Number(block.blockMinimumProfitFactor) || 0
    ledger.differenceTotal += Number(block.blockProfitFactorDifference) || 0
    ledger.marginTotal += Number(block.blockProfitFactorToMinimumDifference) || 0
    ledger.totalPnl += Number(block.blockTotalPnl) || 0
    ledger.grossProfit += Number(block.blockNetProfit ?? block.blockGrossProfit) || 0
    ledger.grossLoss += Number(block.blockNetLoss ?? block.blockGrossLoss) || 0
    const count = ledger.byCount[String(block.blockCount)] || (ledger.byCount[String(block.blockCount)] = {
      evaluated: 0,
      valid: 0,
      disabled: 0,
      observedPfTotal: 0,
      observedPfCount: 0,
      infinitePf: 0,
      minimumPfTotal: 0,
      differenceTotal: 0,
      marginTotal: 0,
      totalPnl: 0,
      grossProfit: 0,
      grossLoss: 0,
      maxDdtMin: 0,
    })
    count.evaluated++
    count.valid += block.valid ? 1 : 0
    count.disabled += block.valid ? 0 : 1
    count.observedPfTotal += Number(block.blockObservedProfitFactor) || 0
    count.observedPfCount += !block.blockObservedProfitFactorInfinite
      && Number.isFinite(Number(block.blockObservedProfitFactor)) ? 1 : 0
    count.infinitePf += block.blockObservedProfitFactorInfinite ? 1 : 0
    count.minimumPfTotal += Number(block.blockMinimumProfitFactor) || 0
    count.differenceTotal += Number(block.blockProfitFactorDifference) || 0
    count.marginTotal += Number(block.blockProfitFactorToMinimumDifference) || 0
    count.totalPnl += Number(block.blockTotalPnl) || 0
    count.grossProfit += Number(block.blockNetProfit ?? block.blockGrossProfit) || 0
    count.grossLoss += Number(block.blockNetLoss ?? block.blockGrossLoss) || 0
    count.maxDdtMin = Math.max(count.maxDdtMin, Number(block.blockMaxDrawdownTimeMin) || 0)
  }
}

function compactMetrics(metrics) {
  const buckets = Object.fromEntries(Object.entries(metrics.ddtBuckets)
    .sort(([left], [right]) => Number(left.split("-")[0]) - Number(right.split("-")[0]))
    .map(([key, value]) => [key, {
      configs: value.configs,
      valid: value.valid,
      disabled: value.configs - value.valid,
      maxDDTMinutes: Number(value.maxDdtMin.toFixed(3)),
      meanAverageDDTMinutes: value.configs > 0 ? Number((value.ddtTotal / value.configs).toFixed(3)) : 0,
    }]))
  const byStrategyType = Object.fromEntries(Object.entries(metrics.byStrategyType).map(([key, value]) => [key, {
    evaluated: value.evaluated || 0,
    valid: value.valid || 0,
    disabled: value.disabled || 0,
  }]))
  const byBlockCount = Object.fromEntries(Object.entries(metrics.byBlockCount).map(([key, value]) => [key, {
    configs: value.configs,
    valid: value.valid,
    disabled: value.disabled,
    maxDDTMinutes: Number(value.maxDdtMin.toFixed(3)),
    scaledPnl: Number(value.scaledPnl.toFixed(3)),
  }]))
  const blockLedgerByCount = Object.fromEntries(Object.entries(metrics.blockLedger.byCount)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([key, value]) => [key, {
      evaluated: value.evaluated,
      valid: value.valid,
      disabled: value.disabled,
      meanObservedPF: value.observedPfCount > 0 ? Number((value.observedPfTotal / value.observedPfCount).toFixed(3)) : null,
      infinitePF: value.infinitePf,
      meanMinimumPF: value.evaluated > 0 ? Number((value.minimumPfTotal / value.evaluated).toFixed(3)) : 0,
      meanProfitFactorDifference: value.evaluated > 0 ? Number((value.differenceTotal / value.evaluated).toFixed(3)) : 0,
      meanProfitFactorToMinimumDifference: value.evaluated > 0 ? Number((value.marginTotal / value.evaluated).toFixed(3)) : 0,
      projectedPnl: Number(value.totalPnl.toFixed(3)),
      aggregatePF: value.grossLoss > 0 ? Number((value.grossProfit / value.grossLoss).toFixed(3)) : null,
      aggregatePFInfinite: value.grossLoss === 0 && value.grossProfit > 0,
      maximumDDTMinutes: Number(value.maxDdtMin.toFixed(3)),
    }]))
  return {
    evaluated: metrics.evaluated,
    valid: metrics.valid,
    disabled: metrics.evaluated - metrics.valid,
    validRatePercent: metrics.evaluated > 0 ? Number((metrics.valid / metrics.evaluated * 100).toFixed(3)) : 0,
    meanFinitePF: metrics.finitePfCount > 0 ? Number((metrics.finitePfTotal / metrics.finitePfCount).toFixed(3)) : null,
    infinitePF: metrics.infinitePf,
    meanAverageDDTMinutes: metrics.evaluated > 0 ? Number((metrics.averageDdtTotal / metrics.evaluated).toFixed(3)) : 0,
    maximumDDTMinutes: Number(metrics.maximumDdtMin.toFixed(3)),
    basePnl: Number(metrics.basePnl.toFixed(3)),
    scaledPnl: Number(metrics.scaledPnl.toFixed(3)),
    baseGrossProfit: Number(metrics.baseGrossProfit.toFixed(3)),
    baseGrossLoss: Number(metrics.baseGrossLoss.toFixed(3)),
    baseAggregatePF: metrics.baseGrossLoss > 0 ? Number((metrics.baseGrossProfit / metrics.baseGrossLoss).toFixed(3)) : null,
    baseAggregatePFInfinite: metrics.baseGrossLoss === 0 && metrics.baseGrossProfit > 0,
    selectedBlockGrossProfit: Number(metrics.selectedBlockGrossProfit.toFixed(3)),
    selectedBlockGrossLoss: Number(metrics.selectedBlockGrossLoss.toFixed(3)),
    selectedBlockAggregatePF: metrics.selectedBlockGrossLoss > 0 ? Number((metrics.selectedBlockGrossProfit / metrics.selectedBlockGrossLoss).toFixed(3)) : null,
    selectedBlockAggregatePFInfinite: metrics.selectedBlockGrossLoss === 0 && metrics.selectedBlockGrossProfit > 0,
    selectedBlockCount: metrics.selectedBlockCount,
    selectedBlockPnl: Number(metrics.selectedBlockPnl.toFixed(3)),
    disabledByReason: metrics.disabledByReason,
    byStrategyType,
    byBlockCount,
    blockLedger: {
      evaluated: metrics.blockLedger.evaluated,
      valid: metrics.blockLedger.valid,
      disabled: metrics.blockLedger.evaluated - metrics.blockLedger.valid,
      validRatePercent: metrics.blockLedger.evaluated > 0 ? Number((metrics.blockLedger.valid / metrics.blockLedger.evaluated * 100).toFixed(3)) : 0,
      meanObservedPF: metrics.blockLedger.observedPfCount > 0 ? Number((metrics.blockLedger.observedPfTotal / metrics.blockLedger.observedPfCount).toFixed(3)) : null,
      infinitePF: metrics.blockLedger.infinitePf,
      meanMinimumPF: metrics.blockLedger.evaluated > 0 ? Number((metrics.blockLedger.minimumPfTotal / metrics.blockLedger.evaluated).toFixed(3)) : 0,
      meanProfitFactorDifference: metrics.blockLedger.evaluated > 0 ? Number((metrics.blockLedger.differenceTotal / metrics.blockLedger.evaluated).toFixed(3)) : 0,
      meanProfitFactorToMinimumDifference: metrics.blockLedger.evaluated > 0 ? Number((metrics.blockLedger.marginTotal / metrics.blockLedger.evaluated).toFixed(3)) : 0,
      projectedPnl: Number(metrics.blockLedger.totalPnl.toFixed(3)),
      aggregatePF: metrics.blockLedger.grossLoss > 0 ? Number((metrics.blockLedger.grossProfit / metrics.blockLedger.grossLoss).toFixed(3)) : null,
      aggregatePFInfinite: metrics.blockLedger.grossLoss === 0 && metrics.blockLedger.grossProfit > 0,
      byCount: blockLedgerByCount,
    },
    ddtMaximumByFourHourBucket: buckets,
  }
}

function buildPlans() {
  const noTrailingOption = { trailing: false, trailStart: 0, trailStop: 0, mode: "none" }
  const fixedTrailOptions = [
    { trailing: true, trailStart: 0.3, trailStop: 0.2, mode: "fixed" },
    { trailing: true, trailStart: 0.5, trailStop: 0.3, mode: "fixed" },
    { trailing: true, trailStart: 1, trailStop: 0.5, mode: "fixed" },
  ]
  const autoTrailOptions = [0.75, 1, 1.25].map((autoTrailSensitivity) => ({
    trailing: true, trailStart: 0.5, trailStop: 0.3, mode: "auto", autoTrailSensitivity,
  }))
  const ratios = buildDirectTradeTakeProfitPositionCostRatios([5, 10], 5)
  const tpRange = ratios.map((ratio) => directTradeTakeProfitPercent(positionCostPercent, ratio))
  return { ratios, tpRange, noTrailingOption, fixedTrailOptions, autoTrailOptions }
}

function runMode(blockEnabled) {
  const metrics = createMetrics()
  const keys = new Set()
  const fingerprints = new Map()
  const startedAt = Date.now()
  const plans = buildPlans()
  const timeframeSets = buildTimeframeCombinations(["5m", "15m", "30m"])
  for (let localSymbol = 0; localSymbol < symbolCount; localSymbol++) {
    const symbolIndex = startSymbolIndex + localSymbol
    const minuteCandles = minuteSeries(symbolIndex)
    const candlesByTimeframe = {
      "5m": resampleCandles(minuteCandles, 5),
      "15m": resampleCandles(minuteCandles, 15),
      "30m": resampleCandles(minuteCandles, 30),
    }
    for (const timeframeSet of timeframeSets) {
      for (const direction of ["long", "short"]) {
        const plansForDirection = [
          { strategyType: "standard", signalDirection: direction, slRatios: [0.25, 0.5, 0.75], trailOptions: [plans.noTrailingOption] },
          { strategyType: "trailing_fixed", signalDirection: direction, slRatios: [0.25, 0.5, 0.75], trailOptions: plans.fixedTrailOptions },
          { strategyType: "trailing_auto", signalDirection: direction, slRatios: [0.25, 0.5, 0.75], trailOptions: plans.autoTrailOptions },
          { strategyType: "combination", signalDirection: direction, slRatios: [0.25, 0.5, 0.75], trailOptions: [plans.noTrailingOption, ...plans.fixedTrailOptions, ...plans.autoTrailOptions] },
          { strategyType: "inverse", signalDirection: direction === "long" ? "short" : "long", slRatios: [0.25, 0.5, 0.75, 1, 1.25], trailOptions: [plans.noTrailingOption, ...plans.fixedTrailOptions] },
          { strategyType: "high_protection", signalDirection: direction, slRatios: [0.75], trailOptions: [plans.noTrailingOption, ...plans.autoTrailOptions] },
          { strategyType: "dca", signalDirection: direction, slRatios: [1], trailOptions: [plans.noTrailingOption] },
        ]
        for (const plan of plansForDirection) {
          const sets = evaluateDirectTradeSets({
            symbol: `LOAD${symbolIndex}USDT`,
            direction,
            signalDirection: plan.signalDirection,
            strategyType: plan.strategyType,
            candlesByTimeframe,
            timeframeSet,
            historyHours,
            volumeRatio: blockVolumeRatio,
            blockIncrementSteps,
            tpRange: plans.tpRange,
            takeProfitPositionCostRatios: plans.ratios,
            slRatios: plan.slRatios,
            trailOptions: plan.trailOptions,
            entryTactics: ["momentum", "mean_reversion", "breakout", "relative"],
            exitTactics: ["bracket", "momentum_reversal", "relative", "time"],
            entryTiming: "current",
            activityVolumeRatio: 1,
            maxHoldMinutes: 120,
            positionCostPercent,
            blockRange: blockEnabled ? [blockMinimum, blockMaximum] : [0, 0],
            minProfitFactor,
            minRecentProfitFactor,
            recentPositionWindow: recentEvaluationPositions,
            minRecentPositions: recentEvaluationPositions,
            maxDrawdownTimeMin,
          })
          for (const set of sets) {
            const blockCount = Math.max(0, Math.floor(Number(set.blockCount) || 0))
            const scale = calculateBlockVolumeMultiplier(blockCount, blockVolumeRatio, blockIncrementSteps) || 1
            if (blockEnabled && blockCount > 0) {
              const increment = calculateBlockVolumeIncrementRatio(blockCount, blockVolumeRatio, blockIncrementSteps)
              if (increment <= 0 || scale !== 1 + increment) throw new Error(`Block sizing invariant failed for ${set.setKey}`)
            }
            keys.add(set.setKey)
            const fingerprintKey = set.setKey.replace(
              /\|block:\d+\|blockRatio:[^|]+\|blockSteps:[^|]+\|blockPfRatio:[^|]+(?=\|dca:)/,
              "",
            )
            fingerprints.set(fingerprintKey, {
              profitFactor: set.profitFactor,
              profitFactorInfinite: Boolean(set.profitFactorInfinite),
              averageDDTMinutes: Number(set.avgDrawdownTimeMin) || 0,
              maximumDDTMinutes: Number(set.maxDrawdownTimeMin) || 0,
              valid: Boolean(set.valid),
            })
            recordSet(metrics, set, scale)
            recordBlockLedger(metrics, set)
          }
        }
      }
    }
    if (progressEnabled) {
      console.error(JSON.stringify({
        test: "direct-trade-block-progress",
        mode: blockEnabled ? "with-block" : "without-block",
        completedSymbols: localSymbol + 1,
        totalSymbols: symbolCount,
        evaluated: metrics.evaluated,
        valid: metrics.valid,
        elapsedMs: Date.now() - startedAt,
        heapMiB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      }))
    }
  }
  return { metrics: compactMetrics(metrics), uniqueSetKeys: keys.size, fingerprints, elapsedMs: Date.now() - startedAt }
}

const withoutBlock = runMode(false)
const withBlock = runMode(true)
const selectedBaseRows = withBlock.metrics.evaluated
const independentLedgerRows = withBlock.metrics.blockLedger.evaluated
const blockEnabledValid = withBlock.metrics.valid
const blockEnabledDisabled = withBlock.metrics.disabled
let identityMismatches = 0
for (const [key, without] of withoutBlock.fingerprints) {
  const withEntry = withBlock.fingerprints.get(key)
  if (!withEntry
    || without.profitFactor !== withEntry.profitFactor
    || without.profitFactorInfinite !== withEntry.profitFactorInfinite
    || without.averageDDTMinutes !== withEntry.averageDDTMinutes
    || without.maximumDDTMinutes !== withEntry.maximumDDTMinutes) {
    identityMismatches++
  }
}
if (identityMismatches > 0 || withoutBlock.fingerprints.size !== withBlock.fingerprints.size) {
  throw new Error(`Block PF/DDT identity mismatch: ${identityMismatches} mismatched of ${withoutBlock.fingerprints.size}/${withBlock.fingerprints.size}`)
}
const blockCountThresholds = Object.fromEntries(Array.from({ length: blockMaximum - blockMinimum + 1 }, (_, index) => {
  const count = blockMinimum + index
  const increment = calculateBlockVolumeIncrementRatio(count, blockVolumeRatio, blockIncrementSteps)
  return [String(count), {
    volumeIncrementRatio: increment,
    volumeMultiplier: calculateBlockVolumeMultiplier(count, blockVolumeRatio, blockIncrementSteps),
    configuredMinimumPF: calculateBlockMinimumProfitFactor(minProfitFactor, blockProfitFactorRatio, increment),
  }]
}))
const blockAggregatePfs = Object.values(withBlock.metrics.blockLedger.byCount)
  .map((row) => row.aggregatePF)
  .filter((value) => Number.isFinite(Number(value)))
if (blockAggregatePfs.length > 1 && new Set(blockAggregatePfs.map((value) => Number(value).toFixed(6))).size < 2) {
  throw new Error("Independent Block Count PF regression: every count has the same aggregate PF")
}
const result = {
  test: "direct-trade-block-comparison",
  paperOnly: true,
  symbols: symbolCount,
  startSymbolIndex,
  historyMinutes,
  historyHours,
  timeframeSets: buildTimeframeCombinations(["5m", "15m", "30m"]).length,
  strategyTypes: ["standard", "trailing_fixed", "trailing_auto", "combination", "inverse", "high_protection", "dca"],
  positionCostPercent,
  minProfitFactor,
  minRecentProfitFactor,
  recentEvaluationPositions,
  maxDrawdownTimeMin,
  blockConfig: {
    enabledRange: [blockMinimum, blockMaximum],
    disabledRange: [0, 0],
    volumeRatio: blockVolumeRatio,
    incrementSteps: blockIncrementSteps,
    profitFactorRatio: blockProfitFactorRatio,
    countThresholds: blockCountThresholds,
    countFormula: "target = base × (1 + volumeRatio)^min(count, incrementSteps)",
    pfFormula: "minimum = 1 + ((defaultPF - 1) × blockPFRatio × ((1 + volumeRatio)^effectiveStep - 1))",
    independentCountPfDdtLedger: true,
    pfRatioAppliedToEligibility: true,
    note: "Direct-Trade stores one selected execution row plus independent Count-1..N PF/DDT ledger entries; the selected row uses the largest qualifying count.",
  },
  withoutBlock: {
    metrics: withoutBlock.metrics,
    uniqueSetKeys: withoutBlock.uniqueSetKeys,
    elapsedMs: withoutBlock.elapsedMs,
    disabledStrategyConfigs: withoutBlock.metrics.disabled,
    blockConfigsDisabledBySwitch: selectedBaseRows,
    blockLedger: withoutBlock.metrics.blockLedger,
  },
  withBlock: {
    metrics: withBlock.metrics,
    uniqueSetKeys: withBlock.uniqueSetKeys,
    elapsedMs: withBlock.elapsedMs,
    disabledStrategyConfigs: blockEnabledDisabled,
    blockConfigsDisabledBySwitch: 0,
    blockLedger: withBlock.metrics.blockLedger,
  },
  blockComparison: {
    selectedBaseRows,
    selectedBaseRowsValid: blockEnabledValid,
    selectedBaseRowsDisabled: blockEnabledDisabled,
    independentLedgerRows,
    independentLedgerValid: withBlock.metrics.blockLedger.valid,
    independentLedgerDisabled: withBlock.metrics.blockLedger.disabled,
    baseConfigDisabledWithoutBlock: withoutBlock.metrics.disabled,
    baseConfigDisabledWithBlock: withBlock.metrics.disabled,
    disabledConfigDelta: blockEnabledDisabled - withoutBlock.metrics.disabled,
    baseAggregatePFWithoutBlock: withoutBlock.metrics.baseAggregatePF,
    selectedBlockAggregatePFWithBlock: withBlock.metrics.selectedBlockAggregatePF,
    blockLedgerAggregatePFWithBlock: withBlock.metrics.blockLedger.aggregatePF,
    aggregatePFDifferenceSelectedVsBase: (withBlock.metrics.selectedBlockAggregatePF ?? 0)
      - (withoutBlock.metrics.baseAggregatePF ?? 0),
    identityMismatches,
    note: "Per-set admission uses the PositionCost coordinate; aggregate Block PF remains the separate classic statistic calculated from summed ratio-weighted positive/negative PnL. The TP ratio range mean is diagnostic only and projected PnL/target volume use the capped compound multiplier.",
  },
  generatedAt: new Date().toISOString(),
}
const output = JSON.stringify(result)
if (reportFile) require("node:fs").writeFileSync(reportFile, `${output}\n`, "utf8")
console.log(output)
