import { readFileSync } from "node:fs"
import { deriveConfigSignals } from "@/lib/historic-test-config-signals"
import { deriveAxisTrades, deriveBlockTrades } from "@/lib/historic-test-family-derivations"
import { roundTripCostPercent } from "@/lib/trading-round-trip-cost"
import type { HistoricTestTrade } from "@/lib/historic-test-scoring"

const candles: Record<string, any[]> = JSON.parse(readFileSync(process.env.CTS_BASELINE_CANDLES || "/tmp/sim/candles30.json", "utf8"))
const SYMBOLS = Object.keys(candles).slice(0, 22)
const PC=0.1, COST=roundTripCostPercent(), TP=PC*5, SL=PC*20, HOLD=240, EVAL=50
const START=10, LEV=5, MAX_POS=100
// Risk-normalised sizing: a full stop-loss costs RISK_PER_POS of balance.
// Without this the R-lever of the stop geometry (22.6R on a stop) times 100
// concurrent positions made one bad hour exceed the whole account.
const RISK_PER_POS = 0.003
const SL_R = Math.abs((-SL - COST) / PC)          // R lost on a full stop
type T = HistoricTestTrade & { sym:string; openedAt:number; closedAt:number; family:string }
function resolve(rows:any[], s:any, sym:string): T|null {
  const st=s.index+1,e=rows[st]; if(!e) return null
  const en=e.close,lg=s.direction==="long",fav=(p:number)=>(lg?p-en:en-p)/en*100
  const last=Math.min(rows.length-1,st+HOLD)
  for(let i=st+1;i<=last;i++){const c=rows[i]
    if(fav(lg?c.low:c.high)<=-SL) return {signedResultR:(-SL-COST)/PC,openedAt:e.time,closedAt:c.time,sym,family:""}
    if(fav(lg?c.high:c.low)>=TP) return {signedResultR:(TP-COST)/PC,openedAt:e.time,closedAt:c.time,sym,family:""}}
  const x=rows[last]; return {signedResultR:(fav(x.close)-COST)/PC,openedAt:e.time,closedAt:x.time,sym,family:""}
}
const pf=(t:readonly {signedResultR:number}[])=>t.length?1+(t.reduce((s,x)=>s+x.signedResultR,0)/t.length)*0.1:1
const RANGES = Array.from({length:44},(_,i)=>i+5)

// ── STAGE BASE: every indication config, validated on its own last-50 window.
let rawN=0, rawSum=0
const lanes: T[][] = []
for (const sym of SYMBOLS) for (const range of RANGES) {
  const sig=deriveConfigSignals(candles[sym] as any,{range,drawdownRatio:1,lastPartRatio:0.5,factorMultiplier:1})
  if(sig.length<EVAL) continue
  const all=sig.map(s=>resolve(candles[sym],s,sym)).filter(Boolean) as T[]
  rawN+=all.length; rawSum+=all.reduce((s,t)=>s+t.signedResultR,0)
  if(all.length>=EVAL && pf(all.slice(-EVAL))>=1.1) lanes.push(all)
}
// ── STAGE MAIN: Axis is the strategy.  ── STAGE REAL: Block on the Main output.
const axisLanes = lanes.map(l=>(deriveAxisTrades(l as any,{prev:6,last:2,cont:1,pause:8}) as T[]).map(t=>({...t,family:"axis"})))
const blockLanes = axisLanes.flatMap(l=>[1,2].map(c=>(deriveBlockTrades(l as any,{volumeRatio:0.2,maxStack:6,fixedCount:c,incrementSteps:3}) as T[]).map(t=>({...t,family:`block${c}`}))))
const candidates = [...axisLanes.flat(), ...blockLanes.flat()].sort((a,b)=>a.openedAt-b.openedAt)

console.log(`════ 24h COMPLETE SIMULATION — ${SYMBOLS.length} symbols, windows 5–48, cost ${COST.toFixed(3)}% ════`)
console.log(`STAGE BASE   raw ${rawN} trades  PF=${(rawN?1+(rawSum/rawN)*0.1:1).toFixed(4)}   validated lanes ${lanes.length}`)
console.log(`STAGE MAIN   axis ${axisLanes.flat().length} trades  PF=${pf(axisLanes.flat()).toFixed(4)}`)
console.log(`STAGE REAL   block ${blockLanes.flat().length} trades  PF=${pf(blockLanes.flat()).toFixed(4)}`)
console.log(`sizing: a full stop costs ${(RISK_PER_POS*100).toFixed(2)}% of balance (SL = ${SL_R.toFixed(1)}R), max ${MAX_POS} concurrent`)

