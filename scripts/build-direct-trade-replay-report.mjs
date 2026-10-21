#!/usr/bin/env node
/**
 * Build an interactive HTML report and a compact summary from a finished
 * direct-trade history replay (scripts/validate-direct-trade-history.cjs).
 *
 *   node scripts/build-direct-trade-replay-report.mjs <replay-run-dir> <report-dir> [title]
 *
 * Reads <run>/summary.json and <run>/all-configurations.ndjson.gz only, in two
 * streaming passes, so memory stays bounded by the number of base-cost
 * positive configurations. Writes <report>/report.html and <report>/summary.json.
 *
 * Definitions: positive means total PnL above zero AND profit factor above one
 * (or no losses). The base lane is the configuration without Block; the Block
 * lane is the selected Block count (effective result). A configuration counts
 * as positive after costs only when it is positive at the base cost and at the
 * stress cost (the same configuration evaluated at both costs). Nothing here
 * changes a default or places an order.
 */
import { createReadStream, mkdirSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"
import zlib from "node:zlib"

const [runDir, reportDir, titleArg] = process.argv.slice(2)
if (!runDir || !reportDir) {
  console.error("usage: build-direct-trade-replay-report.mjs <replay-run-dir> <report-dir> [title]")
  process.exit(2)
}
const title = titleArg || "Direct-trade replay report"
const MIN_TRADES = 42
const MAX_DDT_MIN = 240
const BUCKETS = ["<0.5", "0.5–0.8", "0.8–1.0", "1.0–1.1", "1.1–1.5", "1.5–2.0", "≥2.0", "∞"]
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const fmt = (value, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "∞ / n.a." : Number(value).toFixed(digits))
const count = (value) => Number(value || 0).toLocaleString("en-US")

const summary = JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf8"))
const gzPath = path.join(runDir, "all-configurations.ndjson.gz")

// The first line of the ndjson file is the column legend.
const legend = await new Promise((resolve, reject) => {
  const rl = readline.createInterface({ input: createReadStream(gzPath).pipe(zlib.createGunzip()) })
  rl.once("line", (line) => { rl.close(); resolve(JSON.parse(line)) })
  rl.once("error", reject)
})
const { setColumns, blockColumns } = legend
// The configuration identity is the setKey without the tokens that change with
// the cost (`cost`, the take-profit/cost ratio and the selected Block count).
const pairKeyOf = (row) => String(row.setKey).split("|").filter((token) => !/^(cost|tpCost|block):/.test(token)).join("|")

const costValues = [...new Set(summary.dimensions.positionCostPercent)].sort((a, b) => a - b)
const [baseCost, stressCost] = [costValues[0], costValues[costValues.length - 1]]

const positive = (pnl, pf, infinite) => pnl > 0 && (infinite || (pf !== null && pf > 1))
const bucketOf = (pf, infinite) => {
  if (infinite) return "∞"
  if (!Number.isFinite(pf) || pf < 0.5) return "<0.5"
  if (pf < 0.8) return "0.5–0.8"
  if (pf < 1) return "0.8–1.0"
  if (pf < 1.1) return "1.0–1.1"
  if (pf < 1.5) return "1.1–1.5"
  if (pf < 2) return "1.5–2.0"
  return "≥2.0"
}

// Visit every evaluated configuration once. `visit` gets a row with its
// effective (Block) lane already resolved.
async function streamRows(visit) {
  const rl = readline.createInterface({ input: createReadStream(gzPath).pipe(zlib.createGunzip()), crlfDelay: Infinity })
  let first = true
  for await (const line of rl) {
    if (first) { first = false; continue }
    const { set, blocks } = JSON.parse(line)
    const row = Object.fromEntries(setColumns.map((k, i) => [k, set[i]]))
    const selected = blocks
      .map((values) => Object.fromEntries(blockColumns.map((k, i) => [k, values[i]])))
      .find((b) => b.blockCount === row.blockCount) || null
    const effectivePnl = row.effectiveTotalPnl ?? row.totalPnl
    const effectivePf = row.effectiveProfitFactor ?? row.profitFactor
    const effectiveInf = Boolean(row.effectiveProfitFactorInfinite)
    visit({
      row,
      effectivePnl,
      effectivePf,
      effectiveInf,
      basePositive: positive(row.totalPnl, row.profitFactor, row.profitFactorInfinite),
      effPositive: positive(effectivePnl, effectivePf, effectiveInf),
      effectiveDdt: selected ? selected.blockMaxDrawdownTimeMin : row.maxDrawdownTimeMin,
    })
  }
}

// ---- pass 1: aggregates, pool totals, and base-cost positive configurations ----
const totals = { baseNet: 0, baseLoss: 0, effectiveNet: 0, effectiveLoss: 0 }
const perSymbol = new Map()
const perType = new Map()
const pfBuckets = { base: new Map(), effective: new Map() }
const baseCandidates = new Map()
let rowsTotal = 0, pairsTotal = 0, baseCostPositive = 0

const bump = (map, key, patch) => {
  const current = map.get(key) || { key, sets: 0, basePositive: 0, effectivePositive: 0, trades: 0, bestEffectivePf: null, bestEffectivePnl: null, effectivePnl: 0 }
  map.set(key, { ...current, ...patch(current) })
}
const accumulate = (r, v) => ({
  sets: r.sets + 1,
  basePositive: r.basePositive + Number(v.basePositive),
  effectivePositive: r.effectivePositive + Number(v.effPositive),
  trades: r.trades + (v.row.totalTrades || 0),
  effectivePnl: r.effectivePnl + (v.effectivePnl || 0),
})

await streamRows((v) => {
  const { row, effectivePnl, effectivePf, effectiveInf, basePositive, effPositive, effectiveDdt } = v
  rowsTotal++
  totals.baseNet += row.netProfit || 0
  totals.baseLoss += row.netLoss || 0
  totals.effectiveNet += row.effectiveNetProfit ?? row.netProfit ?? 0
  totals.effectiveLoss += row.effectiveNetLoss ?? row.netLoss ?? 0
  // Best PF only over configurations with enough trades and a finite PF; a
  // configuration with no losing trade has an infinite PF and no meaning here.
  const pfCounts = row.totalTrades >= MIN_TRADES && !effectiveInf && Number.isFinite(effectivePf)
  bump(perSymbol, row.symbol, (r) => ({
    ...accumulate(r, v),
    bestEffectivePf: pfCounts ? Math.max(r.bestEffectivePf ?? -Infinity, effectivePf) : r.bestEffectivePf,
    bestEffectivePnl: Math.max(r.bestEffectivePnl ?? -Infinity, effectivePnl ?? -Infinity),
  }))
  bump(perType, `${row.strategyType}|${row.direction}`, (r) => accumulate(r, v))
  const baseBucket = bucketOf(row.profitFactor, row.profitFactorInfinite)
  const effectiveBucket = bucketOf(effectivePf, effectiveInf)
  pfBuckets.base.set(baseBucket, (pfBuckets.base.get(baseBucket) || 0) + 1)
  pfBuckets.effective.set(effectiveBucket, (pfBuckets.effective.get(effectiveBucket) || 0) + 1)
  if (row.positionCostPercent !== baseCost) return
  pairsTotal++
  if (!effPositive) return
  baseCostPositive++
  const key = pairKeyOf(row)
  if (baseCandidates.has(key)) { baseCandidates.get(key).ambiguous = true; return }
  baseCandidates.set(key, {
    ambiguous: false,
    pairKey: key,
    symbol: row.symbol, direction: row.direction, strategyType: row.strategyType, timeframe: row.timeframe,
    entryTactic: row.entryTactic, exitTactic: row.exitTactic, takeprofit: row.takeprofit, stoploss: row.stoploss,
    trailingMode: row.trailingMode, blockCount: row.blockCount, blockVolumeRatio: row.blockVolumeRatio,
    blockIncrementSteps: row.blockIncrementSteps, trades: row.totalTrades || 0,
    effectivePnlBase: effectivePnl, effectivePfBase: effectiveInf ? null : effectivePf, ddtMin: effectiveDdt,
    stress: null,
  })
})

// ---- pass 2: match the stress-cost version of each base-positive configuration ----
let stressCostPositive = 0
await streamRows((v) => {
  const { row, effectivePnl, effectivePf, effectiveInf, effPositive, effectiveDdt } = v
  if (row.positionCostPercent !== stressCost || !effPositive) return
  stressCostPositive++
  const entry = baseCandidates.get(pairKeyOf(row))
  if (!entry || entry.ambiguous) return
  if (entry.stress) { entry.ambiguous = true; return }
  entry.stress = { pnl: effectivePnl, pf: effectiveInf ? null : effectivePf, trades: row.totalTrades || 0, ddt: effectiveDdt }
})

const candidates = []
const nearMisses = []
let pairedBothPositive = 0
for (const entry of baseCandidates.values()) {
  const bothPositive = Boolean(entry.stress) && !entry.ambiguous
  if (bothPositive) pairedBothPositive++
  const validated = bothPositive && entry.trades >= MIN_TRADES && (entry.stress.trades >= MIN_TRADES)
    && (entry.ddtMin ?? Infinity) <= MAX_DDT_MIN && (entry.stress.ddt ?? Infinity) <= MAX_DDT_MIN
  const view = {
    ...entry,
    effectivePnlStress: entry.stress?.pnl ?? null,
    effectivePfStress: entry.stress ? entry.stress.pf : null,
    validated,
  }
  if (validated) candidates.push(view)
  else nearMisses.push(view)
}
const byStressPnl = (a, b) => (b.effectivePnlStress ?? -Infinity) - (a.effectivePnlStress ?? -Infinity)
candidates.sort(byStressPnl)
nearMisses.sort((a, b) => (b.effectivePnlBase ?? -Infinity) - (a.effectivePnlBase ?? -Infinity))
const validatedCandidates = candidates.length
// Every validated configuration, frozen by identity, for an out-of-sample check
// (scripts/verify-frozen-replay-candidates.mjs). No new selection happens there.
mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, "validated-candidates.json"), JSON.stringify(candidates.map((c) => ({
  pairKey: c.pairKey, symbol: c.symbol, strategyType: c.strategyType, direction: c.direction, timeframe: c.timeframe,
  entryTactic: c.entryTactic, exitTactic: c.exitTactic, trailingMode: c.trailingMode, devTrades: c.trades,
  devEffectivePnlBase: c.effectivePnlBase, devEffectivePfBase: c.effectivePfBase, devEffectivePnlStress: c.effectivePnlStress, devEffectivePfStress: c.effectivePfStress,
}))))

