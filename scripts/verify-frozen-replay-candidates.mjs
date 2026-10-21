#!/usr/bin/env node
/**
 * Out-of-sample check of configurations that were selected on a development
 * replay. Nothing is re-selected here: each frozen identity from the development
 * `validated-candidates.json` is looked up in a separate holdout replay run and
 * judged with the same rules (both costs positive, at least 42 trades, drawdown
 * time at most 240 minutes).
 *
 *   node scripts/verify-frozen-replay-candidates.mjs <dev-validated-candidates.json> <holdout-run-dir> <holdout-report-summary.json> <out-dir>
 *
 * The holdout report summary gives the control: how many configurations of the
 * whole holdout grid pass the same rules. Frozen survivors are compared with that
 * base rate; a hit rate no higher than the base rate is no evidence of an edge.
 */
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import readline from "node:readline"
import zlib from "node:zlib"

const [frozenFile, holdoutRunDir, holdoutSummaryFile, outDir] = process.argv.slice(2)
if (!frozenFile || !holdoutRunDir || !holdoutSummaryFile || !outDir) {
  console.error("usage: verify-frozen-replay-candidates.mjs <dev-validated-candidates.json> <holdout-run-dir> <holdout-report-summary.json> <out-dir>")
  process.exit(2)
}
const MIN_TRADES = 42
const MAX_DDT_MIN = 240
const frozen = JSON.parse(readFileSync(frozenFile, "utf8"))
const holdoutSummary = JSON.parse(readFileSync(holdoutSummaryFile, "utf8"))
const runSummary = JSON.parse(readFileSync(path.join(holdoutRunDir, "summary.json"), "utf8"))
const frozenByKey = new Map(frozen.map((c) => [c.pairKey, { ...c, cost: {}, ambiguous: false }]))
const pairKeyOf = (setKey) => String(setKey).split("|").filter((token) => !/^(cost|tpCost|block):/.test(token)).join("|")
const costValues = [...new Set(runSummary.dimensions.positionCostPercent)].sort((a, b) => a - b)
const [baseCost, stressCost] = [costValues[0], costValues[costValues.length - 1]]

const rl = readline.createInterface({ input: createReadStream(path.join(holdoutRunDir, "all-configurations.ndjson.gz")).pipe(zlib.createGunzip()), crlfDelay: Infinity })
let legend = null
for await (const line of rl) {
  if (!legend) { legend = JSON.parse(line); continue }
  const { set, blocks } = JSON.parse(line)
  const row = Object.fromEntries(legend.setColumns.map((k, i) => [k, set[i]]))
  const entry = frozenByKey.get(pairKeyOf(row.setKey))
  if (!entry) continue
  const cost = row.positionCostPercent
  if (cost !== baseCost && cost !== stressCost) continue
  if (entry.cost[cost]) { entry.ambiguous = true; continue }
  // Same effective drawdown the development report uses: the selected Block lane when one exists.
  const selected = blocks
    .map((values) => Object.fromEntries(legend.blockColumns.map((k, i) => [k, values[i]])))
    .find((b) => b.blockCount === row.blockCount) || null
  entry.cost[cost] = {
    pnl: row.effectiveTotalPnl ?? row.totalPnl,
    pf: row.effectiveProfitFactor ?? row.profitFactor,
    infinite: Boolean(row.effectiveProfitFactorInfinite),
    trades: row.totalTrades || 0,
    ddt: selected ? selected.blockMaxDrawdownTimeMin : row.maxDrawdownTimeMin,
  }
}

const positive = (c) => Boolean(c) && c.pnl > 0 && (c.infinite || (c.pf !== null && c.pf > 1))
const passes = (c) => positive(c) && c.trades >= MIN_TRADES && (c.ddt ?? Infinity) <= MAX_DDT_MIN
const results = [...frozenByKey.values()].map((c) => {
  const b = c.cost[baseCost], s = c.cost[stressCost]
  return {
    pairKey: c.pairKey, symbol: c.symbol, strategyType: c.strategyType, direction: c.direction, timeframe: c.timeframe,
    entryTactic: c.entryTactic, exitTactic: c.exitTactic, trailingMode: c.trailingMode,
    devEffectivePnlBase: c.devEffectivePnlBase, devEffectivePfBase: c.devEffectivePfBase,
    holdoutFound: Boolean(b || s), ambiguous: c.ambiguous,
    holdoutPnlBase: b ? b.pnl : null, holdoutPfBase: b && !b.infinite ? b.pf : null, holdoutTradesBase: b ? b.trades : null, holdoutDdtBase: b ? b.ddt : null,
    holdoutPnlStress: s ? s.pnl : null, holdoutPfStress: s && !s.infinite ? s.pf : null, holdoutTradesStress: s ? s.trades : null, holdoutDdtStress: s ? s.ddt : null,
    holdoutPositiveBothWithRules: !c.ambiguous && passes(b) && passes(s),
  }
})
const found = results.filter((r) => r.holdoutFound).length
const positiveBase = results.filter((r) => r.holdoutPnlBase !== null && r.holdoutPnlBase > 0).length
const positiveBothWithRules = results.filter((r) => r.holdoutPositiveBothWithRules).length
const controlValidated = holdoutSummary.validatedCandidates
const controlConfigurationPairs = holdoutSummary.configurationPairs
const frozenRate = results.length ? positiveBothWithRules / results.length : 0
const controlRate = controlConfigurationPairs ? controlValidated / controlConfigurationPairs : 0
const verdict = positiveBothWithRules === 0
  ? "No frozen configuration passes both costs with the rules in the holdout."
  : frozenRate > controlRate * 1.5 && positiveBothWithRules >= 10
    ? "Frozen survivors pass at a clearly higher rate than the holdout base rate; still one window, so this is evidence to test further, not a validated edge."
    : "Frozen survivors do not pass at a higher rate than the holdout base rate; selection adds no measurable out-of-sample edge in this window."

const summary = {
  devCandidates: results.length, holdoutWindow: { start: new Date(runSummary.start).toISOString(), endExclusive: new Date(runSummary.endExclusive).toISOString() },
  holdoutSourceSha256: runSummary.sourceSha256, holdoutEngineSourceSha256: runSummary.engineSourceSha256,
  frozenFound: found, frozenPositiveBaseCost: positiveBase, frozenPositiveBothWithRules: positiveBothWithRules,
  frozenHitRate: frozenRate, controlValidatedInHoldout: controlValidated, controlConfigurationPairs, controlRate, verdict,
  rules: { minTrades: MIN_TRADES, maxDrawdownTimeMin: MAX_DDT_MIN, baseCost, stressCost },
  defaultsPromoted: false, independentHoldout: "reserved window; not verified as never viewed",
}
mkdirSync(outDir, { recursive: true })
writeFileSync(path.join(outDir, "frozen-holdout-summary.json"), JSON.stringify(summary, null, 2))
writeFileSync(path.join(outDir, "frozen-holdout-results.json"), JSON.stringify(results))
console.log(JSON.stringify(summary))
