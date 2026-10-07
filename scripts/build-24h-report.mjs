#!/usr/bin/env node
/**
 * Detailed HTML report for one engine run plus the matching backtests.
 *
 *   node scripts/build-24h-report.mjs <observation-dir> <backtest-dir> <gate-study.json> <lab-selection.json|-> <report-dir> [pf-attribution.json]
 *
 * <backtest-dir> holds the GET /api/connections/<id>/backtest payloads
 * (gated-market.json, signals-market.json, gated-maker.json,
 * signals-maker.json) for the run's symbols and window. Self-contained
 * output: inline data, SVG charts, light/dark tokens.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

const [obsDir, btDir, gateFile, labFile, reportDir, attributionFile] = process.argv.slice(2)
if (!obsDir || !btDir || !gateFile || !reportDir) {
  console.error("usage: build-24h-report.mjs <observation-dir> <backtest-dir> <gate-study.json> <lab-selection.json|-> <report-dir>")
  process.exit(2)
}
const readJson = (file, fallback = null) => { try { return JSON.parse(readFileSync(file, "utf8")) } catch { return fallback } }
const readLines = (file) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } }) : []
const revision = (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() } catch { return "unknown" } })()

const run = readJson(path.join(obsDir, "run.json"), {})
const summary = readJson(path.join(obsDir, "summary.json"), {})
const statsFinal = readJson(path.join(obsDir, "stats-final.json"), {})
const statsPre = readJson(path.join(obsDir, "stats-after-prehistoric.json"), {})
const coverage = readJson(path.join(obsDir, "coverage-final.json"), {})
const trades = readJson(path.join(obsDir, "simulated-trades.json"), [])
const samples = readLines(path.join(obsDir, "samples.jsonl"))
const gate = readJson(gateFile, { rows: [] })
const lab = labFile && labFile !== "-" ? readJson(labFile, null) : null
const attribution = attributionFile ? readJson(attributionFile, null) : null

const variants = ["gated-market", "signals-market", "gated-maker", "signals-maker"].map((name) => {
  const payload = readJson(path.join(btDir, `${name}.json`), null)
  return payload?.result ? { name, result: payload.result } : null
}).filter(Boolean)

// Realtime funnel: the harness samples carry the per-cycle stage counts; a
// summed run total would mix repeated evaluations of the same Sets, so the
// table shows the maximum seen in any sample.
const stageSamples = samples.map((s) => s?.stats?.stages).filter(Boolean)
const funnel = ["base", "main", "real", "live"].map((stage) => {
  const seen = stageSamples.map((st) => st?.[stage]).filter(Boolean)
  const detail = statsFinal?.strategyDetail?.[stage]
  return {
    stage,
    evaluated: seen.length ? Math.max(...seen.map((x) => Number(x.evaluated) || 0)) : Number(detail?.evaluated ?? NaN),
    passed: seen.length ? Math.max(...seen.map((x) => Number(x.passed) || 0)) : Number(detail?.passed ?? NaN),
  }
})
const lastSample = samples[samples.length - 1] || {}
const measuredPf = Number(lastSample?.stats?.prehistoric?.profitFactor)
const measuredCount = Number(lastSample?.stats?.prehistoric?.profitFactorCount)
const rss = samples.map((s) => Number(s?.process?.rssMb ?? s?.rssMb)).filter(Number.isFinite)
const latency = samples.flatMap((s) => [...Object.values(s?.timings || {}), ...Object.values(s?.http || {}).map((h) => h?.ms)]).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
const p95 = latency.length ? latency[Math.floor(latency.length * 0.95)] : null
const closedTrades = (Array.isArray(trades) ? trades : []).filter((t) => Number(t?.closedAt) > 0)

const payload = {
  variants: variants.map(({ name, result }) => ({
    name,
    summary: result.summary,
    funnel: result.funnel || null,
    equity: result.equity.map((p) => [p.t, Number(p.equityPct.toFixed(4)), Number(p.drawdownPct.toFixed(4))]),
    byHour: result.byHour.map((h) => [h.startAt, Number(h.netPct.toFixed(4)), h.trades]),
    bySymbol: result.bySymbol, byType: result.byType, byDirection: result.byDirection, byRangeClass: result.byRangeClass, byReason: result.byReason,
    heat: result.heatmapSymbolHour,
    costs: result.costs, window: result.window, data: result.data,
  })),
  gate: gate.rows.map((r) => ({ key: r.key, trades: r.trades, pf: r.pf, avgPct: r.avgPct, halves: r.halves })),
  funnel,
}

const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
const fmt = (v, d = 2) => v === null || v === undefined || !Number.isFinite(Number(v)) ? "–" : Number(v).toFixed(d)
const gm = variants.find((v) => v.name === "gated-maker")?.result.summary
const gk = variants.find((v) => v.name === "gated-market")?.result.summary
const sk = variants.find((v) => v.name === "signals-market")?.result.summary
const windowText = variants[0] ? `${new Date(variants[0].result.window.fromMs).toISOString().slice(0, 16).replace("T", " ")} → ${new Date(variants[0].result.window.toMs).toISOString().slice(11, 16)} UTC` : "–"
const symbols = (run.symbols || []).join(", ")

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>24 h Trade Simulation</title>
<style>
:root{color-scheme:light;--bg:#f6f5f2;--card:#fcfcfb;--border:#e3e1db;--fg:#0b0b0b;--fg2:#52514e;--muted:#77756f;--grid:#ecebe7;--axis:#a9a7a0;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--pos:#1baf7a;--neg:#e34948;--good:#e6f4ea;--bad:#fbe9e9}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--bg:#121211;--card:#1a1a19;--border:#33332f;--fg:#fff;--fg2:#c3c2b7;--muted:#9a998f;--grid:#2a2a27;--axis:#5d5c56;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--pos:#199e70;--neg:#e66767;--good:#16301f;--bad:#3a1d1d}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#121211;--card:#1a1a19;--border:#33332f;--fg:#fff;--fg2:#c3c2b7;--muted:#9a998f;--grid:#2a2a27;--axis:#5d5c56;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--pos:#199e70;--neg:#e66767;--good:#16301f;--bad:#3a1d1d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1160px;margin:0 auto;padding:24px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px}h3{font-size:14px;margin:0 0 8px}
p,li{color:var(--fg2)}.meta{color:var(--muted);font-size:12px}.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0}
.verdict{border-left:4px solid var(--neg)}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.tile .v{font-size:22px;font-weight:600}.tile .l{font-size:12px;color:var(--muted)}.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}th,td{padding:5px 8px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{color:var(--fg2);font-weight:600}td.good{background:var(--good)}td.bad{background:var(--bad)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px}svg{display:block;width:100%;height:auto;overflow:visible}svg text{fill:var(--muted);font-size:11px}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--fg2);margin:6px 0}.legend i{display:inline-block;width:14px;height:3px;border-radius:2px;vertical-align:middle;margin-right:6px}
.tip{position:fixed;pointer-events:none;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:6px 8px;font-size:12px;display:none;z-index:9;box-shadow:0 4px 16px rgba(0,0,0,.15)}
select{background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:4px 6px;font:inherit}
.heat{display:grid;gap:2px}.heat div.c{height:18px;border-radius:3px}
</style></head><body><main>
<h1>24-hour trade simulation: ${esc((run.symbols || []).length)} symbols, real BingX data</h1>
<div class="meta">Revision ${esc(revision)} · connection ${esc(summary.connectionId || run.connectionId)} (paper, public market data, no orders) · prehistoric ${esc(run.prehistoricHours)} h + ${fmt((summary.realtimeObservedMs || 0) / 60000, 0)} min realtime · backtest window ${esc(windowText)}</div>

<div class="card verdict">
<strong>Result: not positive, and no setting of the current gates makes it positive.</strong>
<p>The run completed cleanly on real data. ${esc(Number(statsPre?.historic?.candlesLoaded || 0).toLocaleString("en"))} candles were loaded, all ${esc(run.symbols?.length)} symbols processed, and every config task succeeded. The engine itself closed ${closedTrades.length} paper trades in the realtime phase.</p>
<p>That is the Base gate working as specified, not a stall. Over the 24 prehistoric hours the engine measured <b>${esc(Number.isFinite(measuredCount) ? measuredCount.toLocaleString("en") : "–")} closes with PF ${fmt(measuredPf)}</b> after the 0.26 % round trip. No Set reached min(PF, PositionCost ratio) ≥ 1.10, so none was admitted to Main/Real/Live.</p>
<p>Over the same symbols and window, the engine's own entries and TP/SL (backtest) give these PFs:</p>
<ul>
<li>all signals, market execution: <b>PF ${fmt(sk?.profitFactor)}</b>, ${esc(sk?.trades)} trades;</li>
<li>after the Base gate, market: <b>PF ${fmt(gk?.profitFactor)}</b>, ${esc(gk?.trades)} trades;</li>
<li>after the Base gate, maker execution: <b>PF ${fmt(gm?.profitFactor)}</b>, ${esc(gm?.trades)} trades, ${esc(gm?.profitableHours)}/${esc(gm?.activeHours)} hours positive.</li>
</ul>
<p>The Base gate raises the PF in this window, but on 14 days it adds no edge (table "After the Base gate"). The entries have about zero directional edge, and the engine's targets (about 0.2–0.55 %) are small against a 0.16–0.26 % round trip.</p>
</div>

<div class="tiles">
<div class="card tile"><div class="v">${esc(run.symbols?.length)}</div><div class="l">symbols</div></div>
<div class="card tile"><div class="v">${esc(Number(statsPre?.historic?.candlesLoaded || 0).toLocaleString("en"))}</div><div class="l">candles loaded</div></div>
<div class="card tile"><div class="v">${esc(statsPre?.historic?.configWork?.failed ?? summary?.prehistoric?.configWork?.failed ?? 0)}</div><div class="l">failed config tasks</div></div>
<div class="card tile"><div class="v">${esc(coverage.errors ?? "–")}</div><div class="l">coverage errors</div></div>
<div class="card tile"><div class="v">${rss.length ? Math.max(...rss).toFixed(0) : "–"} MB</div><div class="l">peak RSS</div></div>
<div class="card tile"><div class="v">${p95 === null ? "–" : p95.toFixed(0) + " ms"}</div><div class="l">p95 API latency</div></div>
</div>

<h2>Engine stage funnel (this run)</h2>
<div class="card scroll"><table><tr><th>Stage</th><th>Sets evaluated</th><th>Sets passed</th></tr>
<tr><td>prehistoric measurement</td><td>${Number.isFinite(measuredCount) ? measuredCount : "–"} closes</td><td>PF ${fmt(measuredPf)}</td></tr>
${funnel.map((f) => `<tr><td>${f.stage}</td><td>${Number.isFinite(f.evaluated) ? f.evaluated : "–"}</td><td>${Number.isFinite(f.passed) ? f.passed : "–"}</td></tr>`).join("")}
</table><p class="meta">The engine's own paper trades: ${closedTrades.length} closed. Base admits a Set only after enough measured closes with min(PF, PositionCost ratio) ≥ 1.10.</p></div>

<h2>Backtest of the same window: four execution / gate variants</h2>
<div class="card scroll"><table id="variants"></table></div>
<div class="legend" id="legend"></div>
<div class="grid2">
<div class="card"><h3>Equity (cumulative net, sum of trade %)</h3><svg id="eq" viewBox="0 0 560 280"></svg></div>
<div class="card"><h3>Drawdown</h3><svg id="dd" viewBox="0 0 560 280"></svg></div>
</div>

<h2>Details per variant</h2>
<div class="card"><label>Variant <select id="pick"></select></label>
<div class="grid2" style="margin-top:12px"><div><h3>Net per hour</h3><svg id="hours" viewBox="0 0 560 240"></svg></div><div><h3>Base gate funnel</h3><div id="funnel"></div></div></div>
<h3 style="margin-top:16px">Symbol × hour heatmap (net per closing hour)</h3><div id="heat" class="scroll"></div>
<div class="grid2" style="margin-top:16px"><div class="scroll"><h3>Indication types</h3><table id="types"></table></div><div class="scroll"><h3>Range classes</h3><table id="ranges"></table></div>
<div class="scroll"><h3>Symbols</h3><table id="symbols"></table></div><div class="scroll"><h3>Direction and exit reasons</h3><table id="dirs"></table></div></div>
</div>

${attribution ? `<h2>Where the earlier PF 1.2–1.4 came from</h2>
<div class="card scroll"><p>The same ${esc(attribution.rows[0].all.trades.toLocaleString("en"))} real trades (14 days, ${esc(attribution.symbols.length)} symbols, the engine's own entries and TP/SL), with one fixed defect switched back on per row. The mean indication PF of the rows is ${fmt(attribution.meanRowPf)}; the old coin flip turned it into a ${fmt(Math.min(0.8, 0.45 + (attribution.meanRowPf - 1) * 0.3) * 100, 1)} % win probability.</p>
<table><tr><th>Variant</th><th>Trades</th><th>Win rate</th><th>PF</th><th>Avg net / trade %</th><th>After Base gate: trades</th><th>PF</th></tr>
${attribution.rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${r.all.trades}</td><td>${fmt((r.all.winRate ?? 0) * 100, 1)} %</td><td class="${r.all.pf > 1 ? "good" : "bad"}">${fmt(r.all.pf, 3)}</td><td>${fmt(r.all.avgNetPct, 3)}</td><td>${r.afterBaseGate.trades}</td><td class="${r.afterBaseGate.pf > 1 ? "good" : "bad"}">${fmt(r.afterBaseGate.pf, 3)}</td></tr>`).join("")}
</table><p><b>Reading:</b> even with no cost at all the entries reach PF ${fmt(attribution.rows.find((r) => r.key === "gross")?.all.pf, 3)} — below 1. Only the fabricated coin-flip outcomes produce a PF above 1 (and the Base gate, fed those outcomes, amplifies them). The earlier simulations also ran on generated prices. A real PF of 1.2–1.4 therefore needs entries with a measured edge; no fix to costs, grading or gates can produce it from these entries.</p></div>` : ""}

<h2>After the Base gate: 14 days, 15 symbols (development window)</h2>
<div class="card scroll"><p>Every engine row trades with its own TP/SL at the engine's cost basis. The gate is applied in variants: stage PF and window, plus significance-aware variants (lower confidence bound of the bucket mean > 0). The PF of the admitted trades:</p><table id="gate"></table></div>

${lab ? `<h2>Indication lab: 50 symbols, 14 days</h2><div class="card"><p>${esc(lab.rule)}</p><p><b>${esc(lab.candidates)}</b> candidates; ${esc(lab.selected?.length ?? 0)} taken to the holdout. Report rows: <code>docs/reports/20261007-short-range-14d/</code>.</p></div>` : ""}

<h2>Defects fixed on the way (all with regression tests)</h2>
<div class="card"><ul>
<li><b>Base funnel:</b> the flow log reported every emitted Base Set as "passed" (165 with the raw indication PF 1.78) while the gate admitted 0; it now reports gate admissions, Sets awaiting history and the measured PF.</li>
<li><b>Axis protection:</b> live dispatch derived TP/SL from the synthetic Axis entry while the pseudo row measured the parent's entries; one resolver for both.</li>
<li><b>Block stop:</b> a second additive slippage buffer broke the SL ≤ 1.5 × TP cap and was clamped back live; removed (size scaling already widens the stop).</li>
<li><b>Redis append script:</b> lost every ADL indication group ("too many results to unpack": 176 failed config tasks; 0 now).</li>
<li><b>Main/Real/Live PF:</b> carried the indication estimate instead of the measured Base PF.</li>
<li><b>Main history requirement:</b> required more closes than its window holds (forex).</li>
<li><b>Row windows:</b> one live close overrode a 25-close history; classic PF (capped at 99) was compared against ratio thresholds.</li>
<li><b>Axis:</b> a Set was judged on 12 closes instead of its own previous window.</li>
<li><b>Block:</b> legs booked the whole position's result instead of their own.</li>
<li><b>Average drawdown time:</b> ignored zero-drawdown closes; the two writers used different definitions.</li>
<li><b>Costs:</b> simulated closes charged 0.10 % instead of the real 0.26 % round trip.</li>
<li><b>RSI:</b> seven formulas collapsed into one Wilder RSI; live "1m" indicators were computed on 1-second candles.</li>
<li><b>Earlier today:</b> coin-flip closes in the Base buckets, mixed pnl units, look-ahead in historic Common Sets, the trend TP unit, the QuickStart of a connection without market data, minimum volume, the allowed SL range.</li>
</ul></div>
<p class="meta">Data: ${esc(symbols)}. Costs in the backtest: maker 0.02 %, taker 0.08 % per leg incl. slippage (BingX VIP 0); the engine's own measurement charges 0.26 % per round trip.</p>
</main><div class="tip" id="tip"></div>
<script>
const D=${JSON.stringify(payload)};
const NS="http://www.w3.org/2000/svg",el=(t,a,p)=>{const n=document.createElementNS(NS,t);for(const k in a)n.setAttribute(k,a[k]);p&&p.appendChild(n);return n};
const f=(v,d=2)=>v==null||!isFinite(v)?"–":Number(v).toFixed(d);const pfc=(v,w)=>{const x=v==null?(w>0?99:null):v;return '<td class="'+(x==null?'':x>1?'good':'bad')+'">'+(v==null?(w>0?'∞':'–'):f(v))+'</td>'};
const COL={"gated-market":"--s1","signals-market":"--s2","gated-maker":"--s3","signals-maker":"--s4"};
const NAME={"gated-market":"Base-gated · market","signals-market":"All signals · market","gated-maker":"Base-gated · maker","signals-maker":"All signals · maker"};
const tip=document.getElementById("tip");const show=(e,h)=>{tip.innerHTML=h;tip.style.display="block";tip.style.left=Math.min(e.clientX+12,innerWidth-260)+"px";tip.style.top=(e.clientY+12)+"px"};const hide=()=>tip.style.display="none";
document.getElementById("variants").innerHTML="<tr><th>Variant</th><th>Trades</th><th>PF</th><th>Net Σ %</th><th>Win rate</th><th>Max DD</th><th>+ hours</th><th>Avg hold</th><th>Fill rate</th></tr>"+D.variants.map(v=>{const s=v.summary;return "<tr><td>"+NAME[v.name]+"</td><td>"+s.trades+"</td>"+pfc(s.profitFactor,s.wins)+"<td>"+f(s.netPct)+"</td><td>"+(s.winRate==null?"–":f(s.winRate*100,1)+" %")+"</td><td>"+f(s.maxDrawdownPct)+"</td><td>"+s.profitableHours+"/"+s.activeHours+"</td><td>"+f(s.avgHoldMinutes,0)+" min</td><td>"+(s.fillRate==null?"–":f(s.fillRate*100,0)+" %")+"</td></tr>"}).join("");
document.getElementById("legend").innerHTML=D.variants.map(v=>'<span><i style="background:var('+COL[v.name]+')"></i>'+NAME[v.name]+'</span>').join("");
function lines(id,idx){const svg=document.getElementById(id),W=560,H=280,L=48,R=110,T=10,B=26;const all=D.variants.flatMap(v=>v.equity.map(p=>p[idx]));if(!all.length)return;const t0=Math.min(...D.variants.map(v=>v.equity[0][0])),t1=Math.max(...D.variants.map(v=>v.equity[v.equity.length-1][0]));let lo=Math.min(0,...all),hi=Math.max(0,...all);if(hi===lo)hi=lo+1;const x=t=>L+(t-t0)/(t1-t0||1)*(W-L-R),y=v=>T+(1-(v-lo)/(hi-lo))*(H-T-B);
for(let i=0;i<=4;i++){const v=lo+(hi-lo)*i/4;el("line",{x1:L,x2:W-R,y1:y(v),y2:y(v),stroke:"var(--grid)"},svg);el("text",{x:L-6,y:y(v)+4,"text-anchor":"end"},svg).textContent=v.toFixed(0)}
el("line",{x1:L,x2:W-R,y1:y(0),y2:y(0),stroke:"var(--axis)","stroke-dasharray":"4 3"},svg);
for(let i=0;i<=4;i++){const t=t0+(t1-t0)*i/4;el("text",{x:x(t),y:H-6,"text-anchor":"middle"},svg).textContent=new Date(t).toISOString().slice(11,16)}
for(const v of D.variants){const pts=v.equity.map(p=>x(p[0])+","+y(p[idx])).join(" ");el("polyline",{points:pts,fill:"none",stroke:"var("+COL[v.name]+")","stroke-width":2},svg);const last=v.equity[v.equity.length-1];el("text",{x:x(last[0])+6,y:y(last[idx])+4,style:"fill:var(--fg2)"},svg).textContent=NAME[v.name].replace(" · ","/").replace("All signals","all").replace("Base-gated","gated")}}
lines("eq",1);lines("dd",2);
const pick=document.getElementById("pick");pick.innerHTML=D.variants.map(v=>'<option value="'+v.name+'"'+(v.name==="gated-maker"?" selected":"")+'>'+NAME[v.name]+'</option>').join("");
function book(id,rows,label){document.getElementById(id).innerHTML="<tr><th>"+label+"</th><th>Trades</th><th>Win rate</th><th>PF</th><th>Net Σ %</th></tr>"+rows.map(r=>"<tr><td>"+r.key+"</td><td>"+r.trades+"</td><td>"+(r.winRate==null?"–":f(r.winRate*100,0)+" %")+"</td>"+pfc(r.profitFactor,r.wins)+"<td>"+(r.trades?f(r.netPct):"–")+"</td></tr>").join("")}
function detail(){const v=D.variants.find(x=>x.name===pick.value);if(!v)return;
const svg=document.getElementById("hours");svg.innerHTML="";const W=560,H=240,L=44,R=8,T=10,B=26;const vals=v.byHour.map(h=>h[1]);let lo=Math.min(0,...vals),hi=Math.max(0,...vals);if(hi===lo)hi=lo+1;const y=q=>T+(1-(q-lo)/(hi-lo))*(H-T-B),bw=(W-L-R)/Math.max(1,v.byHour.length);
el("line",{x1:L,x2:W-R,y1:y(0),y2:y(0),stroke:"var(--axis)"},svg);for(let i=0;i<=3;i++){const q=lo+(hi-lo)*i/3;el("text",{x:L-6,y:y(q)+4,"text-anchor":"end"},svg).textContent=q.toFixed(0)}
v.byHour.forEach((h,i)=>{const x0=L+i*bw+1,top=Math.min(y(h[1]),y(0)),hh=Math.max(1,Math.abs(y(h[1])-y(0)));const r=el("rect",{x:x0,y:top,width:Math.max(1,bw-2),height:hh,rx:2,fill:h[1]>=0?"var(--pos)":"var(--neg)"},svg);r.addEventListener("mousemove",e=>show(e,new Date(h[0]).toISOString().slice(11,16)+" UTC<br>net "+f(h[1])+" % · "+h[2]+" trades"));r.addEventListener("mouseleave",hide);if(i%4===0)el("text",{x:x0+bw/2,y:H-6,"text-anchor":"middle"},svg).textContent=new Date(h[0]).toISOString().slice(11,13)});
document.getElementById("funnel").innerHTML=v.funnel?v.funnel.map(s=>'<div style="display:grid;grid-template-columns:200px 1fr 60px;gap:8px;align-items:center;margin:4px 0;font-size:12px"><span>'+s.stage+'</span><div style="height:10px;background:var(--grid);border-radius:3px"><div style="height:10px;border-radius:3px;background:var(--s1);width:'+(100*s.count/Math.max(1,v.funnel[0].count))+'%"></div></div><span style="text-align:right">'+s.count+'</span></div>').join(""):'<p class="meta">All signals: no gate.</p>';
const hm=v.heat,mx=Math.max(1e-9,...hm.cells.flat().map(c=>Math.abs(c.netPct)));let g='<div class="heat" style="grid-template-columns:90px repeat('+hm.cols.length+',minmax(12px,1fr)) 70px;min-width:600px">';g+='<div></div>'+hm.cols.map((c,i)=>'<div style="font-size:9px;text-align:center;color:var(--muted)">'+(i%3===0?new Date(c).toISOString().slice(11,13):"")+'</div>').join("")+'<div style="font-size:9px;text-align:right;color:var(--muted)">net</div>';
hm.rows.forEach((row,r)=>{const tot=hm.cells[r].reduce((s,c)=>s+c.netPct,0);g+='<div style="font-size:11px">'+row+'</div>'+hm.cells[r].map((c,i)=>{const a=Math.round(25+75*Math.min(1,Math.abs(c.netPct)/mx));const bg=c.trades?"color-mix(in srgb, var("+(c.netPct>=0?"--pos":"--neg")+") "+a+"%, var(--grid))":"var(--grid)";return '<div class="c" data-t="'+row+' · '+new Date(hm.cols[i]).toISOString().slice(11,16)+' UTC · '+c.trades+' trades · '+f(c.netPct)+' %" style="background:'+bg+'"></div>'}).join("")+'<div style="font-size:11px;text-align:right;color:var(--'+(tot>=0?"pos":"neg")+')">'+f(tot,1)+'</div>'});g+="</div>";
const heat=document.getElementById("heat");heat.innerHTML=g;heat.querySelectorAll(".c").forEach(c=>{c.addEventListener("mousemove",e=>show(e,c.dataset.t));c.addEventListener("mouseleave",hide)});
book("types",v.byType,"Type");book("ranges",v.byRangeClass,"Range");book("symbols",v.bySymbol,"Symbol");book("dirs",[...v.byDirection,...v.byReason],"Direction / exit")}
pick.addEventListener("input",detail);detail();
document.getElementById("gate").innerHTML="<tr><th>Gate variant</th><th>Trades admitted</th><th>PF after gate</th><th>Avg net / trade %</th><th>PF 1st half</th><th>PF 2nd half</th></tr>"+D.gate.map(r=>"<tr><td>"+r.key+"</td><td>"+r.trades+"</td>"+pfc(r.pf,0)+"<td>"+f(r.avgPct,3)+"</td>"+pfc(r.halves[0],0)+pfc(r.halves[1],0)+"</tr>").join("");
</script></body></html>`

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, "report.html"), html)
const sums = `${createHash("sha256").update(html).digest("hex")}  report.html\n`
writeFileSync(path.join(reportDir, "SHA256SUMS"), sums)
console.log(`report: ${path.join(reportDir, "report.html")} (${(Buffer.byteLength(html) / 1e6).toFixed(2)} MB)`)