const shareRows = (map) => [...map.values()].map((r) => ({
  ...r,
  basePositiveShare: r.sets ? r.basePositive / r.sets : 0,
  effectivePositiveShare: r.sets ? r.effectivePositive / r.sets : 0,
}))
const symbols = shareRows(perSymbol).sort((a, b) => b.effectivePnl - a.effectivePnl)
const types = shareRows(perType).sort((a, b) => b.effectivePositiveShare - a.effectivePositiveShare)
const pooled = (net, loss) => (loss === 0 ? (net > 0 ? Infinity : null) : net / loss)
const pooledBase = pooled(totals.baseNet, totals.baseLoss)
const pooledEffective = pooled(totals.effectiveNet, totals.effectiveLoss)
const bothPct = pairsTotal ? (100 * pairedBothPositive / pairsTotal).toFixed(2) : "0"

const compact = {
  title, runDir: path.basename(runDir), sourceSha256: summary.sourceSha256, engineSourceSha256: summary.engineSourceSha256,
  window: { start: new Date(summary.start).toISOString(), endExclusive: new Date(summary.endExclusive).toISOString() },
  dimensions: summary.dimensions, evaluatedSets: summary.evaluatedSets, validSets: summary.validSets, blockLanes: summary.blockLanes,
  validBlockLanes: summary.validBlockLanes, tradeObservations: summary.tradeObservations, elapsedMs: summary.elapsedMs,
  rules: { minTrades: MIN_TRADES, maxDrawdownTimeMin: MAX_DDT_MIN, baseCost, stressCost },
  rowsVisited: rowsTotal, configurationPairs: pairsTotal, positiveBaseCost: baseCostPositive, positiveStressCost: stressCostPositive,
  positiveBothCosts: pairedBothPositive, validatedCandidates,
  pooledBase: { profitFactor: pooledBase, net: totals.baseNet, loss: totals.baseLoss },
  pooledEffective: { profitFactor: pooledEffective, net: totals.effectiveNet, loss: totals.effectiveLoss },
  symbols,
  strategyDirections: types,
  pfBuckets: Object.fromEntries(Object.entries(pfBuckets).map(([k, m]) => [k, Object.fromEntries(BUCKETS.map((b) => [b, m.get(b) || 0]))])),
  topValidatedCandidates: candidates.slice(0, 25),
  topNearMisses: nearMisses.slice(0, 25),
  limitations: summary.limitations,
  defaultsPromoted: false,
  independentHoldout: false,
}
mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, "summary.json"), JSON.stringify(compact, null, 2))

