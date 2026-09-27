/**
 * Orthogonal (non-OHLC-indicator) Signal input candidates.
 *
 * Every established/candidate source in lib/signal-source-registry.ts feeds
 * the same candle indicator on a different venue, so their votes are highly
 * correlated. The feeds below measure something else — positioning, flow,
 * funding and basis — from free, public, unauthenticated, read-only GET
 * endpoints (verified 2026-09-27 from the build environment).
 *
 * Lifecycle: all entries are "candidate". Nothing here is wired into Signal
 * dispatch; the source-validation gate is unchanged. They exist so the live
 * adapters and the historic replay (scripts/historic-signal-eval-v2.ts) share
 * one parser and one causal feature definition.
 */

export type OrthogonalFeatureKind =
  | "funding_rate"
  | "open_interest"
  | "long_short_account_ratio"
  | "taker_buy_sell_ratio"
  | "taker_buy_volume"
  | "index_price"
  | "order_book_imbalance"

export interface OrthogonalFeaturePoint {
  /** Time at which the value becomes known (ms, causal availability). */
  availableAt: number
  value: number
}

export interface OrthogonalSourceDefinition {
  id: string
  name: string
  kind: OrthogonalFeatureKind
  lifecycle: "candidate"
  /** True when a public history endpoint allows a causal 14-day replay. */
  historicReplay: boolean
  /** Native sampling period in minutes (0 = event based, e.g. funding). */
  periodMinutes: number
  officialDocs: string
  buildUrl: (input: { base: string; startMs?: number; endMs?: number; limit?: number }) => string
  parse: (payload: unknown) => OrthogonalFeaturePoint[]
}

const num = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : Number.NaN
}
const ms = (value: unknown): number => {
  const n = num(value)
  return n > 0 && n < 100_000_000_000 ? n * 1000 : n
}
const rows = (payload: unknown, key = "data"): any[] => {
  if (Array.isArray(payload)) return payload
  const inner = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[key] : null
  return Array.isArray(inner) ? inner : []
}
const finitePoints = (points: OrthogonalFeaturePoint[]): OrthogonalFeaturePoint[] =>
  points
    .filter((p) => Number.isFinite(p.availableAt) && p.availableAt > 0 && Number.isFinite(p.value))
    .sort((a, b) => a.availableAt - b.availableAt)

const FIVE_MIN = 300_000
const ONE_MIN = 60_000

