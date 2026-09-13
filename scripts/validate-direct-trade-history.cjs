#!/usr/bin/env node
/* Public-candle replay only: no Redis, credentials, network, or exchange writes. */
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const zlib = require("node:zlib")
const { once } = require("node:events")
const { pipeline } = require("node:stream/promises")
const { evaluateDirectTradeSets, buildTimeframeCombinations } = require("../lib/direct-trade-coordination.ts")

const [inputFile, outputDirectory, symbolList = "BCH-USDT,XRP-USDT,SOL-USDT", windowArgument = "12"] = process.argv.slice(2)
assert(inputFile && outputDirectory, "Usage: node --import tsx scripts/validate-direct-trade-history.cjs PUBLIC_CANDLES_JSON OUTPUT_DIRECTORY [SOL-USDT] [RECENT_POSITION_COUNT]")
const recentPositionWindow = Number(windowArgument)
assert(Number.isInteger(recentPositionWindow) && recentPositionWindow >= 3 && recentPositionWindow <= 50, "Recent position count must be an integer in the settings range 3–50")
const symbols = [...new Set(symbolList.split(","))]
assert(symbols.length > 0 && symbols.every(symbol => ["BCH-USDT", "XRP-USDT", "SOL-USDT"].includes(symbol)), "Unsupported public-candle symbol")
const raw = fs.readFileSync(inputFile)
const market = JSON.parse(raw)
const day = 86_400_000
assert.equal(market.endExclusive - market.start, 14 * day, "Exactly fourteen complete UTC days are required")
assert.equal(market.start % day, 0)
assert.equal(market.endExclusive % day, 0)
assert.equal(market.errors.length, 0)
fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 })
const dimensions = {
  symbols,
  timeframeCombinations: buildTimeframeCombinations(["5m", "15m", "30m"]),
  directions: ["long", "short"],
  entryTactics: ["momentum", "mean_reversion", "breakout", "relative"],
  exitTactics: ["bracket", "momentum_reversal", "relative", "time"],
  entryTiming: "current", takeProfitPercent: [0.5, 1],
  blockCounts: [1, 2, 3, 4, 5, 6], blockVolumeRatios: [0.1, 0.5], blockIncrementSteps: [1, 2], blockEffectiveIncrementStep: 1,
  positionCostPercent: [0.1, 0.2], recentPositionWindow, maxDrawdownTimeMin: 300,
}
const noTrail = { trailing: false, trailStart: 0, trailStop: 0, mode: "none" }
const fixed = [[0.3, 0.2], [0.5, 0.3], [1, 0.5]].map(([trailStart, trailStop]) => ({ trailing: true, trailStart, trailStop, mode: "fixed" }))
const auto = [0.75, 1, 1.25].map(autoTrailSensitivity => ({ trailing: true, trailStart: 0.5, trailStop: 0.3, mode: "auto", autoTrailSensitivity }))
const normalSl = [0.25, 0.5, 0.75]
const plans = [
  ["standard", normalSl, [noTrail]], ["trailing_fixed", normalSl, fixed],
  ["trailing_auto", normalSl, auto], ["combination", normalSl, [noTrail, ...fixed, ...auto]],
  ["inverse", [0.25, 0.5, 0.75, 1, 1.25], [noTrail, ...fixed]],
  ["high_protection", [0.75], [noTrail, ...auto]], ["dca", [1], [noTrail]],
].map(([strategyType, slRatios, trailOptions]) => ({ strategyType, slRatios, trailOptions }))
dimensions.plans = plans
const setColumns = ["setKey", "symbol", "direction", "signalDirection", "strategyType", "timeframe", "entryTactic", "exitTactic", "takeprofit", "stoploss", "trailingMode", "trailStart", "trailStop", "autoTrailSensitivity", "positionCostPercent", "blockVolumeRatio", "blockIncrementSteps", "totalTrades", "totalPnl", "profitFactor", "profitFactorInfinite", "positionCostRatio", "maxDrawdownTimeMin", "avgDrawdownTimeMin", "recentPositionCount", "recentPositionCostRatio", "valid", "deactivationReason", "blockCount", "blockTotalPnl", "blockRealizedProfitFactor", "blockRealizedProfitFactorInfinite", "blockRealizedVolumeMultiplier", "dcaRealizedVolumeMultiplier"]
const blockColumns = ["blockCount", "blockTotalPnl", "blockNetProfit", "blockNetLoss", "blockRealizedProfitFactor", "blockRealizedProfitFactorInfinite", "blockPositionCostRatio", "blockMinimumProfitFactor", "blockMaxDrawdownTimeMin", "blockCalculatedVolumeMultiplier", "blockRealizedVolumeMultiplier", "blockRecentPositionCount", "valid", "deactivationReason"]
setColumns.push("netProfit", "netLoss", "recentProfitFactor", "recentProfitFactorInfinite", "recentTotalPnl", "blockNetProfit", "blockNetLoss", "effectiveTotalPnl", "effectiveNetProfit", "effectiveNetLoss", "effectiveProfitFactor", "effectiveProfitFactorInfinite", "effectiveRecentProfitFactor", "effectiveRecentProfitFactorInfinite", "effectiveRecentPositionCostRatio")
blockColumns.push("blockRecentProfitFactor", "blockRecentProfitFactorInfinite", "blockRecentPositionCostRatio")
const coverage = {}
const summaries = {}
const topByCost = new Map()
let evaluatedSets = 0, blockLanes = 0, tradeObservations = 0, validSets = 0, validBlockLanes = 0
const started = Date.now()