// ---- HTML -------------------------------------------------------------------
const barChart = (items, { label, value, format = (v) => fmt(v), color = "#2563eb", width = 760, height = 260 }) => {
  const pad = 36
  const bw = (width - pad * 2) / Math.max(1, items.length)
  const top = Math.max(1e-9, ...items.map((i) => Math.abs(value(i) || 0)))
  const scale = (v) => (height - 50) * (Math.abs(v || 0) / top)
  return `<svg viewBox="0 0 ${width} ${height}" role="img" class="chart">${items.map((item, i) => {
    const v = value(item) || 0
    const h = scale(v)
    const x = pad + i * bw + 4
    return `<g><rect x="${x}" y="${height - 30 - h}" width="${bw - 8}" height="${h}" fill="${v < 0 ? "#dc2626" : color}"><title>${esc(label(item))}: ${esc(format(v))}</title></rect><text x="${x + (bw - 8) / 2}" y="${height - 14}" font-size="9" text-anchor="middle">${esc(String(label(item)).slice(0, 12))}</text></g>`
  }).join("")}<line x1="${pad}" x2="${width - pad}" y1="${height - 30}" y2="${height - 30}" stroke="#94a3b8"/></svg>`
}
const histogram = () => {
  const width = 760, height = 260, pad = 36
  const bw = (width - pad * 2) / BUCKETS.length
  const max = Math.max(1, ...BUCKETS.map((b) => Math.max(pfBuckets.base.get(b) || 0, pfBuckets.effective.get(b) || 0)))
  return `<svg viewBox="0 0 ${width} ${height}" class="chart">${BUCKETS.map((b, i) => {
    const x = pad + i * bw
    const bh = (height - 60) * ((pfBuckets.base.get(b) || 0) / max)
    const eh = (height - 60) * ((pfBuckets.effective.get(b) || 0) / max)
    return `<g><rect x="${x + 2}" y="${height - 30 - bh}" width="${bw / 2 - 3}" height="${bh}" fill="#64748b"><title>Base-lane PF ${b}: ${count(pfBuckets.base.get(b))}</title></rect><rect x="${x + bw / 2}" y="${height - 30 - eh}" width="${bw / 2 - 3}" height="${eh}" fill="#2563eb"><title>Block-lane PF ${b}: ${count(pfBuckets.effective.get(b))}</title></rect><text x="${x + bw / 2}" y="${height - 14}" font-size="10" text-anchor="middle">${esc(b)}</text></g>`
  }).join("")}<line x1="${pad}" x2="${width - pad}" y1="${height - 30}" y2="${height - 30}" stroke="#94a3b8"/></svg>`
}
const table = (headers, rows) => `<div class="scroll"><table class="sortable"><thead><tr>${headers.map((h, i) => `<th data-col="${i}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
const candidateHeaders = ["Symbol", "Strategy", "Dir", "TF", "Entry", "Exit", "Trail", "Block", "Trades", "Eff. PnL base", "Eff. PF base", "Eff. PnL stress", "Eff. PF stress", "DDT min"]
const candidateRows = (list) => list.slice(0, 25).map((c) => [esc(c.symbol), esc(c.strategyType), esc(c.direction), esc(c.timeframe), esc(c.entryTactic), esc(c.exitTactic), esc(c.trailingMode), esc(c.blockCount), count(c.trades), fmt(c.effectivePnlBase, 3), fmt(c.effectivePfBase), fmt(c.effectivePnlStress, 3), fmt(c.effectivePfStress), fmt(c.ddtMin, 0)])
const css = `:root{--bg:#f8fafc;--fg:#0f172a;--muted:#475569;--card:#fff;--line:#e2e8f0;--accent:#2563eb;--bad:#dc2626}@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b1220;--fg:#e2e8f0;--muted:#94a3b8;--card:#111a2e;--line:#1e293b;--accent:#60a5fa;--bad:#f87171}}:root[data-theme="dark"]{--bg:#0b1220;--fg:#e2e8f0;--muted:#94a3b8;--card:#111a2e;--line:#1e293b;--accent:#60a5fa;--bad:#f87171}body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}.banner{border:1px solid var(--bad);color:var(--bad);padding:10px 12px;border-radius:6px;margin:12px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin:10px 0}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}.kpi b{display:block;font-size:20px}.kpi span{color:var(--muted);font-size:12px}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;white-space:nowrap}th{cursor:pointer;color:var(--muted)}.chart{width:100%;height:auto;color:var(--fg)}.chart text{fill:var(--muted)}.legend,.muted{color:var(--muted);font-size:12px}code{font-size:12px}@media (max-width:600px){body{padding:12px}}`
const js = `document.querySelectorAll('table.sortable th').forEach(th=>th.addEventListener('click',()=>{const t=th.closest('table');const i=+th.dataset.col;const rows=[...t.tBodies[0].rows];const asc=th.dataset.asc!=='1';th.dataset.asc=asc?'1':'0';rows.sort((a,b)=>{const x=a.cells[i].textContent,y=b.cells[i].textContent;const nx=parseFloat(x),ny=parseFloat(y);return (isNaN(nx)||isNaN(ny))?(asc?x.localeCompare(y):y.localeCompare(x)):(asc?nx-ny:ny-nx)});rows.forEach(r=>t.tBodies[0].appendChild(r))}));`
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head><body>
<h1>${esc(title)}</h1>
<div class="muted">Window ${esc(compact.window.start.slice(0, 10))} → ${esc(compact.window.endExclusive.slice(0, 10))} (14 complete UTC days) · ${summary.dimensions.symbols.length} symbols · source sha256 <code>${esc(String(summary.sourceSha256).slice(0, 16))}</code> · engine sha256 <code>${esc(String(summary.engineSourceSha256).slice(0, 16))}</code></div>
<div class="banner"><b>Replay only.</b> Public BingX candles, no credentials, no orders, no connection to any live system. Not an independent holdout: this window was already touched by earlier analysis. No default was changed or promoted.</div>
<h2>Headline</h2>
<div class="card kpis">
<div class="kpi"><b>${count(compact.evaluatedSets)}</b><span>configurations evaluated</span></div>
<div class="kpi"><b>${count(compact.validSets)}</b><span>valid under the system rules</span></div>
<div class="kpi"><b>${count(pairsTotal)}</b><span>configurations at base cost ${baseCost}%</span></div>
<div class="kpi"><b>${count(baseCostPositive)}</b><span>positive at base cost (Block on)</span></div>
<div class="kpi"><b>${count(stressCostPositive)}</b><span>positive at stress cost ${stressCost}% (Block on)</span></div>
<div class="kpi"><b>${count(pairedBothPositive)} (${bothPct}%)</b><span>positive at both costs</span></div>
<div class="kpi"><b>${count(validatedCandidates)}</b><span>in-sample survivors: positive at both costs, ≥${MIN_TRADES} trades, DDT ≤ ${MAX_DDT_MIN} min</span></div>
<div class="kpi"><b>${fmt(pooledBase)} → ${fmt(pooledEffective)}</b><span>pooled PF, Block off → Block on (all rows, not a portfolio)</span></div>
</div>
<p class="legend">Pooled PF sums every evaluated row, so it is not a portfolio result; it only shows whether Block changes the aggregate direction. Costs: each configuration was evaluated at ${baseCost}% and ${stressCost}% position cost.</p>
<h2>In-sample survivors: positive at both costs with the trade and DDT rules (not validated; see the holdout check)</h2>
${candidates.length ? table(candidateHeaders, candidateRows(candidates)) : `<div class="card">None. No configuration is positive at both costs with the trade and drawdown rules applied to this window.</div>`}
<h2>Near misses (positive at base cost, not validated) — diagnostic only</h2>
${nearMisses.length ? table(candidateHeaders, candidateRows(nearMisses)) : `<div class="card">No configuration is positive at base cost.</div>`}
<h2>Profit-factor distribution across configurations</h2>
<div class="legend">Grey: Base lane (no Block). Blue: effective Block lane.</div>
<div class="card">${histogram()}</div>
<h2>Symbols (sums over all configurations of each symbol)</h2>
<div class="card">${barChart(symbols, { label: (r) => r.key, value: (r) => r.effectivePnl, format: (v) => fmt(v, 1) })}</div>
${table(["Symbol", "Configurations", "Positive base lane", "Positive Block lane", "Block-positive share", "Best Block-lane PF", "Best Block-lane PnL", "Sum Block-lane PnL"], symbols.map((r) => [esc(r.key), count(r.sets), count(r.basePositive), count(r.effectivePositive), (100 * r.effectivePositiveShare).toFixed(2) + "%", fmt(r.bestEffectivePf), fmt(r.bestEffectivePnl, 3), fmt(r.effectivePnl, 1)]))}
<h2>Strategy type × direction</h2>
${table(["Strategy · direction", "Configurations", "Positive base lane", "Positive Block lane", "Block-positive share", "Sum Block-lane PnL"], types.map((r) => [esc(r.key.replace("|", " · ")), count(r.sets), count(r.basePositive), count(r.effectivePositive), (100 * r.effectivePositiveShare).toFixed(2) + "%", fmt(r.effectivePnl, 1)]))}
<h2>Configuration dimensions and coverage</h2>
<div class="card"><table><tbody>
<tr><th>Symbols</th><td>${esc(summary.dimensions.symbols.join(", "))}</td></tr>
<tr><th>Timeframe sets</th><td>${esc(summary.dimensions.timeframeCombinations.map((t) => t.join("+")).join(" · "))}</td></tr>
<tr><th>Directions · entry · exit tactics</th><td>${esc(summary.dimensions.directions.join(", "))} · ${esc(summary.dimensions.entryTactics.join(", "))} · ${esc(summary.dimensions.exitTactics.join(", "))}</td></tr>
<tr><th>Strategy plans run</th><td>${esc(summary.dimensions.plans.map((p) => p.strategyType).join(", "))}${summary.dimensions.includeDca ? "" : " (DCA excluded: DCA disabled)"}</td></tr>
<tr><th>Take-profit (%)</th><td>${esc(summary.dimensions.takeProfitPercent.join(", "))}</td></tr>
<tr><th>Position cost (%)</th><td>${esc(summary.dimensions.positionCostPercent.join(", "))} (base ${baseCost}, stress ${stressCost})</td></tr>
<tr><th>Block (Block on)</th><td>counts ${esc(summary.dimensions.blockCounts.join(", "))} · volume ratios ${esc(summary.dimensions.blockVolumeRatios.join(", "))} · increment steps ${esc(summary.dimensions.blockIncrementSteps.join(", "))}</td></tr>
<tr><th>Connection volume factor (requested)</th><td>${esc(summary.dimensions.volumeFactor)}: notional multiplier ${esc((summary.dimensions.volumeFactor * 0.2).toFixed(3))} (system multiplier 0.2). PF is not affected; USDT PnL and drawdown scale with notional. The Direct default factor in code is 0.1.</td></tr>
<tr><th>Recent-position window · DDT rule</th><td>${esc(summary.dimensions.recentPositionWindow)} positions · ${esc(summary.dimensions.maxDrawdownTimeMin)} min (system default)</td></tr>
</tbody></table></div>
<h2>Limitations</h2>
<div class="card"><ul>${[...summary.limitations, "Take-profit grid covers 0.5% and 1% only. The system grid is PositionCost ratios 2–22 (step 3), which is wider; a wider grid was not run here.", "Symbols were selected by 24h volume at fetch time, which biases the universe toward currently liquid symbols; the window is not a random sample.", "The window 2026-10-07 to 2026-10-20 overlaps the 2026-10-07 analyses already in the repository; this is a single evaluation with no parameter selection, not an independent holdout."].map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>
<p class="muted">Click a table header to sort. Summary JSON: <code>summary.json</code> next to this file.</p>
<script>${js}</script></body></html>`
writeFileSync(path.join(reportDir, "report.html"), html)
console.log(JSON.stringify({ reportDir, rowsVisited: rowsTotal, configurationPairs: pairsTotal, positiveBaseCost: baseCostPositive, positiveStressCost: stressCostPositive, positiveBothCosts: pairedBothPositive, validatedCandidates, pooledBase, pooledEffective }))
