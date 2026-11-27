#!/usr/bin/env node
/**
 * Renders the trade-window simulation (scripts/simulate-trade-window.ts) as a
 * Markdown report with one line per bucket and family, and a self-contained
 * HTML report with every table in full plus inline equity charts.
 *
 *   node scripts/render-trade-window-report.mjs <outDir>
 *
 * Reads <outDir>/trade-window-simulation.json and <outDir>/trade-window-series.json,
 * writes <outDir>/trade-window-report.md and <outDir>/trade-window-report.html.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const outDir = resolve(process.argv[2] || "reports/trade-window")
const report = JSON.parse(readFileSync(join(outDir, "trade-window-simulation.json"), "utf8"))
const series = JSON.parse(readFileSync(join(outDir, "trade-window-series.json"), "utf8"))
const FAMILIES = ["normal", "axis", "block", "trailing", "dca"]
const FAMILY_LABEL = { normal: "Normal", axis: "Axis", block: "Block", trailing: "Trailing", dca: "DCA" }

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch])
const num = (value, digits = 2) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(digits))
const usd = (value) => (value === null || value === undefined ? "—" : `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}`)
const pf = (p) => (!p ? "—" : p.infinite ? "∞" : p.value === null || p.value === undefined ? "—" : p.value.toFixed(3))
const pctOrDash = (value, digits = 1) => (value === null || value === undefined ? "—" : `${Number(value).toFixed(digits)}%`)
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ")
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16)

const bucketHours = report.window.bucketHours
const spanLabel = (hours, unit) => {
  const days = hours / 24
  if (hours % 24 === 0) return `${days} ${unit} ${days === 1 ? "day" : "days"}`
  return `${hours} ${unit} ${hours === 1 ? "hour" : "hours"}`
}
const tradeSpan = spanLabel(report.window.tradeHours, "trading")
const prehistSpan = spanLabel(report.window.prehistHours, "prehistory")
const buckets = report.buckets
const bucketCount = buckets.normal.length
const rangeLabel = (b) => `${stamp(b.fromMs)}–${hhmm(b.toMs)}`

function bucketLine(family, b) {
  const s = b.stats
  const c = b.cumulative
  const f = report.bucketFunnel?.[b.index]
  return [
    `${rangeLabel(b)} UTC`,
    `${FAMILY_LABEL[family]}`,
    f ? `candidates=${f.candidates}` : null,
    f ? `admitted=${f.admitted}` : null,
    f ? `gate:historyShort=${f.historyShort},pfBelowStage=${f.pfBelowStage}` : null,
    `opened=${s.opened}`,
    `closed=${s.closed}`,
    `open@end=${s.open}`,
    `W/L=${s.wins}/${s.losses}`,
    `win=${pctOrDash(s.winRatePct)}`,
    `net=${usd(s.netUsd)} USD`,
    `grossWin=${num(s.grossWinUsd, 2)} grossLoss=${num(s.grossLossUsd, 2)}`,
    `PF=${pf(s.profitFactor)}`,
    `avgNet=${num(s.avgNetPct, 3)}%`,
    `avgHold=${num(s.avgHoldMinutes, 1)}m`,
    `equity=${num(b.equityEnd, 2)}`,
    `balance=${num(b.balanceEnd, 2)}`,
    `DDmax=${num(b.maxDrawdownPct, 3)}%`,
    `DDend=${num(b.drawdownAtEndPct, 3)}%`,
    `openPeak=${b.openPeak}`,
    `exposurePeak=${num(b.exposurePeakUsd, 2)} USD`,
    `cumClosed=${c.closed}`,
    `cumNet=${usd(c.netUsd)} USD`,
    `cumPF=${pf(c.profitFactor)}`,
    `cumWin=${pctOrDash(c.winRatePct)}`,
  ].filter((part) => part !== null).join(" | ")
}

function mdTable(headers, rows) {
  const head = `| ${headers.join(" | ")} |`
  const sep = `| ${headers.map(() => "---").join(" | ")} |`
  const body = rows.map((r) => `| ${r.map((v) => String(v ?? "—").replace(/\|/g, "\\|")).join(" | ")} |`)
  return [head, sep, ...body].join("\n")
}

function htmlTable(headers, rows, cls = "") {
  const th = headers.map((h) => `<th>${esc(h)}</th>`).join("")
  const tr = rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v ?? "—")}</td>`).join("")}</tr>`).join("\n")
  return `<div class="scroll"><table class="${cls}"><thead><tr>${th}</tr></thead><tbody>\n${tr}\n</tbody></table></div>`
}

// ---------- shared row builders ----------
const familyRows = FAMILIES.map((f) => {
  const s = report.families[f]
  return [FAMILY_LABEL[f], s.positions, s.opened, s.closed, s.openAtEnd, s.openPeak, s.wins, s.losses, pctOrDash(s.winRatePct), usd(s.netUsd),
    pf(s.profitFactor), num(s.avgNetPct, 3), num(s.avgHoldMinutes, 1), num(s.endBalance, 2), num(s.endEquity, 2),
    num(s.peakEquity, 2), num(s.maxEquityDrawdownPct, 3), num(s.exposurePeakUsd, 2), num(s.exposureEndUsd, 2)]
})
const familyHeaders = ["Family", "Positions", "Opened", "Closed", "Open at end", "Open peak", "Wins", "Losses", "Win %", "Net USD", "PF",
  "Avg net %", "Avg hold min", "End balance", "End equity", "Peak equity", "Max equity DD %", "Exposure peak USD", "Exposure end USD"]

const bucketHeaders = ["#", "From UTC", "To UTC", "Candidates", "Admitted", "Gate: history short", "Gate: PF below", "Opened", "Closed", "Open at end", "Open peak", "Wins", "Losses", "Win %", "Net USD", "Gross win", "Gross loss", "PF", "Avg net %", "Avg hold min", "Equity end", "Balance end", "DD max %", "DD end %", "Exposure peak USD", "Cum closed", "Cum net USD", "Cum PF", "Cum win %"]
const bucketRowsFor = (family) => buckets[family].map((b) => {
  const s = b.stats, c = b.cumulative
  const f = report.bucketFunnel?.[b.index] || {}
  return [b.index + 1, stamp(b.fromMs), hhmm(b.toMs), f.candidates ?? "—", f.admitted ?? "—", f.historyShort ?? "—", f.pfBelowStage ?? "—",
    s.opened, s.closed, s.open, b.openPeak, s.wins, s.losses, pctOrDash(s.winRatePct), usd(s.netUsd),
    num(s.grossWinUsd, 2), num(s.grossLossUsd, 2), pf(s.profitFactor), num(s.avgNetPct, 3), num(s.avgHoldMinutes, 1),
    num(b.equityEnd, 2), num(b.balanceEnd, 2), num(b.maxDrawdownPct, 3), num(b.drawdownAtEndPct, 3), num(b.exposurePeakUsd, 2),
    c.closed, usd(c.netUsd), pf(c.profitFactor), pctOrDash(c.winRatePct)]
})

const symbolHeaders = ["Symbol", "OK", "Bars", "Expected", "Gap min", "Coverage %", "Pages", "Replay steps", "Engine signals", "Trade candidates", "Admitted", "Normal net %sum", "Normal PF", "DCA positions", "Fetch ms", "Replay ms", "DCA ms", "Bars SHA-256"]
const symbolRows = report.bySymbol.map((s) => [s.symbol, s.ok ? "yes" : "NO", s.barCount, s.expectedBars, s.gapMinutes, pctOrDash(s.coveragePct), s.pages,
  s.replaySteps, s.signals, s.candidatesTrade, s.admittedTrade, num(s.normalNetPctSum, 3), pf(s.normalPf), s.dcaPositions, s.fetchMs, s.replayMs, s.dcaMs, s.barsSha256 ? s.barsSha256.slice(0, 16) + "…" : "—"])

const typeHeaders = ["Indication type", "Enabled", "Signals (all)", "Signals (trade)", "Trade candidates", "Admitted", "Admitted net %sum", "Coordinates", "Coordinates with admission"]
const typeRows = report.indicationTypes.map((t) => [t.type, t.enabled ? "yes" : "no", t.signalsAll, t.signalsTrade, t.tradeCandidates, t.admitted, num(t.admittedNetPctSum, 3), t.coordinates, t.coordinatesWithAdmission])

const coordHeaders = ["Type", "Direction", "Rule", "Pre candidates", "Pre win %", "Trade candidates", "Trade win %", "Trade cand. net %sum", "Admitted", "Admitted net %sum", "Admitted net USD", "Gate: history short", "Gate: PF below stage", "Row PF mean", "Row PF max", "Row PF zero share"]
const coordRows = report.coordinates.map((c) => [c.type, c.direction, c.rule, c.preCandidates, pctOrDash(c.preWinRatePct), c.tradeCandidates, pctOrDash(c.tradeWinRatePct), num(c.tradeCandidateNetPctSum, 3), c.admitted, num(c.admittedNetPctSum, 3), num(c.admittedNetUsd, 4), c.gateHistoryShort, c.gatePfBelowStage, num(c.candidateRowPfMean, 3), num(c.candidateRowPfMax, 3), num(c.candidateRowPfZeroShare, 3)])

// ---------- charts (inline SVG, equity per family) ----------
function chartSvg(family) {
  const rows = series[family]
  if (!rows || rows.length === 0) return ""
  const W = 960, H = 200, PAD_L = 56, PAD_R = 12, PAD_T = 12, PAD_B = 26
  const step = Math.max(1, Math.floor(rows.length / 480))
  const pts = rows.filter((_, i) => i % step === 0 || i === rows.length - 1)
  const eq = pts.map((r) => r.equity)
  const start = report.startBalance
  const lo = Math.min(start, ...eq), hi = Math.max(start, ...eq)
  const span = hi - lo || 1
  const t0 = rows[0].t, t1 = rows[rows.length - 1].t
  const x = (t) => PAD_L + ((t - t0) / (t1 - t0 || 1)) * (W - PAD_L - PAD_R)
  const y = (v) => PAD_T + (1 - (v - lo) / span) * (H - PAD_T - PAD_B)
  const line = pts.map((r) => `${x(r.t).toFixed(1)},${y(r.equity).toFixed(1)}`).join(" ")
  const ticks = []
  for (let t = Math.ceil(t0 / 864e5) * 864e5; t <= t1; t += 864e5) ticks.push(t)
  const grid = ticks.map((t) => `<line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${PAD_T}" y2="${H - PAD_B}" class="grid"/><text x="${x(t).toFixed(1)}" y="${H - 8}" class="tick">${stamp(t).slice(5, 10)}</text>`).join("")
  const base = `<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(start).toFixed(1)}" y2="${y(start).toFixed(1)}" class="base"/>`
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(FAMILY_LABEL[family])} equity"><rect x="0" y="0" width="${W}" height="${H}" class="bg"/>${grid}${base}<polyline points="${line}" class="eq"/><text x="4" y="${PAD_T + 10}" class="tick">${hi.toFixed(2)}</text><text x="4" y="${H - PAD_B}" class="tick">${lo.toFixed(2)}</text></svg>`
}

// ---------- Markdown ----------
const lines = []
lines.push(`# Trade window simulation — ${tradeSpan}, ${prehistSpan}, ${report.symbolsUsed} of ${report.symbolsRequested} symbols`)
lines.push("")
lines.push(`Generated ${report.generatedAt}. Market: ${report.market}. Simulation only: no keys, no orders, no engine state written.`)
lines.push("")
lines.push(`- Prehistory (not booked): ${stamp(Date.parse(report.window.prehistFromUtc))} → ${stamp(Date.parse(report.window.tradeFromUtc))} UTC`)
lines.push(`- Trading (booked): ${stamp(Date.parse(report.window.tradeFromUtc))} → ${stamp(Date.parse(report.window.tradeToUtc))} UTC, ${bucketHours}-hour buckets, ${bucketCount} buckets`)
lines.push(`- Start balance ${report.startBalance} USDT, stake ${report.stakePerBaseEntry} USDT per base entry (1 %), PositionCost ${report.positionCostPct} %`)
lines.push(`- Base gate: min ${report.gate.minCount} measured closes, window ${report.gate.window}, stage PF ${report.gate.stagePf}; gate explanation: ${report.gateExplanation}`)
lines.push(`- Not modelled: ${report.funnel.notModelled.join(", ")} (the funnel reports their Base-valid count only)`)
lines.push("")
lines.push("## Funnel")
lines.push("")
lines.push(`- Prehistory candidates ${report.funnel.preCalc.candidates}, admitted but not booked ${report.funnel.preCalc.admittedNotBooked}`)
lines.push(`- Trading candidates ${report.funnel.trading.candidates}, admitted ${report.funnel.trading.admitted} (${pctOrDash(report.funnel.trading.admittedRate)})`)
lines.push("")
lines.push("## Families over the trading window")
lines.push("")
lines.push(mdTable(familyHeaders, familyRows))
lines.push("")
lines.push(`## Every ${bucketHours}-hour bucket, line by line (${bucketCount} buckets × ${FAMILIES.length} families)`)
lines.push("")
for (const family of FAMILIES) {
  lines.push(`### ${FAMILY_LABEL[family]}`)
  lines.push("")
  for (const b of buckets[family]) lines.push(`- ${bucketLine(family, b)}`)
  lines.push("")
}
lines.push("## Symbols")
lines.push("")
lines.push(mdTable(symbolHeaders, symbolRows))
lines.push("")
lines.push("## Indication types")
lines.push("")
lines.push(mdTable(typeHeaders, typeRows))
lines.push("")
lines.push("## Coordinates (type × direction × rule)")
lines.push("")
lines.push(mdTable(coordHeaders, coordRows))
lines.push("")
lines.push("## Results gaps")
lines.push("")
lines.push(`- Types enabled with no admitted entry: ${report.typesWithoutResults.length ? report.typesWithoutResults.join(", ") : "none"}`)
lines.push(`- Coordinates with no admitted entry: ${report.coordinatesWithoutResults.length} of ${report.coordinates.length}`)
lines.push(`- Symbols that failed: ${Object.keys(report.symbolErrors).length ? Object.entries(report.symbolErrors).map(([s, e]) => `${s} (${e})`).join("; ") : "none"}`)
lines.push("")
writeFileSync(join(outDir, "trade-window-report.md"), lines.join("\n") + "\n")

// ---------- HTML ----------
const css = `
:root{--bg:#f6f7f9;--fg:#15181d;--muted:#5b6472;--card:#ffffff;--line:#dde1e7;--accent:#1f6feb;--pos:#137333;--neg:#b3261e;--grid:#e5e8ee}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0f1218;--fg:#e6e9ef;--muted:#9aa4b2;--card:#171c24;--line:#2a313c;--accent:#6aa2ff;--pos:#5fd38a;--neg:#ff8a80;--grid:#262d38}}
:root[data-theme="dark"]{--bg:#0f1218;--fg:#e6e9ef;--muted:#9aa4b2;--card:#171c24;--line:#2a313c;--accent:#6aa2ff;--pos:#5fd38a;--neg:#ff8a80;--grid:#262d38}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1400px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:17px;margin:28px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}h3{font-size:15px;margin:18px 0 8px}
p,li{color:var(--fg)}.muted{color:var(--muted)}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px 16px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.meta div b{color:var(--muted);font-weight:500;display:block;font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:10px 0}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;white-space:nowrap}
th,td{padding:6px 9px;border-bottom:1px solid var(--line);text-align:right}th:first-child,td:first-child{text-align:left}
th{position:sticky;top:0;background:var(--card);font-weight:600;color:var(--muted);font-size:12px}
tbody tr:hover{background:color-mix(in srgb,var(--accent) 8%,transparent)}
.chart{width:100%;height:auto;display:block;border:1px solid var(--line);border-radius:10px;background:var(--card);margin:6px 0 14px}
.chart .bg{fill:var(--card)}.chart .grid{stroke:var(--grid)}.chart .base{stroke:var(--muted);stroke-dasharray:4 4}.chart .eq{fill:none;stroke:var(--accent);stroke-width:1.6}.chart .tick{fill:var(--muted);font-size:11px}
.warn{color:var(--neg)}.ok{color:var(--pos)}
.legend{font-size:12px;color:var(--muted)}
`
const meta = [
  ["Generated (UTC)", report.generatedAt],
  ["Trading window (UTC)", `${stamp(Date.parse(report.window.tradeFromUtc))} → ${stamp(Date.parse(report.window.tradeToUtc))}`],
  ["Prehistory (UTC, not booked)", `${stamp(Date.parse(report.window.prehistFromUtc))} → ${stamp(Date.parse(report.window.tradeFromUtc))}`],
  ["Bucket size", `${bucketHours} h (${bucketCount} buckets)`],
  ["Symbols used / requested", `${report.symbolsUsed} / ${report.symbolsRequested}`],
  ["Market data", report.market],
  ["Start balance / stake", `${report.startBalance} USDT / ${report.stakePerBaseEntry} USDT per base entry`],
  ["PositionCost (PF unit)", `${report.positionCostPct} %`],
  ["Base gate", `${report.gate.minCount} closes, window ${report.gate.window}, stage PF ${report.gate.stagePf}`],
  ["Gate explanation", report.gateExplanation],
  ["Indication flags forced on", Object.keys(report.indicationFlags).join(", ")],
  ["Run duration", `${report.durationSec} s (replay wall ${report.replayWallSec} s)`],
  ["Not modelled", report.funnel.notModelled.join(", ")],
]
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trade window simulation — ${esc(tradeSpan)}</title>
<style>${css}</style></head>
<body><main>
<h1>Trade window simulation — ${esc(tradeSpan)}, ${esc(prehistSpan)}, ${report.symbolsUsed} symbols</h1>
<p class="muted">Simulation only. Public BingX 1-minute candles, no keys, no orders, no engine state written. Every number below comes from <code>trade-window-simulation.json</code> in this folder.</p>
<h2>Run</h2>
<div class="meta">${meta.map(([k, v]) => `<div><b>${esc(k)}</b>${esc(v)}</div>`).join("")}</div>

<h2>Funnel</h2>
<div class="card">
<p>Prehistory: ${report.funnel.preCalc.candidates} candidates, ${report.funnel.preCalc.admittedNotBooked} admitted but not booked (these are the measured history for the gate).</p>
<p>Trading: ${report.funnel.trading.candidates} candidates, ${report.funnel.trading.admitted} admitted (${pctOrDash(report.funnel.trading.admittedRate)}). Block mean volume factor ${num(report.funnel.blockFactorMean, 3)}; trailing positions ${report.funnel.trailingPositions}.</p>
<p>Whole stream measured-ready entries: ${report.funnel.measuredReadyWholeStream}.</p>
</div>

<h2>Families over the trading window</h2>
${htmlTable(familyHeaders, familyRows)}

<h2>Equity curves</h2>
<p class="legend">Account equity per minute (downsampled), starting balance dashed.</p>
${FAMILIES.map((f) => `<h3>${FAMILY_LABEL[f]}</h3>${chartSvg(f)}`).join("\n")}

<h2>Every ${bucketHours}-hour bucket</h2>
<p class="muted">One table per family. Each row is one bucket: entries opened inside it, positions closed inside it, the bucket's own PF and win rate, the equity at the bucket end, and the cumulative totals from the window start.</p>
${FAMILIES.map((f) => `<h3>${FAMILY_LABEL[f]}</h3>${htmlTable(bucketHeaders, bucketRowsFor(f))}`).join("\n")}

<h2>Symbols</h2>
${htmlTable(symbolHeaders, symbolRows)}

<h2>Indication types</h2>
<p class="muted">Every indication the engine emitted, and whether it was enabled. A type with no admitted entry in the trading window is listed under results gaps below.</p>
${htmlTable(typeHeaders, typeRows)}

<h2>Coordinates (type × direction × rule)</h2>
<p class="muted">Candidates are the engine's own rows after its exits. "Gate: history short" means fewer than ${report.gate.minCount} measured closes existed before the entry; "Gate: PF below stage" means the measured closes did not reach stage PF ${report.gate.stagePf} after real round-trip cost.</p>
${htmlTable(coordHeaders, coordRows)}

<h2>Results gaps and data quality</h2>
<div class="card">
<p>Enabled types with no admitted entry: ${report.typesWithoutResults.length ? esc(report.typesWithoutResults.join(", ")) : "<span class='ok'>none</span>"}</p>
<p>Coordinates with no admitted entry: ${report.coordinatesWithoutResults.length} of ${report.coordinates.length}</p>
<p>Symbols that failed: ${Object.keys(report.symbolErrors).length ? esc(Object.entries(report.symbolErrors).map(([s, e]) => `${s} (${e})`).join("; ")) : "<span class='ok'>none</span>"}</p>
<p>Gate explanation: ${report.gateExplanation === "matches applyBaseGate" ? "<span class='ok'>matches applyBaseGate</span>" : `<span class='warn'>${esc(report.gateExplanation)}</span>`}</p>
</div>

<h2>What this does and does not show</h2>
<div class="card">
<ul>
<li>Entries are the engine's own direct-indication rows on real 1-minute bars, with the engine's protection and the shared short-range exits at market execution.</li>
<li>Money is simulated: ${report.stakePerBaseEntry} USDT per base entry; equity is marked to the minute close, gross of exit fees. Main, Real and Live are not modelled.</li>
<li>Trailing uses the Historic Test defaults (stop ${report.positionCostPct * 20} %, take-profit ${report.positionCostPct * 5} %, trailing distance 0.4 %, start ratio 0.3) on every admitted entry. DCA runs each of the four entry models on its own.</li>
<li>One five-day sample on public candles with no slippage model beyond the shared round-trip cost. It is not a validation of live profitability.</li>
</ul>
</div>
</main></body></html>
`
writeFileSync(join(outDir, "trade-window-report.html"), html)
console.log(`wrote ${join(outDir, "trade-window-report.md")} and ${join(outDir, "trade-window-report.html")}`)