export const ORTHOGONAL_SIGNAL_SOURCES: readonly OrthogonalSourceDefinition[] = [
  {
    id: "okx-funding-rate",
    name: "OKX perpetual funding rate (settled)",
    kind: "funding_rate",
    lifecycle: "candidate",
    historicReplay: true,
    periodMinutes: 0,
    officialDocs: "https://www.okx.com/docs-v5/en/#public-data-rest-api-get-funding-rate-history",
    buildUrl: ({ base, endMs, limit = 100 }) =>
      `https://www.okx.com/api/v5/public/funding-rate-history?instId=${base}-USDT-SWAP&limit=${limit}` +
      (endMs ? `&after=${endMs}` : ""),
    parse: (payload) => finitePoints(rows(payload).map((r: any) => ({
      availableAt: ms(r?.fundingTime),
      value: num(r?.realizedRate ?? r?.fundingRate),
    }))),
  },
  {
    id: "gate-taker-lsr",
    name: "Gate USDT futures taker buy/sell ratio (5m)",
    kind: "taker_buy_sell_ratio",
    lifecycle: "candidate",
    historicReplay: true,
    periodMinutes: 5,
    officialDocs: "https://www.gate.io/docs/developers/apiv4/#futures-stats",
    buildUrl: ({ base, startMs, limit = 2000 }) =>
      `https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${base}_USDT&interval=5m&limit=${limit}` +
      (startMs ? `&from=${Math.floor(startMs / 1000)}` : ""),
    // The bucket starting at `time` is complete only after one period.
    parse: (payload) => finitePoints(rows(payload).map((r: any) => ({
      availableAt: ms(r?.time) + FIVE_MIN,
      value: num(r?.lsr_taker),
    }))),
  },
  {
    id: "gate-account-lsr",
    name: "Gate USDT futures long/short account ratio (5m)",
    kind: "long_short_account_ratio",
    lifecycle: "candidate",
    historicReplay: true,
    periodMinutes: 5,
    officialDocs: "https://www.gate.io/docs/developers/apiv4/#futures-stats",
    buildUrl: ({ base, startMs, limit = 2000 }) =>
      `https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${base}_USDT&interval=5m&limit=${limit}` +
      (startMs ? `&from=${Math.floor(startMs / 1000)}` : ""),
    parse: (payload) => finitePoints(rows(payload).map((r: any) => ({
      availableAt: ms(r?.time) + FIVE_MIN,
      value: num(r?.lsr_account),
    }))),
  },
  {
    id: "gate-open-interest",
    name: "Gate USDT futures open interest (5m)",
    kind: "open_interest",
    lifecycle: "candidate",
    historicReplay: true,
    periodMinutes: 5,
    officialDocs: "https://www.gate.io/docs/developers/apiv4/#futures-stats",
    buildUrl: ({ base, startMs, limit = 2000 }) =>
      `https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${base}_USDT&interval=5m&limit=${limit}` +
      (startMs ? `&from=${Math.floor(startMs / 1000)}` : ""),
    parse: (payload) => finitePoints(rows(payload).map((r: any) => ({
      availableAt: ms(r?.time) + FIVE_MIN,
      value: num(r?.open_interest_usd ?? r?.open_interest),
    }))),
  },
  {
    id: "binance-spot-taker-buy",
    name: "Binance spot taker-buy share (1m, public data API)",
    kind: "taker_buy_volume",
    lifecycle: "candidate",
    historicReplay: true,
    periodMinutes: 1,
    officialDocs: "https://developers.binance.com/docs/binance-spot-api-docs/faqs/market_data_only",
    buildUrl: ({ base, startMs, endMs, limit = 1000 }) =>
      `https://data-api.binance.vision/api/v3/klines?symbol=${base}USDT&interval=1m&limit=${limit}` +
      (startMs ? `&startTime=${startMs}` : "") + (endMs ? `&endTime=${endMs}` : ""),
    // value = taker-buy share of volume in [0, 1]; 0.5 = balanced.
    parse: (payload) => finitePoints(rows(payload).map((r: any) => {
      const volume = num(r?.[5])
      const takerBuy = num(r?.[9])
      return { availableAt: num(r?.[0]) + ONE_MIN, value: volume > 0 ? takerBuy / volume : Number.NaN }
    })),
  },
  {
    id: "okx-index-price",
    name: "OKX spot index price (1m) for perp basis",
    kind: "index_price",
    lifecycle: "candidate",
    historicReplay: true,
    periodMinutes: 1,
    officialDocs: "https://www.okx.com/docs-v5/en/#public-data-rest-api-get-index-candlesticks-history",
    buildUrl: ({ base, endMs, limit = 100 }) =>
      `https://www.okx.com/api/v5/market/history-index-candles?instId=${base}-USDT&bar=1m&limit=${limit}` +
      (endMs ? `&after=${endMs}` : ""),
    parse: (payload) => finitePoints(rows(payload).map((r: any) => ({
      availableAt: num(r?.[0]) + ONE_MIN,
      value: num(r?.[4]),
    }))),
  },
  {
    id: "bingx-book-imbalance",
    name: "BingX perpetual top-of-book imbalance (live snapshot only)",
    kind: "order_book_imbalance",
    lifecycle: "candidate",
    historicReplay: false,
    periodMinutes: 0,
    officialDocs: "https://bingx-api.github.io/docs/#/en-us/swapV2/market-api.html",
    buildUrl: ({ base, limit = 20 }) =>
      `https://open-api.bingx.com/openApi/swap/v2/quote/depth?symbol=${base}-USDT&limit=${limit}`,
    parse: (payload) => {
      const data = payload && typeof payload === "object" ? (payload as any).data : null
      const value = orderBookImbalance(data?.bids, data?.asks)
      return finitePoints([{ availableAt: num(data?.T), value }])
    },
  },
] as const

