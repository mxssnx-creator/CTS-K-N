import type { Candle } from "@/lib/bots/backtest"

const BASE = "https://open-api.bingx.com"
const DAY = 1440

/** Most liquid USDT perpetuals by 24 h quote volume (public endpoint). */
export async function liquidSymbols(limit: number): Promise<string[]> {
  const r: any = await fetch(`${BASE}/openApi/swap/v2/quote/ticker`, { cache: "no-store" }).then((x) => x.json())
  const rows: any[] = Array.isArray(r?.data) ? r.data : []
  return rows
    .filter((t) => String(t.symbol).endsWith("-USDT"))
    .map((t) => ({ s: String(t.symbol), v: Number(t.quoteVolume || 0) }))
    .filter((t) => Number.isFinite(t.v) && t.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, limit)
    .map((t) => t.s)
}

/** 1-minute candles covering `hours` plus a warm-up, fetched in day-sized pages. */
export async function minuteCandles(symbol: string, hours: number, end = Date.now()): Promise<Candle[]> {
  const bars = hours * 60 + 180
  const pages = Math.ceil(bars / DAY)
  let all: Candle[] = []
  for (let k = pages - 1; k >= 0; k--) {
    const st = end - (k + 1) * DAY * 60_000, en = end - k * DAY * 60_000
    const r: any = await fetch(`${BASE}/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=1m&limit=${DAY}&startTime=${st}&endTime=${en}`, { cache: "no-store" })
      .then((x) => x.json()).catch(() => null)
    const rows = (r?.data || []).map((x: any) => ({ time: Number(x.time), open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume }))
    all = all.concat(rows)
  }
  const unique = [...new Map(all.map((x) => [x.time, x])).values()].sort((a, b) => a.time - b.time)
  return unique.slice(-bars)
}

/** Candles for a candidate universe larger than the bot's symbol count, so hourly ranking has room. */
export async function candleUniverse(symbolCount: number, hours: number): Promise<Record<string, Candle[]>> {
  const symbols = await liquidSymbols(Math.min(60, symbolCount + 10))
  const out: Record<string, Candle[]> = {}
  const batch = 6
  for (let i = 0; i < symbols.length; i += batch) {
    const got = await Promise.all(symbols.slice(i, i + batch).map(async (s) => [s, await minuteCandles(s, hours).catch(() => [])] as const))
    for (const [s, c] of got) if (c.length > hours * 60) out[s.replace("-", "")] = c
  }
  return out
}

export interface ContractRules { quantityStep: number; priceTick: number; minQuantity: number; minNotional: number }
let contractsCache: { at: number; rules: Map<string, ContractRules> } | null = null

/** Quantity/price precision and venue minimums for USDT perpetuals, cached for an hour. */
export async function contractRules(): Promise<Map<string, ContractRules>> {
  if (contractsCache && Date.now() - contractsCache.at < 3600_000) return contractsCache.rules
  const r: any = await fetch(`${BASE}/openApi/swap/v2/quote/contracts`, { cache: "no-store" }).then((x) => x.json())
  const rules = new Map<string, ContractRules>()
  for (const c of (Array.isArray(r?.data) ? r.data : [])) {
    const qp = Number(c.quantityPrecision), pp = Number(c.pricePrecision)
    rules.set(String(c.symbol), {
      quantityStep: Number.isFinite(qp) ? 10 ** -qp : 0.001,
      priceTick: Number.isFinite(pp) ? 10 ** -pp : 0.0001,
      minQuantity: Number(c.tradeMinQuantity) || 0,
      minNotional: Number(c.tradeMinUSDT) || 2,
    })
  }
  contractsCache = { at: Date.now(), rules }
  return rules
}
