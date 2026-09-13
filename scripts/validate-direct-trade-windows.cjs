#!/usr/bin/env node
/* Offline SOL window comparison; no credentials, Redis or exchange writes. */
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const zlib = require("node:zlib")
const readline = require("node:readline")
const { spawnSync } = require("node:child_process")
const { evaluateDirectTradeSets } = require("../lib/direct-trade-coordination.ts")

const [input, out, holdout] = process.argv.slice(2)
assert(input && out, "Usage: node --import tsx scripts/validate-direct-trade-windows.cjs PUBLIC_14D_JSON OUTPUT_DIRECTORY [UNTOUCHED_NEXT_14D_JSON]")
const windows = [3, 6, 12, 24, 48]
fs.mkdirSync(out, { recursive: true, mode: 0o700 })
const output = { windows, rows: [], frozenCandidates: [], validation: [], defaultsPromoted: false,
  note: "Effective PF is summed positive net PnL divided by absolute negative net PnL for the selected Block lane (or Base/DCA). Cross-config aggregates overlap and are not portfolio results." }

async function audit(directory, window) {
  const summary = JSON.parse(fs.readFileSync(path.join(directory, "summary.json")))
  assert.equal(summary.dimensions.recentPositionWindow, window)
  const hash = crypto.createHash("sha256"), costs = {}
  let columns, blockColumns, count = 0
  const stream = fs.createReadStream(path.join(directory, "all-configurations.ndjson.gz")).pipe(zlib.createGunzip())
  for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
    const row = JSON.parse(line)
    if (!columns) { columns = row.setColumns; blockColumns = row.blockColumns; continue }
    const s = Object.fromEntries(columns.map((key, i) => [key, row.set[i]]))
    const blocks = row.blocks.map(values => Object.fromEntries(blockColumns.map((key, i) => [key, values[i]])))
    // Exact full ledgers must be invariant to a window-only admission change.
    hash.update(JSON.stringify([s.symbol, s.direction, s.strategyType, s.timeframe, s.entryTactic, s.exitTactic,
      s.takeprofit, s.stoploss, s.trailingMode, s.trailStart, s.trailStop, s.autoTrailSensitivity,
      s.positionCostPercent, s.blockVolumeRatio, s.blockIncrementSteps, s.totalTrades,
      s.totalPnl, s.netProfit, s.netLoss, s.profitFactor, s.profitFactorInfinite,
      blocks.map(b => [b.blockCount, b.blockTotalPnl, b.blockNetProfit, b.blockNetLoss, b.blockRealizedProfitFactor, b.blockRealizedProfitFactorInfinite, b.blockRealizedVolumeMultiplier])]))
    const selected = blocks.find(b => b.blockCount === s.blockCount)
    assert.equal(s.effectiveTotalPnl, selected ? selected.blockTotalPnl : s.totalPnl)
    assert.equal(s.effectiveProfitFactor, selected ? selected.blockRealizedProfitFactor : s.profitFactor)
    const a = costs[s.positionCostPercent] ||= { window, cost: s.positionCostPercent, evaluated: 0, valid: 0, validBlockLanes: 0, positiveEffective: 0, qualifiedNetProfit: 0, qualifiedNetLoss: 0, reasons: {} }
    a.evaluated++; a.valid += Number(s.valid); a.validBlockLanes += blocks.filter(b => b.valid).length
    a.positiveEffective += Number(s.effectiveTotalPnl > 0)
    if (s.valid) { a.qualifiedNetProfit += s.effectiveNetProfit; a.qualifiedNetLoss += s.effectiveNetLoss }
    else a.reasons[s.deactivationReason || "unknown"] = (a.reasons[s.deactivationReason || "unknown"] || 0) + 1
    count++
  }
  assert.equal(count, summary.evaluatedSets)
  for (const a of Object.values(costs)) {
    a.qualifiedAggregateEffectivePf = a.qualifiedNetLoss > 0 ? a.qualifiedNetProfit / a.qualifiedNetLoss : null
    a.qualifiedAggregateEffectivePfInfinite = a.qualifiedNetLoss === 0 && a.qualifiedNetProfit > 0
    a.qualifiedAggregateEffectivePnl = a.qualifiedNetProfit - a.qualifiedNetLoss
    output.rows.push(a)
  }
  for (const c of summary.candidates.filter(c => c.config.positionCostPercent === 0.2)) {
    output.frozenCandidates.push({ window, ...c })
  }
  return hash.digest("hex")
}