/**
 * Rejected during verification (2026-09-27): Binance USDⓈ-M futures data
 * (fapi fundingRate/openInterestHist/takerlongshortRatio/premiumIndexKlines)
 * answers "restricted location"; OKX rubik open-interest/long-short history
 * returns empty data for windows older than a few days; Bitget taker-buy-sell
 * and account-long-short returned empty payloads (code 40054).
 */
export const REJECTED_ORTHOGONAL_ENDPOINTS: readonly { id: string; reason: string }[] = [
  { id: "binance-fapi-futures-data", reason: "HTTP 451-style restricted location response from this region" },
  { id: "okx-rubik-oi-lsr-history", reason: "history older than a few days returns empty data; no 14-day replay" },
  { id: "bitget-taker-account-lsr", reason: "code 40054 empty data for BCH/XRP/SOL" },
]

export function getOrthogonalSource(id: string): OrthogonalSourceDefinition | undefined {
  return ORTHOGONAL_SIGNAL_SOURCES.find((s) => s.id === id)
}

/** (bidQty - askQty) / (bidQty + askQty) over the given levels, in [-1, 1]. */
export function orderBookImbalance(bids: unknown, asks: unknown, levels = 10): number {
  const sum = (side: unknown) => (Array.isArray(side) ? side.slice(0, levels) : [])
    .reduce((acc: number, level: any) => acc + (Number(level?.[1]) || 0), 0)
  const b = sum(bids)
  const a = sum(asks)
  return b + a > 0 ? (b - a) / (b + a) : Number.NaN
}

/**
 * Causal as-of lookup: the latest point with availableAt <= t (binary search
 * over points sorted by availableAt). Returns NaN when none is available or
 * the latest one is older than `maxAgeMs`.
 */
export function valueAsOf(points: readonly OrthogonalFeaturePoint[], t: number, maxAgeMs = Infinity): number {
  let lo = 0
  let hi = points.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].availableAt <= t) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (found < 0) return Number.NaN
  const p = points[found]
  return t - p.availableAt <= maxAgeMs ? p.value : Number.NaN
}

/** Perp basis in percent: (perp - index) / index × 100. */
export function basisPct(perpPrice: number, indexPrice: number): number {
  return perpPrice > 0 && indexPrice > 0 ? ((perpPrice - indexPrice) / indexPrice) * 100 : Number.NaN
}

/** Wilder ADX over OHLC bars (period default 14). Returns NaN if too short. */
export function adx(
  bars: readonly { high: number; low: number; close: number }[],
  period = 14,
): number {
  if (bars.length < period * 2 + 1) return Number.NaN
  let trS = 0
  let pS = 0
  let mS = 0
  let adxValue = Number.NaN
  const dxs: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]
    const prev = bars[i - 1]
    const up = cur.high - prev.high
    const down = prev.low - cur.low
    const plusDm = up > down && up > 0 ? up : 0
    const minusDm = down > up && down > 0 ? down : 0
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close))
    if (i <= period) {
      trS += tr
      pS += plusDm
      mS += minusDm
      if (i < period) continue
    } else {
      trS = trS - trS / period + tr
      pS = pS - pS / period + plusDm
      mS = mS - mS / period + minusDm
    }
    const pdi = trS > 0 ? (100 * pS) / trS : 0
    const mdi = trS > 0 ? (100 * mS) / trS : 0
    const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0
    if (dxs.length < period) {
      dxs.push(dx)
      if (dxs.length === period) adxValue = dxs.reduce((a, b) => a + b, 0) / period
    } else {
      adxValue = (adxValue * (period - 1) + dx) / period
    }
  }
  return adxValue
}