function checkNumbers(object) {
  for (const [k, v] of Object.entries(object)) if (typeof v === "number") assert(Number.isFinite(v), k)
}
function checkProfitFactor(profit, loss, pf, infinite) {
  assert(profit >= 0 && loss >= 0)
  // Persisted ledger components are rounded to 4 decimals, PF to 3. Compare
  // in ledger units rather than dividing by a tiny rounded denominator.
  if (infinite) { assert.equal(pf, null); assert.equal(loss, 0); assert(profit > 0) }
  else { assert(Number.isFinite(pf)); assert(Math.abs(profit - pf * loss) <= 0.0002 * (1 + Math.abs(pf)) + 0.00051 * loss) }
}
function effectiveResult(s) {
  const block = s.blockEvaluations.find(b => b.blockCount === s.blockCount)
  return {
    effectiveTotalPnl: block ? block.blockTotalPnl : s.totalPnl,
    effectiveNetProfit: block ? block.blockNetProfit : s.netProfit,
    effectiveNetLoss: block ? block.blockNetLoss : s.netLoss,
    effectiveProfitFactor: block ? block.blockRealizedProfitFactor : s.profitFactor,
    effectiveProfitFactorInfinite: block ? block.blockRealizedProfitFactorInfinite : s.profitFactorInfinite,
    effectiveRecentProfitFactor: block ? block.blockRecentProfitFactor : s.recentProfitFactor,
    effectiveRecentProfitFactorInfinite: block ? block.blockRecentProfitFactorInfinite : s.recentProfitFactorInfinite,
    effectiveRecentPositionCostRatio: block ? block.blockRecentPositionCostRatio : s.recentPositionCostRatio,
  }
}
function checkSet(s) {
  checkNumbers(s)
  assert(s.totalTrades >= 0 && Number.isInteger(s.totalTrades))
  assert(s.winRate >= 0 && s.winRate <= 100)
  assert(s.takeprofit > 0 && s.stoploss > 0 && s.stoploss <= s.takeprofit * 1.5 + 0.00011)
  assert(Math.abs(s.totalPnl - (s.netProfit - s.netLoss)) <= 0.00021, "Base net ledger does not sum")
  assert.equal(s.recentPositionCount, Math.min(recentPositionWindow, s.totalTrades))
  checkProfitFactor(s.netProfit, s.netLoss, s.profitFactor, s.profitFactorInfinite)
  assert(s.dcaRealizedVolumeMultiplier >= 1)
  const ids = new Set()
  for (const b of s.blockEvaluations) {
    checkNumbers(b); assert(!ids.has(b.blockCount)); ids.add(b.blockCount)
    assert(b.blockCount >= 1 && b.blockCount <= 6)
    assert(Math.abs(b.blockTotalPnl - (b.blockNetProfit - b.blockNetLoss)) <= 0.00021, "Block net ledger does not sum")
    checkProfitFactor(b.blockNetProfit, b.blockNetLoss, b.blockRealizedProfitFactor, b.blockRealizedProfitFactorInfinite)
    assert.equal(b.blockRecentPositionCount, s.recentPositionCount)
    assert.equal(b.blockProfitFactorWindow, recentPositionWindow)
    assert(b.blockCalculatedVolumeMultiplier >= 1 && b.blockCalculatedVolumeMultiplier <= 1 + b.blockCount * s.blockVolumeRatio * s.blockIncrementSteps + 0.00011)
    assert(b.blockRealizedVolumeMultiplier >= 1 && b.blockRealizedVolumeMultiplier <= b.blockCalculatedVolumeMultiplier + 0.00021, "Block quantity exceeds its immutable-base target")
  }
  assert.equal(s.blockEvaluations.length, s.strategyType === "dca" ? 0 : 6)
}
function baseInput(symbol, candlesByTimeframe, timeframeSet, direction, plan, cost, ratio, steps) {
  return { symbol: symbol.replace("-", ""), direction, signalDirection: plan.strategyType === "inverse" ? direction === "long" ? "short" : "long" : direction,
    strategyType: plan.strategyType, candlesByTimeframe, timeframeSet, historyHours: 336,
    volumeRatio: ratio, blockVolumeRatio: ratio, blockIncrementSteps: steps,
    tpRange: dimensions.takeProfitPercent, slRatios: plan.slRatios, trailOptions: plan.trailOptions,
    entryTactics: dimensions.entryTactics, exitTactics: dimensions.exitTactics, entryTiming: "current",
    activityVolumeRatio: 1, maxHoldMinutes: 120, positionCostPercent: cost,
    blockRange: plan.strategyType === "dca" ? [0, 0] : [1, 6], minProfitFactor: 1.1, minRecentProfitFactor: 1.1,
    recentPositionWindow, minRecentPositions: recentPositionWindow, maxDrawdownTimeMin: 300 }
}
function metrics(s) { return Object.fromEntries(setColumns.slice(17).map(k => [k, s[k] ?? null])) }
function config(s) { return Object.fromEntries(setColumns.slice(1, 17).map(k => [k, s[k] ?? null])) }
async function main() {
  const gzip = zlib.createGzip({ level: 1 })
  const completed = pipeline(gzip, fs.createWriteStream(path.join(outputDirectory, "all-configurations.ndjson.gz"), { mode: 0o600 }))
  async function write(row) { if (!gzip.write(JSON.stringify(row) + "\n")) await once(gzip, "drain") }
  await write({ setColumns, blockColumns })
  for (const symbol of dimensions.symbols) {
    const candlesByTimeframe = {}
    for (const minutes of [5, 15, 30]) {
      const entry = market.series[`${symbol}:${minutes}`]
      assert.equal(entry.missing.length, 0)
      const candles = entry.candles, interval = minutes * 60_000
      assert.equal(candles.length, 14 * day / interval)
      candles.forEach((c, i) => { checkNumbers(c); assert.equal(c.time, market.start + i * interval); assert(c.low > 0 && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close)) })
      candlesByTimeframe[`${minutes}m`] = candles
      coverage[`${symbol}:${minutes}`] = { candles: candles.length, gaps: 0 }
    }
    for (const cost of dimensions.positionCostPercent) for (const ratio of dimensions.blockVolumeRatios) for (const steps of dimensions.blockIncrementSteps) {
      for (const timeframeSet of dimensions.timeframeCombinations) for (const direction of dimensions.directions) for (const plan of plans) {
        // DCA owns its own volume ladder; do not duplicate it for irrelevant Block settings.
        if (plan.strategyType === "dca" && (ratio !== 0.1 || steps !== 1)) continue
        const sets = evaluateDirectTradeSets(baseInput(symbol, candlesByTimeframe, timeframeSet, direction, plan, cost, ratio, steps))
        const batchIds = new Set()
        for (const s of sets) {
          checkSet(s); assert(!batchIds.has(s.setKey), "Duplicate independent configuration"); batchIds.add(s.setKey)
          Object.assign(s, effectiveResult(s))
          evaluatedSets++; blockLanes += s.blockEvaluations.length; tradeObservations += s.totalTrades
          validSets += Number(s.valid); validBlockLanes += s.blockEvaluations.filter(b => b.valid).length
          const key = [symbol, cost, s.strategyType, direction, s.entryTactic].join("|")
          const a = summaries[key] ||= { symbol, cost, strategyType: s.strategyType, direction, entry: s.entryTactic, evaluated: 0, valid: 0, positiveBase: 0, positiveBlock: 0, blockDifferentFromBase: 0, maxVolumeMultiplier: 1, invalidReasons: {} }
          a.evaluated++; a.valid += Number(s.valid); a.positiveBase += Number(s.totalPnl > 0)
          a.positiveBlock += s.blockEvaluations.filter(b => b.blockTotalPnl > 0).length
          a.blockDifferentFromBase += s.blockEvaluations.filter(b => Math.abs(b.blockTotalPnl - s.totalPnl) > 0.001).length
          a.maxVolumeMultiplier = Math.max(a.maxVolumeMultiplier, s.dcaRealizedVolumeMultiplier, ...s.blockEvaluations.map(b => b.blockRealizedVolumeMultiplier))
          if (!s.valid) a.invalidReasons[s.deactivationReason || "unknown"] = (a.invalidReasons[s.deactivationReason || "unknown"] || 0) + 1
          await write({ set: setColumns.map(k => s[k] ?? null), blocks: s.blockEvaluations.map(b => blockColumns.map(k => b[k] ?? null)) })
          if (s.valid && s.totalTrades >= 42 && s.effectiveTotalPnl > 0 && (s.effectiveProfitFactorInfinite || s.effectiveProfitFactor >= 1.1)) {
            const key = `${symbol}|${cost}`; const top = topByCost.get(key) || []
            top.push({ config: config(s), metrics: metrics(s) })
            top.sort((a, b) => a.metrics.maxDrawdownTimeMin - b.metrics.maxDrawdownTimeMin || b.metrics.effectiveTotalPnl - a.metrics.effectiveTotalPnl)
            if (top.length > 25) top.length = 25
            topByCost.set(key, top)
          }
        }
      }
      if (global.gc) global.gc()
      console.log(JSON.stringify({ symbol, cost, ratio, steps, evaluatedSets, validSets, blockLanes, elapsedMs: Date.now() - started, heapMiB: Math.round(process.memoryUsage().heapUsed / 1024 ** 2) }))
    }
  }
  gzip.end(); await completed
  const report = { source: "BingX public candles", sourceSha256: crypto.createHash("sha256").update(raw).digest("hex"), start: market.start, endExclusive: market.endExclusive,
    engineSourceSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "../lib/direct-trade-coordination.ts"))).digest("hex"),
    dimensions, coverage, setColumns, blockColumns, evaluatedSets, validSets, blockLanes, validBlockLanes, tradeObservations, elapsedMs: Date.now() - started,
    summaries: Object.values(summaries), candidates: [...topByCost.values()].flat(), defaultsPromoted: false, independentHoldout: false,
    limitations: ["Historical replay of the listed grid, not two weeks of wall-clock exchange execution.", "Both cost scenarios keep absolute TP/SL prices fixed; 0.2% cost is a stress diagnostic, not a separate slippage/funding model.", "Current-bar causal OHLC simulation; no order-book queue, exchange partial fills, liquidation or network latency.", "All configurations overlap in capital and trade observations; summed PnL is not portfolio performance.", "Drawdown is production time-under-water per trade, not portfolio equity drawdown.", "This previously inspected period is not an independent holdout. Candidates are diagnostic only; no defaults are promoted.", "Seven Direct strategy types and four Direct entry tactics are covered; Main/Preset/Signal indicator-specific grids and all possible axes are not covered by this replay.", "Block supports counts 1–6 and increment stages 1–2 in this release; larger input values would be clamped and are not claimed as distinct tests.", "This replay uses the initial effective recovery stage 1; the configured maximum 1/2 is an identity and ceiling case. Dynamic loss/recovery/pause transitions and stage-2 quantities are covered separately by executable lifecycle tests, not replayed here."] }
  fs.writeFileSync(path.join(outputDirectory, "summary.json"), JSON.stringify(report), { mode: 0o600 })
  console.log(JSON.stringify({ success: true, evaluatedSets, blockLanes, validSets, validBlockLanes, tradeObservations, elapsedMs: report.elapsedMs }))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
