#!/usr/bin/env node
/**
 * Interactive HTML report for scripts/short-range-research.ts.
 *
 *   node scripts/build-short-range-report.mjs <research-out-dir>/results.json <report-dir>
 *
 * Writes report.html (self-contained: inline data, SVG charts, no external
 * assets), summary.json and SHA256SUMS.
 */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

const [resultsFile, reportDir] = process.argv.slice(2)
if (!resultsFile || !reportDir) {
  console.error("usage: build-short-range-report.mjs <results.json> <report-dir>")
  process.exit(2)
}
const data = JSON.parse(readFileSync(resultsFile, "utf8"))
const revision = (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() } catch { return "unknown" } })()
const COSTS = data.costs
const BASE = COSTS.indexOf(0.1)
const MIN_TRADES = data.selection.minDevTrades

// Compact rows: [config, group, class, tpX, sl, hold, trailing, devTrades, devPF×costs, devNet@base, devWin@base, devDD, devHoursPos, devHoursActive, holdTrades, holdPF×costs, holdNet@base, holdDD, holdHoursPos, holdHoursActive]
const round = (value, digits = 4) => value === null || value === undefined || !Number.isFinite(value) ? (value === Infinity ? 99 : null) : Number(value.toFixed(digits))
const compact = data.rows.map((row) => [
  row.config, row.group, row.rangeClass, row.takeProfitMultiple, row.stopLossPct, row.maxHoldMinutes, row.trailing,
  row.dev?.trades ?? 0, (row.dev?.byCost || []).map((entry) => round(entry.pf, 3)),
  round(row.dev?.byCost?.[BASE]?.netPct, 2), round(row.dev?.byCost?.[BASE]?.winRate, 3),
  round(row.devHours?.maxDrawdownPct, 2), row.devHours?.profitableHours ?? null, row.devHours?.activeHours ?? null,
  row.hold?.trades ?? 0, (row.hold?.byCost || []).map((entry) => round(entry.pf, 3)),
  round(row.hold?.byCost?.[BASE]?.netPct, 2),
  round(row.holdHours?.maxDrawdownPct, 2), row.holdHours?.profitableHours ?? null, row.holdHours?.activeHours ?? null,
])

// Best development PF per TP multiple and cost (rows with enough trades), original and faded.
function bestByMultiple(fade) {
  const multiples = data.grid.takeProfitMultiples
  return COSTS.map((cost, costIndex) => ({
    cost,
    points: multiples.map((multiple) => {
      let best = null
      for (const row of data.rows) {
        if (row.takeProfitMultiple !== multiple || (row.dev?.trades ?? 0) < MIN_TRADES) continue
        if (row.group.startsWith("fade:") !== fade || row.group === "all" || row.group === "fade:all") continue
        const pf = row.dev.byCost[costIndex].pf
        if (pf !== null && Number.isFinite(pf) && (!best || pf > best.pf)) {
          best = { pf, config: row.config, group: row.group, trades: row.dev.trades, holdPf: row.hold?.byCost?.[costIndex]?.pf ?? null }
        }
      }
      return { multiple, ...(best || { pf: null }) }
    }),
  }))
}
const curves = { original: bestByMultiple(false), faded: bestByMultiple(true) }

// Range classes: best development row per class and its holdout result.
const classes = ["micro", "minimum", "short", "general", "long"]
const classTable = classes.map((name) => {
  const out = { name }
  for (const fade of [false, true]) {
    let best = null
    for (const row of data.rows) {
      if (row.rangeClass !== name || (row.dev?.trades ?? 0) < MIN_TRADES) continue
      if (row.group.startsWith("fade:") !== fade) continue
      const pf = row.dev.byCost[BASE].pf
      if (pf !== null && (!best || pf > best.dev.byCost[BASE].pf)) best = row
    }
    out[fade ? "faded" : "original"] = best && {
      config: best.config, group: best.group, devTrades: best.dev.trades,
      devPf: COSTS.map((_, index) => best.dev.byCost[index].pf), holdTrades: best.hold?.trades ?? 0,
      holdPf: COSTS.map((_, index) => best.hold?.byCost?.[index]?.pf ?? null),
      devDD: best.devHours?.maxDrawdownPct ?? null,
    }
  }
  return out
})

