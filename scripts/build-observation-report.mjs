#!/usr/bin/env node

/**
 * Builds a self-contained HTML report (inline SVG charts, no external assets)
 * from the output directory of scripts/run-engine-observation.mjs.
 *
 *   node scripts/build-observation-report.mjs <observation-dir> <report-dir> [--title "..."]
 *
 * Writes report.html, summary.json and SHA256SUMS into <report-dir>. The
 * figures are paper (simulated) results of one observation window: they are
 * a functional and stability result, not an independent validation of
 * strategy defaults.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { execFileSync } from "node:child_process"

const [inputDir, reportDir] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
if (!inputDir || !reportDir) {
  console.error("usage: build-observation-report.mjs <observation-dir> <report-dir> [--title TEXT]")
  process.exit(2)
}
const titleArg = process.argv.indexOf("--title")
const title = titleArg > 0 ? process.argv[titleArg + 1] : "CTS-K-N engine observation"

const readJson = (name, fallback = null) => {
  const file = path.join(inputDir, name)
  if (!existsSync(file)) return fallback
  try { return JSON.parse(readFileSync(file, "utf8")) } catch { return fallback }
}
const readLines = (name) => {
  const file = path.join(inputDir, name)
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

const run = readJson("run.json", {})
const summaryIn = readJson("summary.json", {})
const events = readLines("events.jsonl")
const samples = readLines("samples.jsonl")
const trades = readJson("simulated-trades.json", [])
const statsFinal = readJson("stats-final.json", {})
const statsAfterPrehistoric = readJson("stats-after-prehistoric.json", {})
const coverageFinal = readJson("coverage-final.json", {})

const revision = (() => {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() } catch { return "unknown" }
})()

// ───────────────────────────── trade figures ─────────────────────────────
const finite = (value) => typeof value === "number" && Number.isFinite(value)
const closed = (Array.isArray(trades) ? trades : [])
  .map((row) => ({ ...row, realizedPnl: Number(row.realizedPnl), closedAt: Number(row.closedAt), openedAt: Number(row.openedAt) }))
  .filter((row) => finite(row.realizedPnl) && row.closedAt > 0)
  .sort((a, b) => a.closedAt - b.closedAt)

function book(rows) {
  let gp = 0, gl = 0, wins = 0, losses = 0, net = 0, fees = 0, gross = 0
  for (const row of rows) {
    const pnl = row.realizedPnl
    net += pnl
    fees += Number(row.fees) || 0
    gross += finite(Number(row.grossPnl)) ? Number(row.grossPnl) : pnl
    if (pnl > 0) { wins++; gp += pnl } else if (pnl < 0) { losses++; gl -= pnl }
  }
  let peak = 0, equity = 0, maxDrawdown = 0
  for (const row of rows) {
    equity += row.realizedPnl
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, peak - equity)
  }
  const byHour = new Map()
  for (const row of rows) {
    const hour = Math.floor(row.closedAt / 3_600_000)
    byHour.set(hour, (byHour.get(hour) || 0) + row.realizedPnl)
  }
  const hourNets = [...byHour.values()]
  const decisive = wins + losses
  return {
    trades: rows.length,
    wins,
    losses,
    net,
    gross,
    fees,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : null,
    winRate: decisive > 0 ? (wins / decisive) * 100 : null,
    expectancy: rows.length > 0 ? net / rows.length : null,
    avgWin: wins > 0 ? gp / wins : null,
    avgLoss: losses > 0 ? -gl / losses : null,
    maxDrawdown,
    activeHours: hourNets.length,
    profitableHours: hourNets.filter((value) => value > 0).length,
    byHour,
  }
}

const setType = (row) => {
  const key = String(row.setKey || row.parentSetKey || "")
  const parts = key.split("#")[0].split(":")
  return parts.length >= 2 ? parts[1] : String(row.indicationType || "unknown")
}
const setVariant = (row) => {
  const key = String(row.setKey || "")
  const tags = key.split("#").slice(1).map((tag) => tag.split(":")[0]).filter((tag) => !tag.startsWith("row_"))
  return String(row.setVariant || "") || (tags.length > 0 ? tags.join("+") : "default")
}
const holdBucket = (row) => {
  const minutes = row.openedAt > 0 ? (row.closedAt - row.openedAt) / 60_000 : NaN
  if (!finite(minutes)) return "unknown"
  if (minutes < 1) return "< 1 min"
  if (minutes < 5) return "1–5 min"
  if (minutes < 30) return "5–30 min"
  if (minutes < 120) return "30 min–2 h"
  return "≥ 2 h"
}
const groupBooks = (keyOf) => {
  const groups = new Map()
  for (const row of closed) {
    const key = keyOf(row) || "unknown"
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return [...groups].map(([key, rows]) => ({ key, ...book(rows) })).sort((a, b) => b.trades - a.trades)
}

const total = book(closed)
const bySymbol = groupBooks((row) => row.symbol)
const byType = groupBooks(setType)
const byVariant = groupBooks(setVariant)
const byDirection = groupBooks((row) => row.direction)
const byIntent = groupBooks((row) => row.executionIntent || "main")
const byHold = groupBooks(holdBucket)

// ───────────────────────────── run figures ─────────────────────────────
const prehistoricEvent = events.find((event) => event.type === "prehistoric_complete")
const failedEvent = events.find((event) => event.type === "failed" || event.type === "bootstrap_timeout")
const realtimeSamples = samples.filter((sample) => sample.realtimeMs > 0)
const httpFailures = samples.flatMap((sample) => Object.entries(sample.http || {})
  .filter(([, value]) => value && value.status !== 200)
  .map(([name, value]) => ({ at: sample.at, name, status: value.status })))
const coverageSamples = samples.filter((sample) => sample.coverage)
const coverageErrors = coverageSamples.reduce((sum, sample) => sum + (Number(sample.coverage.errors) || 0), 0) + (Number(coverageFinal?.errors) || 0)
const coverageFindings = [
  ...coverageSamples.flatMap((sample) => (sample.coverage.findings || []).map((finding) => ({ at: sample.at, ...finding }))),
  ...((coverageFinal?.findings || []).map((finding) => ({ at: "final", ...finding }))),
]
const maxOf = (values) => values.filter(finite).reduce((max, value) => Math.max(max, value), -Infinity)
const stageMax = Object.fromEntries(["base", "main", "real", "live"].map((stage) => [
  stage,
  maxOf(realtimeSamples.map((sample) => Number(sample.stats?.stages?.[stage]?.evaluated))),
]))
const percentile = (values, p) => {
  const sorted = values.filter(finite).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}
const statsLatencyP95 = percentile(realtimeSamples.map((sample) => sample.http?.stats?.ms), 95)
const rssValues = realtimeSamples.map((sample) => sample.rssMb).filter(finite)
const rssGrowth = rssValues.length > 1 ? rssValues[rssValues.length - 1] - rssValues[0] : null
const rssPeak = rssValues.length > 0 ? Math.max(...rssValues) : null
const engineStopped = realtimeSamples.filter((sample) => sample.engineRunning === false).length
const prehistoric = prehistoricEvent?.prehistoric || statsAfterPrehistoric?.historic || {}
const symbolsTotal = Array.isArray(run.symbols) ? run.symbols.length : null
const marketDataSources = prehistoricEvent?.marketData && typeof prehistoricEvent.marketData === "object" ? prehistoricEvent.marketData : {}
const sourceNames = Object.values(marketDataSources).map((entry) => String(entry?.source ?? "none"))
// The coverage figure is written with the run's last-run metadata, which can
// land just after the completion flag the harness reacts to.
const coverageHours = Number(statsAfterPrehistoric?.historic?.dataCoverageHours ?? statsFinal?.historic?.dataCoverageHours)
const historicProcessed = Number(prehistoric.processed ?? prehistoric.symbolsProcessed) || 0
const historicTotal = Number(prehistoric.total ?? prehistoric.symbolsTotal) || symbolsTotal || 0

const criteria = [
  {
    // The runtime may add its mandatory symbols to a smaller request, so the
    // engine's own total is the reference; it must cover the request.
    name: "Prehistoric bootstrap completed for every symbol",
    pass: Boolean(prehistoricEvent) && historicProcessed > 0 && historicProcessed >= historicTotal && historicTotal >= (symbolsTotal ?? 0),
    detail: prehistoricEvent
      ? `${historicProcessed}/${historicTotal} symbols (${symbolsTotal ?? "—"} requested) after ${fmtDuration(prehistoricEvent.afterMs)}`
      : "not completed",
  },
  {
    name: "Prehistoric range covered by real market data",
    pass: run.marketDataMode === "synthetic"
      ? false
      : sourceNames.length > 0 && sourceNames.every((name) => name !== "synthetic" && name !== "none" && name !== "null") &&
        finite(coverageHours) && coverageHours >= 0.95 * Number(run.prehistoricHours || 0),
    detail: `${finite(coverageHours) ? coverageHours.toFixed(2) : "—"} of ${run.prehistoricHours ?? "—"} h with data; sources ${[...new Set(sourceNames)].join(", ") || "—"}` +
      (run.marketDataMode === "synthetic" ? " (synthetic fixture run)" : ""),
  },
  {
    name: "Every stage evaluated Sets in the realtime phase",
    pass: ["base", "main", "real", "live"].every((stage) => stageMax[stage] > 0),
    detail: Object.entries(stageMax).map(([stage, value]) => `${stage} ${finite(value) ? value : "—"}`).join(" · "),
  },
  { name: "Paper positions opened and closed", pass: total.trades > 0, detail: `${total.trades} closed paper trades` },
  { name: "No coverage errors (failed/slow endpoints, NaN, duplicate ids, stage 0)", pass: coverageErrors === 0, detail: `${coverageErrors} error finding(s) in ${coverageSamples.length + 1} checks` },
  { name: "Stats, overview and status endpoints answered 200", pass: httpFailures.length === 0, detail: `${httpFailures.length} failed request(s) in ${samples.length} polls` },
  { name: "Engine kept running", pass: engineStopped === 0 && !failedEvent, detail: failedEvent ? `${failedEvent.type}: ${failedEvent.error || ""}` : `${engineStopped} poll(s) without a running engine` },
  { name: "Memory bounded (RSS growth < 1 GiB in the realtime phase)", pass: rssGrowth === null || rssGrowth < 1024, detail: rssGrowth === null ? "no samples" : `growth ${rssGrowth} MiB, peak ${rssPeak} MiB` },
  { name: "Statistics latency p95 < 5 s", pass: statsLatencyP95 === null || statsLatencyP95 < 5_000, detail: statsLatencyP95 === null ? "no samples" : `${statsLatencyP95} ms` },
]
const passed = criteria.every((criterion) => criterion.pass)

// ───────────────────────────── formatting ─────────────────────────────
function fmtDuration(ms) {
  if (!finite(ms)) return "—"
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  const minutes = Math.round(ms / 60_000)
  return minutes >= 90 ? `${(minutes / 60).toFixed(1)} h` : `${minutes} min`
}
const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char])
const fmt = (value, digits = 2) => (value === Infinity ? "∞" : finite(value) ? value.toFixed(digits) : "—")
const signed = (value, digits = 2) => (finite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(digits)}` : "—")
const tone = (value) => (finite(value) ? (value > 0 ? "pos" : value < 0 ? "neg" : "") : "")

function bookTable(rows, label) {
  if (rows.length === 0) return `<p class="muted">No closed paper trade.</p>`
  const body = rows.map((row) => `<tr><td>${esc(row.key)}</td><td>${row.trades}</td><td>${row.wins}/${row.losses}</td>` +
    `<td>${fmt(row.winRate, 1)}%</td><td>${fmt(row.profitFactor)}</td><td class="${tone(row.net)}">${signed(row.net, 4)}</td>` +
    `<td>${signed(row.expectancy, 4)}</td><td>${fmt(row.maxDrawdown, 4)}</td><td>${row.profitableHours}/${row.activeHours}</td></tr>`).join("")
  return `<table><thead><tr><th>${esc(label)}</th><th>Trades</th><th>W/L</th><th>Win rate</th><th>PF</th><th>Net</th><th>Expectancy</th><th>Max DD</th><th>Profitable hours</th></tr></thead><tbody>${body}</tbody></table>`
}

function lineChart({ series, height = 240, yLabel = "" }) {
  const width = 1100, left = 64, right = 16, top = 12, bottom = 34
  const points = series.flatMap((s) => s.points)
  if (points.length < 2) return `<p class="muted">Not enough samples for a chart.</p>`
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1])
  const xMin = Math.min(...xs), xMax = Math.max(...xs)
  let yMin = Math.min(0, ...ys), yMax = Math.max(...ys)
  if (yMax === yMin) yMax = yMin + 1
  const sx = (x) => left + ((x - xMin) / Math.max(1, xMax - xMin)) * (width - left - right)
  const sy = (y) => top + (1 - (y - yMin) / (yMax - yMin)) * (height - top - bottom)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => yMin + t * (yMax - yMin))
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => xMin + t * (xMax - xMin))
  const grid = ticks.map((y) => `<line x1="${left}" x2="${width - right}" y1="${sy(y)}" y2="${sy(y)}" stroke="#e3e9f1"/><text class="axis" x="${left - 6}" y="${sy(y) + 4}" text-anchor="end">${fmt(y, Math.abs(yMax - yMin) < 10 ? 2 : 0)}</text>`).join("")
  const xAxis = xTicks.map((x) => `<text class="axis" x="${sx(x)}" y="${height - 12}" text-anchor="middle">${new Date(x).toISOString().slice(11, 16)}</text>`).join("")
  const zero = yMin < 0 && yMax > 0 ? `<line x1="${left}" x2="${width - right}" y1="${sy(0)}" y2="${sy(0)}" stroke="#91a4bc" stroke-dasharray="4 3"/>` : ""
  const lines = series.filter((s) => s.points.length > 0).map((s) =>
    `<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${s.points.map((p) => `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(" ")}"><title>${esc(s.name)}</title></polyline>`).join("")
  const legend = `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}${yLabel ? `<span>${esc(yLabel)}</span>` : ""}</div>`
  return `<div class="chart">${legend}<svg viewBox="0 0 ${width} ${height}" role="img">${grid}${zero}${xAxis}${lines}</svg></div>`
}

function hourBars(byHour) {
  const entries = [...byHour].sort((a, b) => a[0] - b[0])
  if (entries.length === 0) return `<p class="muted">No closed paper trade.</p>`
  const width = 1100, height = 220, left = 64, right = 16, top = 12, bottom = 34
  const values = entries.map(([, value]) => value)
  const max = Math.max(...values.map(Math.abs), 1e-9)
  const band = (width - left - right) / entries.length
  const mid = top + (height - top - bottom) / 2
  const scale = (height - top - bottom) / 2 / max
  const bars = entries.map(([hour, value], index) => {
    const h = Math.abs(value) * scale
    const y = value >= 0 ? mid - h : mid
    return `<rect x="${(left + index * band + band * 0.15).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, band * 0.7).toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" fill="${value >= 0 ? "#0b8f5f" : "#c0362c"}"><title>${new Date(hour * 3_600_000).toISOString().slice(0, 13)}:00 UTC ${signed(value, 4)}</title></rect>`
  }).join("")
  const labels = entries.map(([hour], index) => index % Math.max(1, Math.ceil(entries.length / 12)) === 0
    ? `<text class="axis" x="${(left + index * band + band / 2).toFixed(1)}" y="${height - 12}" text-anchor="middle">${new Date(hour * 3_600_000).toISOString().slice(11, 13)}h</text>` : "").join("")
  return `<div class="chart"><div class="legend"><span><i style="background:#0b8f5f"></i>profitable hour</span><span><i style="background:#c0362c"></i>losing hour</span><span>net per UTC hour</span></div><svg viewBox="0 0 ${width} ${height}"><line x1="${left}" x2="${width - right}" y1="${mid}" y2="${mid}" stroke="#91a4bc"/><text class="axis" x="${left - 6}" y="${top + 8}" text-anchor="end">${fmt(max, 3)}</text><text class="axis" x="${left - 6}" y="${height - bottom}" text-anchor="end">${fmt(-max, 3)}</text>${bars}${labels}</svg></div>`
}

const t = (sample) => Date.parse(sample.at)
const stageSeries = ["base", "main", "real", "live"].map((stage, index) => ({
  name: `${stage} evaluated`,
  color: ["#2563eb", "#d97706", "#059669", "#dc2626"][index],
  points: samples.filter((s) => finite(Number(s.stats?.stages?.[stage]?.evaluated))).map((s) => [t(s), Number(s.stats.stages[stage].evaluated)]),
}))
const openSeries = [
  { name: "pseudo open", color: "#7c3aed", points: samples.filter((s) => finite(Number(s.stats?.open?.pseudo))).map((s) => [t(s), Number(s.stats.open.pseudo)]) },
  { name: "paper (live stage) open", color: "#dc2626", points: samples.filter((s) => finite(Number(s.stats?.open?.live))).map((s) => [t(s), Number(s.stats.open.live)]) },
]
let equity = 0
const equityPoints = closed.map((row) => { equity += row.realizedPnl; return [row.closedAt, equity] })
let peak = 0
const drawdownPoints = equityPoints.map(([x, y]) => { peak = Math.max(peak, y); return [x, y - peak] })
const memorySeries = [
  { name: "server RSS MiB", color: "#2563eb", points: samples.filter((s) => finite(s.rssMb)).map((s) => [t(s), s.rssMb]) },
  { name: "Redis used MiB", color: "#059669", points: samples.filter((s) => finite(s.redis?.usedMb)).map((s) => [t(s), s.redis.usedMb]) },
]
const latencySeries = ["stats", "overview", "status"].map((name, index) => ({
  name: `${name} ms`,
  color: ["#2563eb", "#d97706", "#7c3aed"][index],
  points: samples.filter((s) => finite(s.http?.[name]?.ms) && s.http[name].ms > 0).map((s) => [t(s), s.http[name].ms]),
}))

// Configuration dimensions: what the run could produce vs. what traded.
const variantsFinal = statsFinal?.strategyVariants || {}
const dimensionRows = [
  ["Set type", byType.map((row) => row.key)],
  ["Variant", byVariant.map((row) => row.key)],
  ["Direction", byDirection.map((row) => row.key)],
  ["Execution intent", byIntent.map((row) => row.key)],
  ["Symbols", bySymbol.map((row) => row.key)],
]
const symbolsWithoutTrades = (run.symbols || []).filter((symbol) => !bySymbol.some((row) => row.key === symbol))
const variantNames = Object.keys(variantsFinal)
const variantsWithoutTrades = variantNames.filter((name) => !byVariant.some((row) => row.key.includes(name)))

const cards = [
  ["Verdict", passed ? "PASS" : "FAIL"],
  ["Prehistoric window", `${run.prehistoricHours ?? "—"} h · ${symbolsTotal ?? "—"} symbols`],
  ["Prehistoric done after", prehistoricEvent ? fmtDuration(prehistoricEvent.afterMs) : "—"],
  ["Historic PF (n)", `${fmt(Number(prehistoric.profitFactor ?? statsAfterPrehistoric?.prehistoricMeta?.historicAvgProfitFactor))} (${prehistoric.profitFactorCount ?? statsAfterPrehistoric?.prehistoricMeta?.historicAvgProfitFactorCount ?? "—"})`],
  ["Realtime observed", fmtDuration(summaryIn.realtimeObservedMs)],
  ["Paper trades closed", String(total.trades)],
  ["Paper PF", fmt(total.profitFactor)],
  ["Win rate", `${fmt(total.winRate, 1)}%`],
  ["Net (paper)", signed(total.net, 4)],
  ["Max drawdown", fmt(total.maxDrawdown, 4)],
  ["Profitable hours", `${total.profitableHours}/${total.activeHours}`],
  ["RSS growth / peak", `${rssGrowth ?? "—"} / ${rssPeak ?? "—"} MiB`],
]

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{--bg:#f4f7fb;--card:#fff;--ink:#142238;--muted:#5b6b82;--line:#dbe4ee;--ok:#087f5b;--warn:#a15c00;--red:#b42318}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1180px;margin:28px auto;padding:0 16px}h1{margin-bottom:4px}h2{margin-top:28px;border-bottom:2px solid var(--line);padding-bottom:6px}.muted{color:var(--muted)}.banner{padding:14px 18px;border-radius:12px;font-weight:650}.banner.pass{background:#e9f8f1;border:1px solid #86d8b5;color:var(--ok)}.banner.fail{background:#fdecea;border:1px solid #f5a8a0;color:var(--red)}.cardgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:16px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}.value{font-size:22px;font-weight:700}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);margin:10px 0 18px;font-size:14px}th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#edf3f9}.pos{color:var(--ok)}.neg{color:var(--red)}.ok{color:var(--ok);font-weight:650}.bad{color:var(--red);font-weight:650}.chart{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px;margin:12px 0}svg{width:100%;height:auto;display:block}.axis{fill:var(--muted);font-size:11px}.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:13px;padding:2px 6px 6px}.legend i{display:inline-block;width:12px;height:4px;margin-right:5px;vertical-align:middle;border-radius:3px}.note{color:var(--muted);background:#f8fafc;border-left:4px solid #91a4bc;padding:9px 12px;margin:10px 0}.scroll{overflow-x:auto}code{background:#eef2f7;padding:1px 4px;border-radius:4px}
@media (prefers-color-scheme: dark){:root{--bg:#0f1622;--card:#162131;--ink:#e6edf6;--muted:#9fb0c6;--line:#2a3a50}th{background:#1d2b3f}.note{background:#162131}code{background:#1d2b3f}}
</style></head><body><main>
<h1>${esc(title)}</h1>
<p class="muted">Connection <code>${esc(run.connectionId)}</code> · paper orders (FORCE_SIMULATED, no exchange credentials) · revision <code>${esc(revision)}</code> · started ${esc(run.startedAt)} · ${run.exactReplay ? "exact candle replay" : "realtime-bridge replay"}</p>
<div class="banner ${passed ? "pass" : "fail"}">${passed ? "PASS" : "FAIL"}: ${criteria.filter((c) => c.pass).length}/${criteria.length} acceptance criteria met.</div>
<div class="cardgrid">${cards.map(([label, value]) => `<div class="card"><div class="muted">${esc(label)}</div><div class="value">${esc(value)}</div></div>`).join("")}</div>
<div class="note">Paper results of one observation window with the system's default strategy thresholds. They show that the pipeline produces, books and reports trades consistently; they are <strong>not</strong> an independent validation of strategy defaults, and this window is not a holdout. Costs: realized PnL of a paper close already deducts the modelled PositionCost; <em>Fees</em> are the modelled fees recorded on the rows.</div>

<h2>Acceptance criteria</h2>
<table><thead><tr><th>Criterion</th><th>Result</th><th>Detail</th></tr></thead><tbody>${criteria.map((c) => `<tr><td>${esc(c.name)}</td><td class="${c.pass ? "ok" : "bad"}">${c.pass ? "pass" : "fail"}</td><td>${esc(c.detail)}</td></tr>`).join("")}</tbody></table>

<h2>Stage processing</h2>
${lineChart({ series: stageSeries, yLabel: "Sets evaluated (basket snapshot)" })}
${lineChart({ series: openSeries, yLabel: "open positions" })}

<h2>Paper results</h2>
${lineChart({ series: [{ name: "cumulative net", color: "#2563eb", points: equityPoints }, { name: "drawdown", color: "#c0362c", points: drawdownPoints }], yLabel: "settlement units" })}
${hourBars(total.byHour)}
<div class="scroll">${bookTable([{ key: "all", ...total }], "Scope")}</div>
<h3>By symbol</h3><div class="scroll">${bookTable(bySymbol, "Symbol")}</div>
<h3>By Set type</h3><div class="scroll">${bookTable(byType, "Set type")}</div>
<h3>By variant</h3><div class="scroll">${bookTable(byVariant, "Variant")}</div>
<h3>By direction</h3><div class="scroll">${bookTable(byDirection, "Direction")}</div>
<h3>By hold time</h3><div class="scroll">${bookTable(byHold, "Hold time")}</div>
<p class="muted">Costs: gross ${signed(total.gross, 4)} · fees ${fmt(total.fees, 4)} · net ${signed(total.net, 4)}.</p>

<h2>Configuration coverage</h2>
<table><thead><tr><th>Dimension</th><th>Traded values</th></tr></thead><tbody>${dimensionRows.map(([name, values]) => `<tr><td>${esc(name)}</td><td>${values.length > 0 ? values.map(esc).join(", ") : "—"}</td></tr>`).join("")}
<tr><td>Symbols without a closed trade</td><td>${symbolsWithoutTrades.length > 0 ? symbolsWithoutTrades.map(esc).join(", ") : "none"}</td></tr>
<tr><td>Variants created but not traded</td><td>${variantsWithoutTrades.length > 0 ? variantsWithoutTrades.map(esc).join(", ") : "none"}</td></tr></tbody></table>

<h2>Stability and performance</h2>
${lineChart({ series: memorySeries, yLabel: "MiB" })}
${lineChart({ series: latencySeries, yLabel: "response time ms" })}
<h3>Coverage findings</h3>
${coverageFindings.length === 0 ? `<p class="muted">None.</p>` : `<table><thead><tr><th>When</th><th>Severity</th><th>Area</th><th>Message</th></tr></thead><tbody>${coverageFindings.slice(0, 200).map((f) => `<tr><td>${esc(f.at)}</td><td>${esc(f.severity)}</td><td>${esc(f.area)}</td><td>${esc(f.message)}</td></tr>`).join("")}</tbody></table>`}
<h3>Failed requests</h3>
${httpFailures.length === 0 ? `<p class="muted">None.</p>` : `<table><thead><tr><th>When</th><th>Endpoint</th><th>Status</th></tr></thead><tbody>${httpFailures.slice(0, 200).map((f) => `<tr><td>${esc(f.at)}</td><td>${esc(f.name)}</td><td>${esc(f.status)}</td></tr>`).join("")}</tbody></table>`}

<h2>Run events</h2>
<table><thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead><tbody>${events.map((e) => `<tr><td>${esc(e.at)}</td><td>${esc(e.type)}</td><td><code>${esc(JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => k !== "at" && k !== "type"))).slice(0, 400))}</code></td></tr>`).join("")}</tbody></table>
</main></body></html>`

mkdirSync(reportDir, { recursive: true })
const summaryOut = {
  title,
  revision,
  connectionId: run.connectionId,
  symbols: run.symbols,
  prehistoricHours: run.prehistoricHours,
  exactReplay: run.exactReplay,
  startedAt: run.startedAt,
  passed,
  criteria: criteria.map(({ name, pass, detail }) => ({ name, pass, detail })),
  prehistoricCompleteAfterMs: prehistoricEvent?.afterMs ?? null,
  realtimeObservedMs: summaryIn.realtimeObservedMs ?? null,
  paper: { ...total, byHour: undefined, profitFactor: total.profitFactor === Infinity ? "Infinity" : total.profitFactor },
  bySymbol: bySymbol.map(({ byHour, ...row }) => ({ ...row, profitFactor: row.profitFactor === Infinity ? "Infinity" : row.profitFactor })),
  byType: byType.map(({ byHour, ...row }) => ({ ...row, profitFactor: row.profitFactor === Infinity ? "Infinity" : row.profitFactor })),
  coverageErrors,
  httpFailures: httpFailures.length,
  rssGrowthMb: rssGrowth,
  rssPeakMb: rssPeak,
  statsLatencyP95Ms: statsLatencyP95,
}
writeFileSync(path.join(reportDir, "report.html"), html)
writeFileSync(path.join(reportDir, "summary.json"), `${JSON.stringify(summaryOut, null, 2)}\n`)
const sums = ["report.html", "summary.json"].map((name) => {
  const hash = createHash("sha256").update(readFileSync(path.join(reportDir, name))).digest("hex")
  return `${hash}  ${name}`
}).join("\n")
writeFileSync(path.join(reportDir, "SHA256SUMS"), `${sums}\n`)
console.log(JSON.stringify({ report: path.join(reportDir, "report.html"), passed, trades: total.trades, profitFactor: summaryOut.paper.profitFactor }))