// ── Venue replay: MAX_POS concurrent, risk-normalised size, no negative balance.
let t0=Infinity,t1=-Infinity; for(const t of candidates){ if(t.openedAt<t0)t0=t.openedAt; if(t.closedAt>t1)t1=t.closedAt }
const H=Math.max(1,Math.ceil((t1-t0)/3600000))
let bal=START, peak=START, maxDDpct=0, open: Array<T&{unit:number}>=[], cursor=0, rejected=0
const taken: Array<T&{pnl:number}> = []
const rows: any[] = []
for (let h=0; h<H; h++) {
  const hEnd=t0+(h+1)*3600000
  const closing: Array<T&{unit:number}> = []
  open = open.filter(p=>{ if(p.closedAt<hEnd){ closing.push(p); return false } return true })
  while (cursor<candidates.length && candidates[cursor].openedAt<hEnd) {
    const c=candidates[cursor++]
    if (open.length>=MAX_POS){ rejected++; continue }
    // R-unit sized so that the stop costs RISK_PER_POS of current balance.
    const unit = (RISK_PER_POS*Math.max(0,bal))/SL_R
    if (c.closedAt<hEnd) closing.push({...c,unit}); else open.push({...c,unit})
  }
  let pnl=0, wins=0
  for (const p of closing){ const v=p.signedResultR*p.unit; pnl+=v; if(v>0)wins++; taken.push({...p,pnl:v}) }
  bal=Math.max(0,bal+pnl)
  if(bal>peak) peak=bal
  const ddPct = peak>0 ? (peak-bal)/peak*100 : 0
  if(ddPct>maxDDpct) maxDDpct=ddPct
  const margin = open.reduce((s,p)=>s+p.unit*SL_R/LEV,0)
  const fam = (f:string)=>closing.filter(p=>p.family.startsWith(f))
  rows.push({h:h+1, bal, ddPct, pnl, open:open.length, closed:closing.length, orders:closing.length*3,
    win: closing.length? wins/closing.length*100:0, pf: closing.length? pf(closing):1,
    pfAxis: fam("axis").length? pf(fam("axis")):null, pfBlock: fam("block").length? pf(fam("block")):null,
    margin, notional: margin*LEV})
}
const f=(n:number,w:number,d=2)=>n.toFixed(d).padStart(w)
const o=(n:number|null,w:number)=>(n===null?"—":n.toFixed(3)).padStart(w)
console.log(`\n hr   balance    pnl   dd%   open closed orders  win%    PF   PF_axis PF_block  margin  notional`)
for (const r of rows) console.log(`${String(r.h).padStart(3)} ${f(r.bal,9,4)} ${f(r.pnl,7,3)} ${f(r.ddPct,5,1)} ${String(r.open).padStart(5)} ${String(r.closed).padStart(6)} ${String(r.orders).padStart(6)} ${f(r.win,5,1)} ${f(r.pf,6,3)} ${o(r.pfAxis,8)} ${o(r.pfBlock,8)} ${f(r.margin,7,3)} ${f(r.notional,8,3)}`)
const act=rows.filter(r=>r.closed>0), pos=act.filter(r=>r.pf>1)
const wins=taken.filter(t=>t.pnl>0), losses=taken.filter(t=>t.pnl<0)
const gp=wins.reduce((s,t)=>s+t.pnl,0), gl=Math.abs(losses.reduce((s,t)=>s+t.pnl,0))
console.log(`\n════ SUMMARY ════`)
console.log(`balance        $${START.toFixed(2)} → $${bal.toFixed(4)}   return ${((bal/START-1)*100).toFixed(2)}%`)
console.log(`max drawdown   ${maxDDpct.toFixed(2)}%     peak $${peak.toFixed(4)}`)
console.log(`positions      ${taken.length} taken, ${rejected} rejected by the ${MAX_POS}-position cap`)
console.log(`orders         ${taken.length*3}     (entry + stop-loss + take-profit per position)`)
console.log(`win rate       ${(wins.length/Math.max(1,taken.length)*100).toFixed(1)}%    avg win $${(gp/Math.max(1,wins.length)).toFixed(4)}  avg loss $${(gl/Math.max(1,losses.length)).toFixed(4)}`)
console.log(`profit factor  ${gl>0?(gp/gl).toFixed(4):"∞"} (gross)   ${pf(taken).toFixed(4)} (R-normalised)`)
console.log(`positive hours ${pos.length}/${act.length} (${(pos.length/Math.max(1,act.length)*100).toFixed(0)}%)`)
console.log(`max open       ${Math.max(...rows.map(r=>r.open))}    max margin $${Math.max(...rows.map(r=>r.margin)).toFixed(4)}`)