const summary = {
  generatedAt: new Date().toISOString(),
  revision,
  window: data.window,
  symbols: data.symbols,
  bars: data.bars,
  signals: data.signals,
  gaps: data.gaps,
  configurations: data.grid.configurations,
  rows: data.rows.length,
  developmentCandidates: data.selection.devCandidates,
  selection: data.selection,
  makerOnlyCandidates: data.makerOnly.length,
  verdict: data.selection.devCandidates === 0
    ? "No configuration is positive after costs on the development window; nothing was evaluated on the holdout or enabled."
    : `${data.selection.devCandidates} development candidates; see the holdout table.`,
}

const payload = { compact, costs: COSTS, base: BASE, minTrades: MIN_TRADES, curves, classTable, edge: data.edge, drift: data.drift, makerOnly: data.makerOnly.map((row) => ({
  config: row.config, group: row.group, devTrades: row.dev.trades, holdTrades: row.hold?.trades ?? 0,
  devPf: row.dev.byCost.map((entry) => round(entry.pf, 3)), holdPf: (row.hold?.byCost || []).map((entry) => round(entry.pf, 3)),
})) }

const esc = (value) => String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]))
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Short-Range Research</title>
<style>
:root {
  color-scheme: light;
  --surface-0: #f6f5f2; --surface-1: #fcfcfb; --border: #e3e1db;
  --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #77756f;
  --grid: #ecebe7; --axis: #a9a7a0;
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100;
  --pos: #2a78d6; --neg: #e34948; --ref: #52514e;
  --good-bg: #e6f4ea; --bad-bg: #fbe9e9;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --surface-0: #121211; --surface-1: #1a1a19; --border: #33332f;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #9a998f;
    --grid: #2a2a27; --axis: #5d5c56;
    --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
    --pos: #3987e5; --neg: #e66767; --ref: #c3c2b7;
    --good-bg: #16301f; --bad-bg: #3a1d1d;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --surface-0: #121211; --surface-1: #1a1a19; --border: #33332f;
  --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #9a998f;
  --grid: #2a2a27; --axis: #5d5c56;
  --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
  --pos: #3987e5; --neg: #e66767; --ref: #c3c2b7;
  --good-bg: #16301f; --bad-bg: #3a1d1d;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface-0); color: var(--text-primary); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 32px 0 8px; }
p, li { color: var(--text-secondary); }
.meta { color: var(--text-muted); font-size: 12px; }
.card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin: 12px 0; }
.verdict { border-left: 4px solid var(--neg); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.tile .v { font-size: 22px; font-weight: 600; color: var(--text-primary); }
.tile .l { font-size: 12px; color: var(--text-muted); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; font-variant-numeric: tabular-nums; }
th, td { padding: 5px 8px; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
th:first-child, td:first-child, th.l, td.l { text-align: left; }
th { color: var(--text-secondary); font-weight: 600; position: sticky; top: 0; background: var(--surface-1); cursor: default; }
td.good { background: var(--good-bg); } td.bad { background: var(--bad-bg); }
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
select, input { background: var(--surface-1); color: var(--text-primary); border: 1px solid var(--border); border-radius: 6px; padding: 4px 6px; font: inherit; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: var(--text-secondary); margin: 6px 0; }
.legend i { display: inline-block; width: 14px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 6px; }
svg { display: block; width: 100%; height: auto; overflow: visible; }
svg text { fill: var(--text-muted); font-size: 11px; }
.tip { position: fixed; pointer-events: none; background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; font-size: 12px; color: var(--text-primary); box-shadow: 0 4px 16px rgba(0,0,0,.15); display: none; z-index: 10; max-width: 320px; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
code { font-size: 12px; }
</style>
</head>
<body>
<main>
<h1>Short-range research: 15 symbols, 14 days of real data</h1>
<div class="meta">Revision ${esc(revision)} · generated ${esc(summary.generatedAt)} · BingX perpetual 1-minute bars (public data) · development ${esc(data.window.devDays)} · holdout ${esc(data.window.holdoutDays)}</div>

<div class="card verdict">
<strong>Result: no configuration is positive after costs.</strong>
<p>All ${summary.configurations} exit configurations were evaluated for every indication type and direction, and for the faded (opposite-side) entries. That is ${summary.rows.toLocaleString("en")} rows. None reaches PF &gt; 1 on the development window at the configured 0.10 % round-trip cost and at 1.5× that cost with at least ${MIN_TRADES} trades. So nothing was taken to the holdout as a candidate, and nothing is enabled.</p>
<p>The reason is the entries, not the exits. The signals' average signed move after 5–60 minutes is close to zero or negative (table "Directional edge"), far below the 0.10 % a round trip costs. The best original rows are only about 1.15 before costs, and they are long rows on a basket that rose.</p>
</div>

<div class="tiles">
<div class="card tile"><div class="v">${data.symbols.length}</div><div class="l">symbols</div></div>
<div class="card tile"><div class="v">${data.bars.toLocaleString("en")}</div><div class="l">1-minute bars (gaps: ${Object.keys(data.gaps).length})</div></div>
<div class="card tile"><div class="v">${data.signals.toLocaleString("en")}</div><div class="l">captured signals</div></div>
<div class="card tile"><div class="v">${summary.rows.toLocaleString("en")}</div><div class="l">configuration × group rows</div></div>
<div class="card tile"><div class="v">${summary.developmentCandidates}</div><div class="l">development candidates</div></div>
</div>

<h2>Best development PF by target distance</h2>
<p>For each take-profit distance (in multiples of the 0.10 % PositionCost), this shows the best row over every type, direction, stop, hold and trailing setting with at least ${MIN_TRADES} development trades, at four cost levels. PF 1 is the reference line. Hover a point for the configuration and its holdout PF.</p>
<div class="legend" id="legend"></div>
<div class="charts">
<div class="card"><strong>Original signals</strong><svg id="chart-original" viewBox="0 0 520 300" role="img" aria-label="Best development PF by take-profit multiple, original signals"></svg></div>
<div class="card"><strong>Faded signals (opposite side)</strong><svg id="chart-faded" viewBox="0 0 520 300" role="img" aria-label="Best development PF by take-profit multiple, faded signals"></svg></div>
</div>

<h2>Directional edge of the signals</h2>
<p>Average signed price move after the signal, before costs and before any exit rule, as a percentage. A round trip costs 0.10 %, so an entry needs well above +0.10 % here to pay for itself. Blue is positive, red is negative.</p>
<div class="card"><svg id="chart-edge" viewBox="0 0 1000 300" role="img" aria-label="Average 15-minute signed move per type and direction"></svg>
<div class="scroll"><table id="edge-table"></table></div></div>

<h2>Range classes</h2>
<p>The best development row per range class at the configured cost (Micro &lt; 2, Minimum 2–3, Short 3–6, General 6–12, Long &gt; 12 PositionCost multiples), with its PF at every cost level and on the holdout. The holdout figures are diagnostics for these rows; they did not select anything.</p>
<div class="card scroll"><table id="class-table"></table></div>

<h2>Explore every configuration</h2>
<div class="card">
<div class="controls">
<label>Group <select id="f-group"></select></label>
<label>Range <select id="f-class"><option value="">all</option>${classes.map((c) => `<option>${c}</option>`).join("")}</select></label>
<label>Sort by dev PF at <select id="f-cost"></select></label>
<label>Min dev trades <input id="f-min" type="number" value="${MIN_TRADES}" min="0" step="50" style="width:80px"></label>
<span class="meta" id="f-count"></span>
</div>
<div class="scroll" style="max-height:520px"><table id="explore"></table></div>
<p class="meta">Drawdown and positive hours are computed on hourly net at 0.10 % cost (summed percent per trade). They are available for the all-types and per-type rows; per-direction rows show "–".</p>
</div>

<h2>Maker-fee execution (reported only)</h2>
<p>These rows clear PF &gt; 1 only at 0.04 % round trip, which means maker fees on both legs with every limit order filled. That fill model is not validated, and the engine executes market entries. They are listed to show what execution cost an edge would need, not as candidates. On the holdout they are about 1.0 even at maker cost.</p>
<div class="card scroll"><table id="maker-table"></table></div>

<h2>Market drift (buy and hold)</h2>
<div class="card scroll"><table id="drift-table"></table></div>

<h2>Matrix, coverage and limits</h2>
<div class="card">
<ul>
<li><strong>Executed dimensions:</strong>
<ul>
<li>take profit ${data.grid.takeProfitMultiples.join(", ")} × PositionCost;</li>
<li>stop loss ${data.grid.stopLossPct.join(", ")} % (never below the 0.6 % operator floor);</li>
<li>max hold ${data.grid.maxHoldMinutes.join(", ")} min;</li>
<li>exit ${data.grid.trailing.join(" / ")} (trailing arms at the target and gives back 30 % or 50 % of the best move);</li>
<li>groups: all, each type, each type × direction, original and faded;</li>
<li>costs ${COSTS.join(", ")} % round trip. 0 = gross, 0.04 = maker both legs, 0.10 = configured PositionCost, 0.15 = 1.5× stress, 0.26 = the live round trip including spread and slippage.</li>
</ul>
That is ${summary.configurations} configurations × ${summary.rows / summary.configurations} groups = ${summary.rows.toLocaleString("en")} rows, all executed.</li>
<li><strong>Entries:</strong> every direct-indication signal of the engine's default settings, captured with the engine's own per-type replay (<code>scripts/short-range-capture.ts</code>). The 90-minute stage history uses completed bars only; each entry is at the decision bar's close; one open position per type, direction and rule.</li>
<li><strong>Exits</strong> (<code>lib/short-range-exits.ts</code>, identical to the per-type measurement without trailing): bar high and low; a bar touching both levels is a stop; a gap exits at the open.</li>
<li><strong>Not covered:</strong>
<ul>
<li>non-default indication parameters;</li>
<li>per-symbol fitting (deliberately not done: it would overfit 10 days);</li>
<li>the Main/Real/Live stage axes (Prev/Last/Cont, Block/DCA accumulation);</li>
<li>funding payments;</li>
<li>fill probability of maker orders;</li>
<li>intrabar order beyond the conservative both-touched rule.</li>
</ul></li>
<li><strong>Data:</strong> ${data.symbols.join(", ")}; 14 completed UTC days, ${Object.keys(data.gaps).length ? "gaps: " + esc(JSON.stringify(data.gaps)) : "no missing bars"}. Oct 6–7 are not part of this study; they are reserved for the 20-hour engine run.</li>
<li><strong>Selection discipline:</strong> ${esc(data.selection.rule)}, at least ${MIN_TRADES} development trades. The holdout (4 days) is used only for selected candidates, and there were none. The holdout columns elsewhere are diagnostics; these days are no longer an independent holdout for any future selection.</li>
</ul>
</div>
</main>
<div class="tip" id="tip"></div>
<script>
const D = ${JSON.stringify(payload)};
const fmt = (v, d = 3) => v === null || v === undefined ? "–" : Number(v).toFixed(d);
const fmtPf = (v) => v === null || v === undefined ? "–" : (v >= 99 ? "∞" : Number(v).toFixed(3));
const costName = (c) => c === 0 ? "gross" : c === 0.04 ? "0.04 % maker" : c === 0.1 ? "0.10 % configured" : c === 0.26 ? "0.26 % live" : c.toFixed(2) + " %";
const SERIES = [[0, "--series-1"], [0.04, "--series-2"], [0.1, "--series-3"], [0.26, "--series-4"]];
const tip = document.getElementById("tip");
function showTip(event, html) { tip.innerHTML = html; tip.style.display = "block"; const x = Math.min(event.clientX + 12, innerWidth - 330); tip.style.left = x + "px"; tip.style.top = (event.clientY + 12) + "px"; }
function hideTip() { tip.style.display = "none"; }
document.getElementById("legend").innerHTML = SERIES.map(([c, v]) => '<span><i style="background:var(' + v + ')"></i>' + costName(c) + '</span>').join("") + '<span><i style="background:var(--ref);height:1px"></i>PF 1</span>';
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs, parent) => { const node = document.createElementNS(NS, tag); for (const k in attrs) node.setAttribute(k, attrs[k]); parent && parent.appendChild(node); return node; };
function lineChart(id, curves) {
  const svg = document.getElementById(id), W = 520, H = 300, L = 44, R = 64, T = 12, B = 34;
  const multiples = curves[0].points.map((p) => p.multiple);
  const values = curves.flatMap((c) => c.points.map((p) => p.pf)).filter((v) => v !== null && v < 99);
  const yMax = Math.max(1.2, Math.ceil(Math.max(...values) * 10) / 10), yMin = Math.min(0.4, Math.floor(Math.min(...values) * 10) / 10);
  const x = (i) => L + (i / (multiples.length - 1)) * (W - L - R), y = (v) => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);
  for (let v = yMin; v <= yMax + 1e-9; v += 0.2) { el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: "var(--grid)" }, svg); el("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, svg).textContent = v.toFixed(1); }
  multiples.forEach((m, i) => { el("text", { x: x(i), y: H - B + 16, "text-anchor": "middle" }, svg).textContent = m + "×"; });
  el("text", { x: (L + W - R) / 2, y: H - 4, "text-anchor": "middle" }, svg).textContent = "take profit (× PositionCost)";
  el("line", { x1: L, x2: W - R, y1: y(1), y2: y(1), stroke: "var(--ref)", "stroke-dasharray": "4 3" }, svg);
  for (const [cost, color] of SERIES) {
    const curve = curves.find((c) => c.cost === cost); if (!curve) continue;
    const pts = curve.points.map((p, i) => p.pf === null ? null : [x(i), y(Math.min(p.pf, yMax)), p]).filter(Boolean);
    el("polyline", { points: pts.map((p) => p[0] + "," + p[1]).join(" "), fill: "none", stroke: "var(" + color + ")", "stroke-width": 2, "stroke-linejoin": "round" }, svg);
    const last = pts[pts.length - 1];
    if (last) el("text", { x: last[0] + 8, y: last[1] + 4, style: "fill:var(--text-secondary)" }, svg).textContent = cost === 0 ? "gross" : cost === 0.04 ? "maker" : cost === 0.1 ? "0.10 %" : "live";
    for (const [px, py, p] of pts) {
      el("circle", { cx: px, cy: py, r: 4, fill: "var(" + color + ")", stroke: "var(--surface-1)", "stroke-width": 2 }, svg);
      const hit = el("circle", { cx: px, cy: py, r: 10, fill: "transparent" }, svg);
      hit.addEventListener("mousemove", (e) => showTip(e, "<b>" + costName(cost) + "</b> · TP " + p.multiple + "×<br>dev PF " + fmt(p.pf) + " (" + p.trades + " trades)<br>holdout PF " + fmt(p.holdPf) + "<br><span style='color:var(--text-muted)'>" + p.group + " · " + p.config + "</span>"));
      hit.addEventListener("mouseleave", hideTip);
    }
  }
}
lineChart("chart-original", D.curves.original);
lineChart("chart-faded", D.curves.faded);
// Directional edge (15 minutes, development) as a diverging bar chart.
(function () {
  const svg = document.getElementById("chart-edge"), W = 1000, H = 300, L = 44, R = 10, T = 14, B = 70;
  const keys = Object.keys(D.edge.dev).sort();
  const vals = keys.map((k) => D.edge.dev[k].avgMove15mPct);
  const lim = Math.max(0.12, ...vals.map(Math.abs));
  const y = (v) => T + (1 - (v + lim) / (2 * lim)) * (H - T - B);
  const bw = (W - L - R) / keys.length;
  for (const v of [-0.1, -0.05, 0, 0.05, 0.1]) { el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: v === 0 ? "var(--axis)" : "var(--grid)" }, svg); el("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, svg).textContent = v.toFixed(2); }
  el("line", { x1: L, x2: W - R, y1: y(0.1), y2: y(0.1), stroke: "var(--ref)", "stroke-dasharray": "4 3" }, svg);
  el("text", { x: W - R, y: y(0.1) - 4, "text-anchor": "end" }, svg).textContent = "round-trip cost 0.10 %";
  keys.forEach((k, i) => {
    const v = vals[i], x0 = L + i * bw + 3, w = bw - 6, top = Math.min(y(v), y(0)), h = Math.max(1, Math.abs(y(v) - y(0)));
    el("rect", { x: x0, y: top, width: w, height: h, rx: 3, fill: v >= 0 ? "var(--pos)" : "var(--neg)" }, svg);
    const t = el("text", { x: x0 + w / 2, y: H - B + 12, "text-anchor": "end", transform: "rotate(-40 " + (x0 + w / 2) + " " + (H - B + 12) + ")" }, svg); t.textContent = k;
    const hit = el("rect", { x: x0 - 3, y: T, width: bw, height: H - T - B, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", (e) => { const s = D.edge.dev[k]; showTip(e, "<b>" + k + "</b><br>" + s.signals + " signals<br>after 5 min " + fmt(s.avgMove5mPct, 4) + " %<br>after 15 min " + fmt(s.avgMove15mPct, 4) + " %<br>after 60 min " + fmt(s.avgMove60mPct, 4) + " %"); });
    hit.addEventListener("mouseleave", hideTip);
  });
  const rows = keys.map((k) => { const d = D.edge.dev[k], h = D.edge.hold[k] || {}; return "<tr><td>" + k + "</td><td>" + d.signals + "</td><td>" + fmt(d.avgMove5mPct, 4) + "</td><td>" + fmt(d.avgMove15mPct, 4) + "</td><td>" + fmt(d.avgMove60mPct, 4) + "</td><td>" + (h.signals ?? "–") + "</td><td>" + fmt(h.avgMove5mPct, 4) + "</td><td>" + fmt(h.avgMove15mPct, 4) + "</td><td>" + fmt(h.avgMove60mPct, 4) + "</td></tr>"; }).join("");
  document.getElementById("edge-table").innerHTML = "<tr><th>type:direction</th><th>dev signals</th><th>dev 5m %</th><th>dev 15m %</th><th>dev 60m %</th><th>hold signals</th><th>hold 5m %</th><th>hold 15m %</th><th>hold 60m %</th></tr>" + rows;
})();
const pfCell = (v) => '<td class="' + (v === null ? "" : v > 1 ? "good" : "bad") + '">' + fmtPf(v) + "</td>";
document.getElementById("class-table").innerHTML = "<tr><th class='l'>class</th><th class='l'>variant</th><th class='l'>best dev row</th><th>dev trades</th>" + D.costs.map((c) => "<th>dev PF " + costName(c) + "</th>").join("") + "<th>dev DD % pts</th><th>hold trades</th><th>hold PF 0.10 %</th></tr>" +
  D.classTable.flatMap((c) => ["original", "faded"].map((variant) => { const r = c[variant]; if (!r) return "<tr><td class='l'>" + c.name + "</td><td class='l'>" + variant + "</td><td class='l' colspan='" + (D.costs.length + 5) + "'>no row with enough trades</td></tr>"; return "<tr><td class='l'>" + c.name + "</td><td class='l'>" + variant + "</td><td class='l'>" + r.group + " · " + r.config + "</td><td>" + r.devTrades + "</td>" + r.devPf.map(pfCell).join("") + "<td>" + fmt(r.devDD, 1) + "</td><td>" + r.holdTrades + "</td>" + pfCell(r.holdPf[D.base]) + "</tr>"; })).join("");
// Explorer.
const groups = [...new Set(D.compact.map((r) => r[1]))].sort();
document.getElementById("f-group").innerHTML = groups.map((g) => "<option" + (g === "all" ? " selected" : "") + ">" + g + "</option>").join("");
document.getElementById("f-cost").innerHTML = D.costs.map((c, i) => "<option value='" + i + "'" + (i === D.base ? " selected" : "") + ">" + costName(c) + "</option>").join("");
function renderExplore() {
  const g = document.getElementById("f-group").value, cls = document.getElementById("f-class").value, ci = Number(document.getElementById("f-cost").value), min = Number(document.getElementById("f-min").value) || 0;
  const rows = D.compact.filter((r) => r[1] === g && (!cls || r[2] === cls) && r[7] >= min).sort((a, b) => (b[8][ci] ?? -1) - (a[8][ci] ?? -1));
  document.getElementById("f-count").textContent = rows.length + " rows";
  document.getElementById("explore").innerHTML = "<tr><th class='l'>configuration</th><th class='l'>range</th><th>dev trades</th><th>dev PF gross</th><th>dev PF " + costName(D.costs[ci]) + "</th><th>dev net % @0.10</th><th>win @0.10</th><th>dev DD</th><th>dev + hours</th><th>hold trades</th><th>hold PF " + costName(D.costs[ci]) + "</th><th>hold net % @0.10</th><th>hold DD</th><th>hold + hours</th></tr>" +
    rows.slice(0, 300).map((r) => "<tr><td class='l'>" + r[0] + "</td><td class='l'>" + r[2] + "</td><td>" + r[7] + "</td>" + pfCell(r[8][0]) + pfCell(r[8][ci]) + "<td>" + fmt(r[9], 1) + "</td><td>" + fmt(r[10] === null ? null : r[10] * 100, 1) + " %</td><td>" + fmt(r[11], 1) + "</td><td>" + (r[13] ? r[12] + "/" + r[13] : "–") + "</td><td>" + r[14] + "</td>" + pfCell(r[15][ci] ?? null) + "<td>" + fmt(r[16], 1) + "</td><td>" + fmt(r[17], 1) + "</td><td>" + (r[19] ? r[18] + "/" + r[19] : "–") + "</td></tr>").join("");
}
for (const id of ["f-group", "f-class", "f-cost", "f-min"]) document.getElementById(id).addEventListener("input", renderExplore);
renderExplore();
document.getElementById("maker-table").innerHTML = "<tr><th class='l'>group</th><th class='l'>configuration</th><th>dev trades</th><th>dev PF 0.04 %</th><th>dev PF 0.10 %</th><th>hold trades</th><th>hold PF 0.04 %</th><th>hold PF 0.10 %</th></tr>" +
  D.makerOnly.slice(0, 20).map((r) => "<tr><td class='l'>" + r.group + "</td><td class='l'>" + r.config + "</td><td>" + r.devTrades + "</td>" + pfCell(r.devPf[1]) + pfCell(r.devPf[D.base]) + "<td>" + r.holdTrades + "</td>" + pfCell(r.holdPf[1] ?? null) + pfCell(r.holdPf[D.base] ?? null) + "</tr>").join("");
document.getElementById("drift-table").innerHTML = "<tr><th class='l'>symbol</th><th>development %</th><th>holdout %</th></tr>" + Object.entries(D.drift).map(([s, d]) => "<tr><td class='l'>" + s + "</td><td>" + fmt(d.dev, 1) + "</td><td>" + fmt(d.hold, 1) + "</td></tr>").join("");
</script>
</body>
</html>
`

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, "report.html"), html)
writeFileSync(path.join(reportDir, "summary.json"), JSON.stringify(summary, null, 2))
const sums = ["report.html", "summary.json"].map((name) => `${createHash("sha256").update(readFileSync(path.join(reportDir, name))).digest("hex")}  ${name}`).join("\n") + "\n"
writeFileSync(path.join(reportDir, "SHA256SUMS"), sums)
console.log(`report: ${path.join(reportDir, "report.html")} (${(Buffer.byteLength(html) / 1e6).toFixed(1)} MB)`)
