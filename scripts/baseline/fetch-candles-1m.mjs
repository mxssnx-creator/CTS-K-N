const SYMBOLS=["BTC-USDT","ETH-USDT","SOL-USDT","XRP-USDT","BCH-USDT","LTC-USDT","ADA-USDT","AVAX-USDT","LINK-USDT","DOGE-USDT","DOT-USDT","MATIC-USDT","UNI-USDT","ATOM-USDT","ETC-USDT","FIL-USDT","APT-USDT","ARB-USDT","OP-USDT","NEAR-USDT","INJ-USDT","SUI-USDT","SEI-USDT","TIA-USDT","AAVE-USDT","RUNE-USDT","LDO-USDT","STX-USDT","IMX-USDT","GRT-USDT"]
const out={}; let ok=0
for(const s of SYMBOLS){ try{
  const r=await fetch(`https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${s}&interval=1m&limit=1440`)
  const j=await r.json()
  const rows=(j?.data||[]).map(k=>({time:Number(k.time),open:+k.open,high:+k.high,low:+k.low,close:+k.close,volume:+k.volume}))
    .filter(c=>c.time>0&&c.open>0).sort((a,b)=>a.time-b.time)
  if(rows.length>1000){ out[s.replace("-","")]=rows; ok++ }
}catch{} }
const fs=await import("node:fs"); fs.writeFileSync(process.env.CTS_BASELINE_CANDLES || "/tmp/sim/candles30.json", JSON.stringify(out))
const any=Object.values(out)[0]
console.log(`symbols=${ok} candles=${any?any.length:0} span=${any?((any.at(-1).time-any[0].time)/3600000).toFixed(1):0}h`)