function validateFrozenCandidates() {
  const market = JSON.parse(fs.readFileSync(holdout)), training = JSON.parse(fs.readFileSync(input))
  const day = 86_400_000
  assert.equal(market.start, training.endExclusive, "Holdout must follow training without overlap")
  assert.equal(market.endExclusive - market.start, 14 * day)
  assert.equal(market.errors.length, 0)
  for (const minutes of [5, 15, 30]) {
    const rows = market.series[`SOL-USDT:${minutes}`].candles
    assert.equal(rows.length, 14 * day / (minutes * 60_000))
    rows.forEach((c, i) => assert.equal(c.time, market.start + i * minutes * 60_000))
  }
  for (const frozen of output.frozenCandidates) {
    const c = frozen.config, count = frozen.metrics.blockCount
    const checks = []
    for (const [name, start, end] of [["full", market.start, market.endExclusive], ["first-half", market.start, market.start + 7 * day], ["second-half", market.start + 7 * day, market.endExclusive]]) {
      const candlesByTimeframe = Object.fromEntries([5, 15, 30].map(m => [`${m}m`, market.series[`SOL-USDT:${m}`].candles.filter(row => row.time >= start && row.time < end)]))
      for (const cost of [0.1, 0.2]) {
        const sets = evaluateDirectTradeSets({ symbol: "SOLUSDT", direction: c.direction, signalDirection: c.signalDirection,
          strategyType: c.strategyType, candlesByTimeframe, timeframeSet: c.timeframe.split("+"), historyHours: (end - start) / 3_600_000,
          volumeRatio: c.blockVolumeRatio, blockVolumeRatio: c.blockVolumeRatio, blockIncrementSteps: c.blockIncrementSteps,
          tpRange: [c.takeprofit], slRatios: [c.stoploss / c.takeprofit],
          trailOptions: [{ trailing: c.trailingMode !== "none", mode: c.trailingMode, trailStart: c.trailStart, trailStop: c.trailStop, autoTrailSensitivity: c.autoTrailSensitivity }],
          entryTactics: [c.entryTactic], exitTactics: [c.exitTactic], entryTiming: "current", activityVolumeRatio: 1,
          maxHoldMinutes: 120, positionCostPercent: cost, blockRange: [count, count], minProfitFactor: 1.1, minRecentProfitFactor: 1.1,
          recentPositionWindow: frozen.window, minRecentPositions: frozen.window, maxDrawdownTimeMin: 300 })
        assert.equal(sets.length, 1)
        const s = sets[0], b = s.blockEvaluations.find(b => b.blockCount === count)
        assert.equal(s.takeprofit, c.takeprofit, "Holdout changed frozen TP")
        assert.equal(s.stoploss, c.stoploss, "Holdout changed frozen SL")
        assert.equal(s.blockCount, count, "Holdout changed frozen Block count")
        const pnl = b ? b.blockTotalPnl : s.totalPnl, pf = b ? b.blockRealizedProfitFactor : s.profitFactor
        const infinite = b ? b.blockRealizedProfitFactorInfinite : s.profitFactorInfinite
        const maxDdt = b ? b.blockMaxDrawdownTimeMin : s.maxDrawdownTimeMin
        checks.push({ period: name, cost, totalTrades: s.totalTrades, effectivePnl: pnl, effectivePf: pf, infinite, maxDdt,
          valid: s.valid, reason: s.deactivationReason,
          pass: s.valid && s.totalTrades >= (name === "full" ? 42 : 12) && pnl > 0 && (infinite || pf >= 1.1) && maxDdt <= 300 })
      }
    }
    output.validation.push({ config: c, blockCount: count, window: frozen.window, checks, pass: checks.every(c => c.pass) })
  }
  output.validationSummary = { candidates: output.validation.length, passed: output.validation.filter(c => c.pass).length,
    independentChronologicalPeriod: [market.start, market.endExclusive], noRetuning: true }
}

async function main() {
  let expectedHash
  for (const window of windows) {
    const dir = path.join(out, String(window)), log = path.join(out, `${window}.log`)
    console.log(JSON.stringify({ window, phase: "matrix-start" }))
    const fd = fs.openSync(log, "w", 0o600)
    const child = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", path.join(__dirname, "validate-direct-trade-history.cjs"), input, dir, "SOL-USDT", String(window)], { stdio: ["ignore", fd, fd], timeout: 300_000 })
    fs.closeSync(fd)
    assert.equal(child.status, 0, `Window ${window} failed; inspect ${log}`)
    const hash = await audit(dir, window)
    if (expectedHash) assert.equal(hash, expectedHash, "Window size changed a complete historical ledger")
    expectedHash = hash
    console.log(JSON.stringify({ window, phase: "matrix-pass", fullLedgerHash: hash }))
  }
  output.fullLedgerInvariantHash = expectedHash
  // Freeze the selection before reading or evaluating the untouched period.
  fs.writeFileSync(path.join(out, "frozen-candidates.json"), JSON.stringify(output.frozenCandidates), { mode: 0o600 })
  if (holdout) validateFrozenCandidates()
  fs.writeFileSync(path.join(out, "window-summary.json"), JSON.stringify(output), { mode: 0o600 })
  console.log(JSON.stringify({ success: true, configurations: output.rows.reduce((n, row) => n + row.evaluated, 0), validation: output.validationSummary || null }))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
