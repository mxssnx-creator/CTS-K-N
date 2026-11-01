/** Frozen 14-day entry-rule comparison, public completed OHLCV only.
 * Usage: node --import tsx scripts/audit-common-extension-replay.ts BARS_DIR OUT_DIR FIRST_DAY SYMBOLS
 * This is an independent unit-notional research replay, not the live engine or
 * a portfolio. Candidates are selected on days 1–7 before days 8–14 are scored.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { COMMON_INDICATOR_DEFINITIONS, DEFAULT_COMMON_INDICATION_SETTINGS, commonIndicatorParameterConfigurations, type CommonIndicatorSettings } from "@/lib/common-indicator-config"
import { createCommonSeriesContext } from "@/lib/common-indicators/context"
import { resampleNormalizedCandles } from "@/lib/common-indicators/kn-math"
import { COMMON_RULES, commonRuleStates } from "@/lib/common-indicators/registry"
import type { TechnicalCandle } from "@/lib/common-indicators/types"
import { simulateExits, bookResearchCloses, type ExitConfig, type ResearchSignal, type ResearchBook } from "@/lib/short-range-exits"
import { roundTripCostPercent } from "@/lib/trading-round-trip-cost"

const [barsDir, outDir, firstDay, symbolArg] = process.argv.slice(2)
if (!barsDir || !outDir || !firstDay || !symbolArg) throw new Error("Expected BARS_DIR OUT_DIR FIRST_DAY SYMBOLS")
const DAY = 86_400_000, MINUTE = 60_000
const first = Date.parse(`${firstDay}T00:00:00Z`), split = first + 7 * DAY, end = first + 14 * DAY
if (!Number.isFinite(first) || end > Math.floor(Date.now() / DAY) * DAY) throw new Error("Requires 14 completed UTC days")
const symbols = [...new Set(symbolArg.split(",").map(s => s.trim().toUpperCase()).filter(Boolean))]
const types = new Set(["relativeVigor", "lowRangeEdgeTurn", "lowRangeFailedBreak", "lowRangeBreakout", "lowRangeMidReclaim", "lowRangeCompressionBreak"])
const definitions = COMMON_INDICATOR_DEFINITIONS.filter(d => types.has(d.type))
const timeframes = [1, 5, 15, 30]
const costs = { base: roundTripCostPercent(), stress: roundTripCostPercent() * 1.5 }
const exits: Array<ExitConfig & { id: string }> = [
  { id: "tp0.3-sl0.3-h15", takeProfitPct: 0.3, stopLossPct: 0.3, maxHoldMs: 15 * MINUTE },
  { id: "tp0.5-sl0.4-h60", takeProfitPct: 0.5, stopLossPct: 0.4, maxHoldMs: 60 * MINUTE },
  { id: "tp1-sl0.75-h240", takeProfitPct: 1, stopLossPct: 0.75, maxHoldMs: 240 * MINUTE },
]
// The same fixed grid is frozen for every symbol, type, parameter tuple and direction.
const protocol = { firstDay, days: 14, trainingDays: 7, validationDays: 7, symbols, timeframes, types: [...types], exits, costs,
  selection: "training >=30 closes, PF>1.05 and positive net at both base and 1.5x cost; validation >=12 closes and PF>1/positive net at both costs",
  caveat: "Independent unit-notional candidate replay. Overlapping configurations are not a portfolio; no venue fills or full Base/Main/Real engine pass are claimed. Fixed TP/SL only; trailing, Block, DCA and source Signals are covered separately by lifecycle/regression tests.",
  execution: "Decision at completed timeframe close; first exit on next minute; gaps validated before scoring; if both levels touch, stop wins; cost charged once per closed trade; open trades crossing the split are excluded from validation.",
}
mkdirSync(outDir, { recursive: true })
writeFileSync(path.join(outDir, "protocol.json"), JSON.stringify(protocol, null, 2))
const dataHashes: Record<string, string> = {}
const rows: Array<Record<string, any>> = []
const compact = (book: ResearchBook) => ({ trades: book.trades, pf: Number.isFinite(book.profitFactor) ? book.profitFactor : null,
  infinitePf: book.profitFactor === Infinity, net: book.netPct, drawdown: book.maxDrawdownPct, activeHours: book.activeHours, greenHours: book.profitableHours })
const positive = (book: ResearchBook, min: number, pf: number) => book.trades >= min && (book.profitFactor ?? 0) > pf && book.netPct > 0

for (const symbol of symbols) {
  const bars: TechnicalCandle[] = []
  const hash = createHash("sha256")
  for (let day = 0; day < 14; day++) {
    const start = first + day * DAY
    const name = `${symbol}_${new Date(start).toISOString().slice(0, 10)}.json`
    const bytes = readFileSync(path.join(barsDir, name))
    hash.update(bytes)
    const daily = JSON.parse(bytes.toString()) as TechnicalCandle[]
    if (daily.length !== 1440) throw new Error(`${name}: incomplete day`)
    daily.forEach((bar, index) => {
      if (bar.timestamp !== start + index * MINUTE || ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
        || bar.low <= 0 || bar.volume < 0 || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) {
        throw new Error(`${name}: invalid OHLCV at ${index}`)
      }
    })
    bars.push(...daily)
  }
  dataHashes[symbol] = hash.digest("hex")
  for (const tf of timeframes) {
    const resampled = resampleNormalizedCandles(bars, tf)
    const ctx = createCommonSeriesContext(resampled, { normalized: true, tfMin: tf })
    for (const def of definitions) {
      const rule = COMMON_RULES.get(def.type)!
      const tuples = commonIndicatorParameterConfigurations(def, DEFAULT_COMMON_INDICATION_SETTINGS[def.storageKey] as CommonIndicatorSettings)
      for (const tuple of tuples) {
        const state = commonRuleStates(ctx, rule, tuple)
        for (const direction of ["long", "short"] as const) {
          const sign = direction === "long" ? 1 : -1
          const signals: ResearchSignal[] = []
          for (let i = 0; i < state.length; i++) if (state[i] === sign) {
            signals.push({ type: def.type, rule: JSON.stringify(tuple), direction,
              entryTime: resampled[i].timestamp + tf * MINUTE, entryPrice: resampled[i].close, profitFactor: 1 })
          }
          for (const exit of exits) {
            const closes = simulateExits(bars, signals, exit)
            const train = closes.filter(c => c.exitTime < split)
            const base = bookResearchCloses(train, costs.base), stress = bookResearchCloses(train, costs.stress)
            const selected = positive(base, 30, 1.05) && positive(stress, 30, 1.05)
            const hold = selected ? closes.filter(c => c.entryTime >= split && c.exitTime < end) : []
            const validation = selected ? bookResearchCloses(hold, costs.base) : null
            const validationStress = selected ? bookResearchCloses(hold, costs.stress) : null
            rows.push({ symbol, type: def.type, tf, tuple, direction, exit: exit.id,
              training: compact(base), trainingStress: compact(stress), selected,
              validation: validation ? compact(validation) : null, validationStress: validationStress ? compact(validationStress) : null,
              validated: Boolean(validation && validationStress && positive(validation, 12, 1) && positive(validationStress, 12, 1)) })
          }
        }
      }
    }
  }
  console.log(`${symbol}: ${rows.length} configurations evaluated cumulatively`)
}
const selected = rows.filter(r => r.selected), validated = rows.filter(r => r.validated)
const summary = { configurations: rows.length, trainingSelected: selected.length, trainingValidatedPct: selected.length / rows.length * 100,
  independentValidated: validated.length, validationRetainedPct: selected.length ? validated.length / selected.length * 100 : 0,
  dataBars: symbols.length * 14 * 1440, dataHashes,
  bestValidated: [...validated].sort((a,b) => a.validation.drawdown - b.validation.drawdown || b.validation.pf - a.validation.pf).slice(0, 15) }
writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ protocol, summary, rows }))
const payload = JSON.stringify({ protocol, summary, rows }).replace(/</g, "\\u003c")
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CTS-K-N Common extension audit</title>
<style>body{font:15px system-ui;background:#101823;color:#edf4fa;margin:0;padding:30px;line-height:1.6}main{max-width:1400px;margin:auto}h1{font-size:30px}p{max-width:1050px}select,input{background:#1b2a3a;color:white;padding:9px;margin:8px;border:1px solid #52708a;border-radius:5px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:9px;border-bottom:1px solid #304255}th{color:#9bcbff}button{padding:8px;margin:6px}.positive{color:#86e1b2}.negative{color:#ffaba5}.cards{display:flex;gap:15px;flex-wrap:wrap}.card{background:#1b2a3a;padding:15px;border-radius:7px}.scroll{overflow:auto}</style>
<main><h1>CTS-K-N · Common extension replay</h1><p id="dates"></p><div class="cards" id="cards"></div><p>Each row is an independent unit-notional candidate. These overlapping results are not a portfolio, engine-stage acceptance, or venue executions. No defaults are promoted by this report. Training selection was frozen before validation scoring.</p>
<p>Costs: 0.15% round trip; 0.225% stress. Both TP and SL touched means stop first. The first seven UTC days select candidates; the next seven validate only those candidates. Results include RVI plus five Low-Range methods, every default parameter tuple, four timeframes and both directions. Protection grid: 0.3/0.3% (15m), 0.5/0.4% (60m), 1/0.75% (240m).</p>
<label>Type <select id="type"><option value="">All</option></select></label><label>Symbol <select id="symbol"><option value="">All</option></select></label><label>Sample <select id="sample"><option value="validated">Validation passed</option><option value="selected">Training selected</option><option value="all">All evaluated</option></select></label><label>Search <input id="query" placeholder="Direction, timeframe, parameters"></label><p id="count"></p><div class="scroll"><table><thead><tr><th>Symbol / type</th><th>TF / side / parameters</th><th>Exit</th><th>Train PF / trades</th><th>Train stress PF</th><th>Validation PF / trades</th><th>Validation stress PF</th><th>Validation DD / net (pp)</th><th>Green / active hours</th></tr></thead><tbody id="body"></tbody></table></div><button id="prev">Previous</button><button id="next">Next</button><p>Coverage limits: fixed exits; no Block/DCA sizing, trailing or live Signal provider history. No live profitability or all-hour positivity is claimed. Reports of Stage Base/Main/Real/Live are verified separately against the actual engine.</p></main>
<script>const data=${payload};const $=s=>document.getElementById(s);const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const fmt=n=>n===null||n===undefined?'—':Number(n).toFixed(3);const pf=b=>!b?'—':b.infinitePf?'∞':fmt(b.pf);$('dates').textContent=data.protocol.firstDay+' · 14 complete UTC days · '+data.protocol.symbols.length+' symbols · '+data.summary.dataBars.toLocaleString()+' real 1m bars';$('cards').innerHTML=[['Configurations',data.summary.configurations],['Training selected',data.summary.trainingSelected],['Training validated %',fmt(data.summary.trainingValidatedPct)],['Validation passed',data.summary.independentValidated],['Retained %',fmt(data.summary.validationRetainedPct)]].map(([k,v])=>'<div class="card">'+esc(k)+'<br><strong>'+esc(v)+'</strong></div>').join('');for(const id of ['type','symbol'])for(const value of [...new Set(data.rows.map(r=>r[id]))].sort())$(id).add(new Option(value,value));let page=0;function render(){let rows=data.rows.filter(r=>(!$('type').value||r.type===$('type').value)&&(!$('symbol').value||r.symbol===$('symbol').value)&&($('sample').value==='all'||r[$('sample').value])&&JSON.stringify(r).toLowerCase().includes($('query').value.toLowerCase()));page=Math.min(page,Math.max(0,Math.ceil(rows.length/100)-1));$('count').textContent=rows.length+' matching configurations · page '+(page+1)+' / '+Math.max(1,Math.ceil(rows.length/100));$('body').innerHTML=rows.slice(page*100,page*100+100).map(r=>'<tr><td>'+esc(r.symbol)+'<br>'+esc(r.type)+'</td><td>'+r.tf+'m '+r.direction+'<br>'+esc(JSON.stringify(r.tuple))+'</td><td>'+esc(r.exit)+'</td><td>'+pf(r.training)+' / '+r.training.trades+'</td><td>'+pf(r.trainingStress)+'</td><td>'+pf(r.validation)+' / '+(r.validation?.trades??'—')+'</td><td>'+pf(r.validationStress)+'</td><td>'+fmt(r.validation?.drawdown)+' / '+fmt(r.validation?.net)+'</td><td>'+(r.validation?r.validation.greenHours+' / '+r.validation.activeHours:'—')+'</td></tr>').join('');$('prev').disabled=page===0;$('next').disabled=(page+1)*100>=rows.length}for(const id of ['type','symbol','sample','query'])$(id).oninput=()=>{page=0;render()};$('prev').onclick=()=>{page--;render()};$('next').onclick=()=>{page++;render()};render()</script></html>`
writeFileSync(path.join(outDir, "CTS-K-N-common-extension-audit.html"), html)
console.log(JSON.stringify(summary, null, 2))
