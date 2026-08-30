import { isForexSymbol, normalizeForexSymbol } from "@/lib/forex-market"

/**
 * Public short-horizon signal source registry.
 *
 * The engine never scrapes rendered web pages, Telegram channels or TradingView
 * widgets.  Every source below is a documented, read-only market-data API.  We
 * normalize OHLCV and calculate the actual trading indication locally so one
 * provider changing its marketing copy can never change order behaviour.
 */

export type SignalSourceMarket = "perpetual" | "futures" | "spot" | "aggregator" | "forex"
export type SignalSourceAssetClass = "crypto" | "forex"

export interface SignalCandle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface SignalSourceRequest {
  url: string
  init?: RequestInit
}

export interface SignalSourceContext {
  symbol: string
  limit: number
  now: number
}

export interface SignalSourceDefinition {
  id: string
  name: string
  market: SignalSourceMarket
  /** The asset class is explicit so crypto feeds can never receive FX symbols. */
  assetClass?: SignalSourceAssetClass
  priority: 1 | 2 | 3
  timeframeMinutes: number
  officialDocs: string
  enabledByDefault: true
  supportedBases?: readonly string[]
  buildRequest: (context: SignalSourceContext) => SignalSourceRequest
  parse: (payload: unknown) => SignalCandle[]
}

export interface SignalSourceDescriptor {
  id: string
  name: string
  market: SignalSourceMarket
  assetClass: SignalSourceAssetClass
  priority: 1 | 2 | 3
  timeframeMinutes: number
  officialDocs: string
  enabledByDefault: boolean
}

type CandleField = string | number
type CandleShape = {
  timestamp: CandleField
  open: CandleField
  high: CandleField
  low: CandleField
  close: CandleField
  volume?: CandleField
}

const QUOTES = ["USDT", "USDC", "USD", "BUSD", "FDUSD", "KRW", "THB", "EUR", "BTC"]

function pairParts(rawSymbol: string): { base: string; quote: string } {
  const normalized = String(rawSymbol || "BTCUSDT")
    .toUpperCase()
    .replace(/PERPETUAL|PERP|SWAP/g, "")
    .replace(/[^A-Z0-9]/g, "")
  for (const quote of QUOTES) {
    if (normalized.endsWith(quote) && normalized.length > quote.length) {
      return { base: normalized.slice(0, -quote.length), quote }
    }
  }
  return { base: normalized || "BTC", quote: "USDT" }
}

function compactPair(symbol: string, quote = "USDT"): string {
  return `${pairParts(symbol).base}${quote}`
}

function dashedPair(symbol: string, quote = "USDT"): string {
  return `${pairParts(symbol).base}-${quote}`
}

function underscoredPair(symbol: string, quote = "USDT"): string {
  return `${pairParts(symbol).base}_${quote}`
}

function slashedPair(symbol: string, quote = "USDT"): string {
  return `${pairParts(symbol).base}/${quote}`
}

function krakenBase(symbol: string): string {
  return pairParts(symbol).base === "BTC" ? "XBT" : pairParts(symbol).base
}

function timestampMs(value: unknown): number {
  if (typeof value === "string" && /[-T:]/.test(value)) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  let parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  if (parsed < 100_000_000_000) parsed *= 1000
  else if (parsed > 100_000_000_000_000_000) parsed /= 1_000_000
  else if (parsed > 100_000_000_000_000) parsed /= 1000
  return Math.round(parsed)
}

function at(row: any, field: CandleField | undefined): unknown {
  if (field === undefined) return 0
  return row?.[field as any]
}

function normalizeRows(rows: unknown, shape: CandleShape): SignalCandle[] {
  if (!Array.isArray(rows)) return []
  const candles: SignalCandle[] = []
  for (const row of rows) {
    const timestamp = timestampMs(at(row, shape.timestamp))
    const open = Number(at(row, shape.open))
    const high = Number(at(row, shape.high))
    const low = Number(at(row, shape.low))
    const close = Number(at(row, shape.close))
    const volume = Math.max(0, Number(at(row, shape.volume)) || 0)
    if (
      timestamp <= 0 ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      open <= 0 ||
      close <= 0 ||
      high < Math.max(open, close) ||
      low > Math.min(open, close) ||
      low <= 0
    ) {
      continue
    }
    candles.push({ timestamp, open, high, low, close, volume })
  }
  const unique = new Map<number, SignalCandle>()
  for (const candle of candles) unique.set(candle.timestamp, candle)
  return [...unique.values()].sort((left, right) => left.timestamp - right.timestamp)
}

function path(value: any, keys: readonly (string | number)[]): any {
  let current = value
  for (const key of keys) current = current?.[key as any]
  return current
}

function firstArray(payload: unknown, paths: readonly (readonly (string | number)[])[]): any[] {
  for (const candidatePath of paths) {
    const result = path(payload, candidatePath)
    if (Array.isArray(result)) return result
  }
  return []
}

function standardArrayParser(
  paths: readonly (readonly (string | number)[])[],
  shape: CandleShape = { timestamp: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 },
): (payload: unknown) => SignalCandle[] {
  return (payload) => normalizeRows(firstArray(payload, paths), shape)
}

function standardObjectParser(
  paths: readonly (readonly (string | number)[])[],
  shape: CandleShape = {
    timestamp: "timestamp",
    open: "open",
    high: "high",
    low: "low",
    close: "close",
    volume: "volume",
  },
): (payload: unknown) => SignalCandle[] {
  return (payload) => normalizeRows(firstArray(payload, paths), shape)
}

function xmlValues(xml: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^$()|[\]\\]/g, "\\$&")
  const expression = new RegExp(
    `<[^>]*:?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/[^>]*:?${escaped}\\s*>`,
    "gi",
  )
  return Array.from(xml.matchAll(expression)).map((match) => String(match[1] || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim())
}

function instaForexChartsParser(payload: unknown): SignalCandle[] {
  if (typeof payload !== "string") {
    return standardObjectParser(
      [["candles"], ["charts"], ["GetChartsResponse", "GetChartsResult"]],
      {
        timestamp: "timestamp",
        open: "open",
        high: "high",
        low: "low",
        close: "close",
        volume: "volume",
      },
    )(payload)
  }
  const timestamps = xmlValues(payload, "Timestamp")
  const opens = xmlValues(payload, "Open")
  const highs = xmlValues(payload, "High")
  const lows = xmlValues(payload, "Low")
  const closes = xmlValues(payload, "Close")
  const volumes = xmlValues(payload, "Volume")
  return normalizeRows(
    timestamps.map((timestamp, index) => [
      timestamp,
      opens[index],
      highs[index],
      lows[index],
      closes[index],
      volumes[index] ?? 0,
    ]),
    { timestamp: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 },
  )
}

function arrayOrObjectParser(
  paths: readonly (readonly (string | number)[])[],
  arrayShape: CandleShape,
  objectShape: CandleShape,
): (payload: unknown) => SignalCandle[] {
  return (payload) => {
    const rows = firstArray(payload, paths)
    const shape = rows.some((row) => Array.isArray(row))
      ? arrayShape
      : objectShape
    return normalizeRows(rows, shape)
  }
}

function parallelArrayCandles(
  payload: any,
  fields: { timestamp: string; open: string; high: string; low: string; close: string; volume?: string },
): SignalCandle[] {
  const timestamps = path(payload, fields.timestamp.split("."))
  if (!Array.isArray(timestamps)) return []
  const opens = path(payload, fields.open.split("."))
  const highs = path(payload, fields.high.split("."))
  const lows = path(payload, fields.low.split("."))
  const closes = path(payload, fields.close.split("."))
  const volumes = fields.volume ? path(payload, fields.volume.split(".")) : []
  return normalizeRows(
    timestamps.map((timestamp: unknown, index: number) => [
      timestamp,
      opens?.[index],
      highs?.[index],
      lows?.[index],
      closes?.[index],
      volumes?.[index] ?? 0,
    ]),
    { timestamp: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 },
  )
}

function query(url: string, params: Record<string, string | number>): string {
  const encoded = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) encoded.set(key, String(value))
  return `${url}?${encoded.toString()}`
}

function minuteWindow(now: number, limit: number): { startMs: number; endMs: number; startSec: number; endSec: number } {
  const endMs = Math.floor(now / 60_000) * 60_000
  const startMs = endMs - Math.max(20, limit) * 60_000
  return {
    startMs,
    endMs,
    startSec: Math.floor(startMs / 1000),
    endSec: Math.floor(endMs / 1000),
  }
}

function defineSource(source: Omit<SignalSourceDefinition, "enabledByDefault">): SignalSourceDefinition {
  return { ...source, enabledByDefault: true }
}

const objectShort = {
  timestamp: "t",
  open: "o",
  high: "h",
  low: "l",
  close: "c",
  volume: "v",
} as const

/**
 * 35 independently fail-isolated crypto feeds plus one official Forex feed.
 * Priority 1 is the
 * liquid derivatives core; priority 2 broadens venue agreement; priority 3
 * provides geographic/spot/aggregator confirmation.
 */
export const SIGNAL_SOURCE_DEFINITIONS: readonly SignalSourceDefinition[] = [
  defineSource({
    id: "bingx-swap",
    name: "BingX Swap",
    market: "perpetual",
    priority: 1,
    timeframeMinutes: 1,
    officialDocs: "https://bingx-api.github.io/docs/#/swapV2/market-api.html",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://open-api.bingx.com/openApi/swap/v3/quote/klines", {
        symbol: dashedPair(symbol),
        interval: "1m",
        limit,
      }),
    }),
    parse: arrayOrObjectParser(
      [["data"]],
      { timestamp: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 },
      {
        timestamp: "time",
        open: "open",
        high: "high",
        low: "low",
        close: "close",
        volume: "volume",
      },
    ),
  }),
  defineSource({
    id: "binance-usdm",
    name: "Binance USD-M",
    market: "perpetual",
    priority: 1,
    timeframeMinutes: 1,
    officialDocs: "https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://fapi.binance.com/fapi/v1/klines", {
        symbol: compactPair(symbol),
        interval: "1m",
        limit,
      }),
    }),
    parse: standardArrayParser([[]]),
  }),
  defineSource({
    id: "bybit-linear",
    name: "Bybit Linear",
    market: "perpetual",
    priority: 1,
    timeframeMinutes: 1,
    officialDocs: "https://bybit-exchange.github.io/docs/v5/market/kline",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://api.bybit.com/v5/market/kline", {
        category: "linear",
        symbol: compactPair(symbol),
        interval: "1",
        limit,
      }),
    }),
    parse: standardArrayParser([["result", "list"]]),
  }),
  defineSource({
    id: "okx-swap",
    name: "OKX Swap",
    market: "perpetual",
    priority: 1,
    timeframeMinutes: 1,
    officialDocs: "https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://www.okx.com/api/v5/market/candles", {
        instId: `${dashedPair(symbol)}-SWAP`,
        bar: "1m",
        limit,
      }),
    }),
    parse: standardArrayParser([["data"]]),
  }),
  defineSource({
    id: "kucoin-futures",
    name: "KuCoin Futures",
    market: "futures",
    priority: 1,
    timeframeMinutes: 1,
    officialDocs: "https://www.kucoin.com/docs-new/rest/futures-trading/market-data/get-klines",
    buildRequest: ({ symbol, limit, now }) => {
      const window = minuteWindow(now, limit)
      return {
        url: query("https://api-futures.kucoin.com/api/v1/kline/query", {
          symbol: `${krakenBase(symbol)}USDTM`,
          // KuCoin Futures expresses this interval in seconds.
          granularity: 60,
          from: window.startMs,
          to: window.endMs,
        }),
      }
    },
    parse: standardArrayParser(
      [["data"]],
      { timestamp: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 },
    ),
  }),
  defineSource({
    id: "gateio-usdt",
    name: "Gate.io USDT Futures",
    market: "perpetual",
    priority: 1,
    timeframeMinutes: 1,
    officialDocs: "https://www.gate.com/docs/developers/apiv4/en/#futures-candlesticks",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://api.gateio.ws/api/v4/futures/usdt/candlesticks", {
        contract: underscoredPair(symbol),
        interval: "1m",
        limit,
      }),
    }),
    parse: arrayOrObjectParser(
      [[]],
      { timestamp: 0, volume: 1, close: 2, high: 3, low: 4, open: 5 },
      { timestamp: "t", volume: "v", close: "c", high: "h", low: "l", open: "o" },
    ),
  }),
  defineSource({
    id: "bitget-usdt",
    name: "Bitget USDT Futures",
    market: "perpetual",
    priority: 1,
    timeframeMinutes: 1,
    officialDocs: "https://www.bitget.com/api-doc/uta/public/Get-Candle-Data",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://api.bitget.com/api/v3/market/candles", {
        category: "USDT-FUTURES",
        symbol: compactPair(symbol),
        interval: "1m",
        type: "MARKET",
        limit,
      }),
    }),
    parse: standardArrayParser([["data"]]),
  }),
  defineSource({
    id: "mexc-contract",
    name: "MEXC Contract",
    market: "perpetual",
    priority: 1,
    timeframeMinutes: 1,
    officialDocs: "https://mexcdevelop.github.io/apidocs/contract_v1_en/#k-line-data",
    buildRequest: ({ symbol, limit, now }) => {
      const window = minuteWindow(now, limit)
      return {
        url: query(`https://contract.mexc.com/api/v1/contract/kline/${underscoredPair(symbol)}`, {
          interval: "Min1",
          start: window.startSec,
          end: window.endSec,
        }),
      }
    },
    parse: (payload) => parallelArrayCandles(payload, {
      timestamp: "data.time",
      open: "data.open",
      high: "data.high",
      low: "data.low",
      close: "data.close",
      volume: "data.vol",
    }),
  }),
  defineSource({
    id: "htx-linear",
    name: "HTX Linear Swap",
    market: "perpetual",
    priority: 2,
    timeframeMinutes: 1,
    officialDocs: "https://huobiapi.github.io/docs/usdt_swap/v1/en/#get-kline-data",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://api.hbdm.com/linear-swap-ex/market/history/kline", {
        contract_code: dashedPair(symbol),
        period: "1min",
        size: limit,
      }),
    }),
    parse: standardObjectParser(
      [["data"]],
      { timestamp: "id", open: "open", high: "high", low: "low", close: "close", volume: "vol" },
    ),
  }),
  defineSource({
    id: "coinex-futures",
    name: "CoinEx Futures",
    market: "perpetual",
    priority: 2,
    timeframeMinutes: 1,
    officialDocs: "https://docs.coinex.com/api/v2/futures/market/http/list-market-kline",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://api.coinex.com/v2/futures/kline", {
        market: compactPair(symbol),
        period: "1min",
        limit,
      }),
    }),
    parse: standardObjectParser(
      [["data"]],
      { timestamp: "created_at", open: "open", high: "high", low: "low", close: "close", volume: "volume" },
    ),
  }),
  defineSource({
    id: "phemex-perp",
    name: "Phemex Perpetual",
    market: "perpetual",
    priority: 2,
    timeframeMinutes: 1,
    officialDocs: "https://phemex-docs.github.io/#query-kline",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://api.phemex.com/exchange/public/md/v2/kline/last", {
        symbol: compactPair(symbol),
        resolution: 60,
        limit,
      }),
    }),
    parse: standardArrayParser(
      [["data", "rows"]],
      { timestamp: 0, open: 3, high: 4, low: 5, close: 6, volume: 7 },
    ),
  }),
  defineSource({
    id: "bitmart-futures",
    name: "BitMart Futures",
    market: "perpetual",
    priority: 2,
    timeframeMinutes: 1,
    officialDocs: "https://developer-pro.bitmart.com/en/futuresv2/#get-k-line",
    buildRequest: ({ symbol, limit, now }) => {
      const window = minuteWindow(now, limit)
      return {
        url: query("https://api-cloud-v2.bitmart.com/contract/public/kline", {
          symbol: compactPair(symbol),
          step: 1,
          start_time: window.startSec,
          end_time: window.endSec,
        }),
      }
    },
    parse: standardObjectParser(
      [["data"]],
      {
        timestamp: "timestamp",
        open: "open_price",
        high: "high_price",
        low: "low_price",
        close: "close_price",
        volume: "volume",
      },
    ),
  }),
  defineSource({
    id: "bitmex-perp",
    name: "BitMEX Perpetual",
    market: "perpetual",
    priority: 2,
    timeframeMinutes: 1,
    officialDocs: "https://docs.bitmex.com/api-explorer/get-trade-bucketed",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://www.bitmex.com/api/v1/trade/bucketed", {
        binSize: "1m",
        partial: "true",
        symbol: `${krakenBase(symbol)}USDT`,
        count: limit,
        reverse: "true",
      }),
    }),
    parse: standardObjectParser([[]]),
  }),
  defineSource({
    id: "poloniex",
    name: "Poloniex",
    market: "spot",
    priority: 2,
    timeframeMinutes: 1,
    officialDocs: "https://api-docs.poloniex.com/spot/api/public/market-data#candles",
    buildRequest: ({ symbol, limit }) => ({
      url: query(`https://api.poloniex.com/markets/${underscoredPair(symbol)}/candles`, {
        interval: "MINUTE_1",
        limit,
      }),
    }),
    parse: standardArrayParser(
      [[]],
      { low: 0, high: 1, open: 2, close: 3, volume: 5, timestamp: 12 },
    ),
  }),
  defineSource({
    id: "ascendex",
    name: "AscendEX",
    market: "spot",
    priority: 2,
    timeframeMinutes: 1,
    officialDocs: "https://ascendex.github.io/ascendex-pro-api/#historical-bar-data",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://ascendex.com/api/pro/v1/barhist", {
        symbol: slashedPair(symbol),
        interval: "1",
        n: limit,
      }),
    }),
    parse: (payload) => normalizeRows(
      firstArray(payload, [["data"]]).map((item) => item?.data ?? item),
      { ...objectShort, timestamp: "ts" },
    ),
  }),
  defineSource({
    id: "bitfinex",
    name: "Bitfinex",
    market: "spot",
    priority: 2,
    timeframeMinutes: 1,
    officialDocs: "https://docs.bitfinex.com/reference/rest-public-candles",
    buildRequest: ({ symbol, limit }) => ({
      url: query(
        `https://api-pub.bitfinex.com/v2/candles/trade:1m:t${pairParts(symbol).base}UST/hist`,
        { limit, sort: 1 },
      ),
    }),
    parse: standardArrayParser(
      [[]],
      { timestamp: 0, open: 1, close: 2, high: 3, low: 4, volume: 5 },
    ),
  }),
  defineSource({
    id: "kraken-futures",
    name: "Kraken Futures",
    market: "futures",
    priority: 2,
    timeframeMinutes: 1,
    officialDocs: "https://docs.kraken.com/api/docs/futures-api/charts/candles/",
    supportedBases: ["BTC", "ETH", "SOL", "XRP", "DOGE", "LTC", "BCH"],
    buildRequest: ({ symbol, limit, now }) => {
      const window = minuteWindow(now, limit)
      return {
        url: query(`https://futures.kraken.com/api/charts/v1/trade/PF_${krakenBase(symbol)}USD/1m`, {
          from: window.startSec,
          to: window.endSec,
        }),
      }
    },
    parse: standardObjectParser(
      [["candles"]],
      { timestamp: "time", open: "open", high: "high", low: "low", close: "close", volume: "volume" },
    ),
  }),
  defineSource({
    id: "deribit",
    name: "Deribit",
    market: "perpetual",
    priority: 2,
    timeframeMinutes: 1,
    officialDocs: "https://docs.deribit.com/api-reference/market-data/public-get_tradingview_chart_data",
    supportedBases: ["BTC", "ETH", "SOL"],
    buildRequest: ({ symbol, limit, now }) => {
      const window = minuteWindow(now, limit)
      return {
        url: query("https://www.deribit.com/api/v2/public/get_tradingview_chart_data", {
          instrument_name: `${pairParts(symbol).base}-PERPETUAL`,
          start_timestamp: window.startMs,
          end_timestamp: window.endMs,
          resolution: "1",
        }),
      }
    },
    parse: (payload) => parallelArrayCandles(payload, {
      timestamp: "result.ticks",
      open: "result.open",
      high: "result.high",
      low: "result.low",
      close: "result.close",
      volume: "result.volume",
    }),
  }),
  defineSource({
    id: "crypto-com",
    name: "Crypto.com Exchange",
    market: "perpetual",
    priority: 2,
    timeframeMinutes: 1,
    officialDocs: "https://exchange-developer.crypto.com/exchange/v1/rest-ws/index.html#public-get-candlestick",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://api.crypto.com/exchange/v1/public/get-candlestick", {
        instrument_name: `${pairParts(symbol).base}USD-PERP`,
        timeframe: "1m",
        count: limit,
      }),
    }),
    parse: standardObjectParser([["result", "data"]], objectShort),
  }),
  defineSource({
    id: "dydx",
    name: "dYdX Indexer",
    market: "perpetual",
    priority: 2,
    timeframeMinutes: 1,
    officialDocs: "https://docs.dydx.xyz/indexer-client/http#get-candles",
    buildRequest: ({ symbol, limit }) => ({
      url: query(`https://indexer.dydx.trade/v4/candles/perpetualMarkets/${dashedPair(symbol, "USD")}`, {
        resolution: "1MIN",
        limit,
      }),
    }),
    parse: standardObjectParser(
      [["candles"]],
      {
        timestamp: "startedAt",
        open: "open",
        high: "high",
        low: "low",
        close: "close",
        volume: "baseTokenVolume",
      },
    ),
  }),
  defineSource({
    id: "hyperliquid",
    name: "Hyperliquid",
    market: "perpetual",
    priority: 2,
    timeframeMinutes: 1,
    officialDocs: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint",
    buildRequest: ({ symbol, limit, now }) => {
      const window = minuteWindow(now, limit)
      return {
        url: "https://api.hyperliquid.xyz/info",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "candleSnapshot",
            req: {
              coin: pairParts(symbol).base,
              interval: "1m",
              startTime: window.startMs,
              endTime: window.endMs,
            },
          }),
        },
      }
    },
    parse: standardObjectParser([[]], objectShort),
  }),
  defineSource({
    id: "woo-x",
    name: "WOO X",
    market: "perpetual",
    priority: 2,
    timeframeMinutes: 1,
    officialDocs: "https://docs.woox.io/#kline",
    buildRequest: ({ symbol, limit, now }) => {
      const window = minuteWindow(now, limit)
      return {
        url: query("https://api.woo.org/v1/public/kline", {
          symbol: `PERP_${underscoredPair(symbol)}`,
          type: "1m",
          start_time: window.startMs,
          end_time: window.endMs,
          size: Math.min(1000, Math.max(1, limit)),
        }),
      }
    },
    parse: standardObjectParser(
      [["rows"], ["data", "rows"]],
      {
        timestamp: "start_timestamp",
        open: "open",
        high: "high",
        low: "low",
        close: "close",
        volume: "volume",
      },
    ),
  }),
  defineSource({
    id: "lbank",
    name: "LBank",
    market: "spot",
    priority: 3,
    timeframeMinutes: 1,
    officialDocs: "https://www.lbank.com/en-US/docs/index.html",
    buildRequest: ({ symbol, limit, now }) => {
      const window = minuteWindow(now, limit)
      return {
        url: query("https://api.lbkex.com/v2/kline.do", {
          symbol: underscoredPair(symbol).toLowerCase(),
          type: "minute1",
          size: limit,
          time: window.startSec,
        }),
      }
    },
    parse: standardArrayParser([["data"]]),
  }),
  defineSource({
    id: "xt",
    name: "XT.COM",
    market: "spot",
    priority: 3,
    timeframeMinutes: 1,
    officialDocs: "https://doc.xt.com/",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://sapi.xt.com/v4/public/kline", {
        symbol: underscoredPair(symbol).toLowerCase(),
        interval: "1m",
        limit,
      }),
    }),
    parse: standardObjectParser([["result"], ["data"]], objectShort),
  }),
  defineSource({
    id: "deepcoin",
    name: "Deepcoin",
    market: "perpetual",
    priority: 3,
    timeframeMinutes: 1,
    officialDocs: "https://www.deepcoin.com/docs/DeepCoinMarket/candles",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://api.deepcoin.com/deepcoin/market/candles", {
        instId: `${dashedPair(symbol)}-SWAP`,
        bar: "1m",
        limit,
      }),
    }),
    parse: standardArrayParser([["data"]]),
  }),
  defineSource({
    id: "backpack",
    name: "Backpack Exchange",
    market: "perpetual",
    priority: 3,
    timeframeMinutes: 1,
    officialDocs: "https://docs.backpack.exchange/#tag/Markets/operation/get_klines",
    buildRequest: ({ symbol, limit, now }) => {
      const window = minuteWindow(now, limit)
      return {
        url: query("https://api.backpack.exchange/api/v1/klines", {
          symbol: `${pairParts(symbol).base}_USDC_PERP`,
          interval: "1m",
          startTime: window.startSec,
          endTime: window.endSec,
        }),
      }
    },
    parse: standardObjectParser(
      [[], ["data"]],
      { timestamp: "start", open: "open", high: "high", low: "low", close: "close", volume: "volume" },
    ),
  }),
  defineSource({
    id: "coinbase-exchange",
    name: "Coinbase Exchange",
    market: "spot",
    priority: 3,
    timeframeMinutes: 1,
    officialDocs: "https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles",
    buildRequest: ({ symbol }) => ({
      url: query(`https://api.exchange.coinbase.com/products/${dashedPair(symbol)}/candles`, {
        granularity: 60,
      }),
      init: { headers: { Accept: "application/json", "User-Agent": "CTS-K-N-Signal/3.7" } },
    }),
    parse: standardArrayParser(
      [[]],
      { timestamp: 0, low: 1, high: 2, open: 3, close: 4, volume: 5 },
    ),
  }),
  defineSource({
    id: "kraken-spot",
    name: "Kraken Spot",
    market: "spot",
    priority: 3,
    timeframeMinutes: 1,
    officialDocs: "https://docs.kraken.com/api/docs/rest-api/get-ohlc-data/",
    buildRequest: ({ symbol }) => ({
      url: query("https://api.kraken.com/0/public/OHLC", {
        pair: `${krakenBase(symbol)}USDT`,
        interval: 1,
      }),
    }),
    parse: (payload: any) => {
      const result = payload?.result && typeof payload.result === "object" ? payload.result : {}
      const pairKey = Object.keys(result).find((key) => key !== "last")
      return normalizeRows(
        pairKey ? result[pairKey] : [],
        { timestamp: 0, open: 1, high: 2, low: 3, close: 4, volume: 6 },
      )
    },
  }),
  defineSource({
    id: "bitstamp",
    name: "Bitstamp",
    market: "spot",
    priority: 3,
    timeframeMinutes: 1,
    officialDocs: "https://www.bitstamp.net/api/#tag/Market-info/operation/GetOHLCData",
    buildRequest: ({ symbol, limit }) => ({
      url: query(`https://www.bitstamp.net/api/v2/ohlc/${compactPair(symbol).toLowerCase()}/`, {
        step: 60,
        limit,
      }),
    }),
    parse: standardObjectParser(
      [["data", "ohlc"]],
      { timestamp: "timestamp", open: "open", high: "high", low: "low", close: "close", volume: "volume" },
    ),
  }),
  defineSource({
    id: "gemini",
    name: "Gemini",
    market: "spot",
    priority: 3,
    timeframeMinutes: 1,
    officialDocs: "https://docs.gemini.com/rest/market-data#get-candles",
    buildRequest: ({ symbol }) => ({
      url: `https://api.gemini.com/v2/candles/${compactPair(symbol, "USD").toLowerCase()}/1m`,
    }),
    parse: standardArrayParser([[]]),
  }),
  defineSource({
    id: "upbit",
    name: "Upbit",
    market: "spot",
    priority: 3,
    timeframeMinutes: 1,
    officialDocs: "https://global-docs.upbit.com/reference/list-candles-minutes",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://api.upbit.com/v1/candles/minutes/1", {
        market: `USDT-${pairParts(symbol).base}`,
        count: limit,
      }),
    }),
    parse: standardObjectParser(
      [[]],
      {
        timestamp: "timestamp",
        open: "opening_price",
        high: "high_price",
        low: "low_price",
        close: "trade_price",
        volume: "candle_acc_trade_volume",
      },
    ),
  }),
  defineSource({
    id: "bithumb",
    name: "Bithumb",
    market: "spot",
    priority: 3,
    timeframeMinutes: 1,
    officialDocs: "https://apidocs.bithumb.com/reference/candlestick-rest-api",
    buildRequest: ({ symbol, limit }) => ({
      url: query(
        `https://api.bithumb.com/public/candlestick/${pairParts(symbol).base}_KRW/1m`,
        { count: Math.min(200, Math.max(1, limit)) },
      ),
    }),
    parse: standardArrayParser(
      [["data"]],
      { timestamp: 0, open: 1, close: 2, high: 3, low: 4, volume: 5 },
    ),
  }),
  defineSource({
    id: "bitkub",
    name: "Bitkub",
    market: "spot",
    priority: 3,
    timeframeMinutes: 1,
    officialDocs: "https://github.com/bitkub/bitkub-official-api-docs",
    buildRequest: ({ symbol, limit, now }) => {
      const window = minuteWindow(now, limit)
      return {
        url: query("https://api.bitkub.com/tradingview/history", {
          symbol: `${pairParts(symbol).base}_THB`,
          resolution: 1,
          from: window.startSec,
          to: window.endSec,
        }),
      }
    },
    parse: (payload) => parallelArrayCandles(payload, {
      timestamp: "t",
      open: "o",
      high: "h",
      low: "l",
      close: "c",
      volume: "v",
    }),
  }),
  defineSource({
    id: "cryptocompare",
    name: "CryptoCompare",
    market: "aggregator",
    priority: 3,
    timeframeMinutes: 1,
    officialDocs: "https://min-api.cryptocompare.com/documentation?key=Historical&cat=dataHistominute",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://min-api.cryptocompare.com/data/v2/histominute", {
        fsym: pairParts(symbol).base,
        tsym: "USDT",
        limit: Math.max(20, limit - 1),
      }),
    }),
    parse: standardObjectParser(
      [["Data", "Data"]],
      {
        timestamp: "time",
        open: "open",
        high: "high",
        low: "low",
        close: "close",
        volume: "volumefrom",
      },
    ),
  }),
  defineSource({
    id: "blofin",
    name: "BloFin Futures",
    market: "perpetual",
    priority: 2,
    timeframeMinutes: 1,
    officialDocs: "https://docs.blofin.com/index.html#get-candlesticks",
    buildRequest: ({ symbol, limit }) => ({
      url: query("https://openapi.blofin.com/api/v1/market/candles", {
        instId: dashedPair(symbol),
        bar: "1m",
        limit,
      }),
    }),
    parse: standardArrayParser([["data"]]),
  }),
  defineSource({
    id: "instaforex-charts",
    name: "InstaForex Charts",
    market: "forex",
    assetClass: "forex",
    priority: 1,
    timeframeMinutes: 1,
    officialDocs: "https://www.instaforex.com/partners/en/api_charts/",
    buildRequest: ({ symbol, limit, now }) => {
      const window = minuteWindow(now, limit)
      const canonical = isForexSymbol(symbol) ? normalizeForexSymbol(symbol) : "EURUSD"
      const body =
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
        "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\">" +
        "<s:Body><GetCharts xmlns=\"http://tempuri.org/\"><chartRequest>" +
        `<From>${window.startSec}</From><To>${window.endSec}</To>` +
        `<Symbol>${canonical}</Symbol><Type>M1</Type>` +
        "</chartRequest></GetCharts></s:Body></s:Envelope>"
      return {
        url: "https://client-api.instaforex.com/soapservices/charts.svc",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "text/xml; charset=utf-8",
            SOAPAction: "\"http://tempuri.org/ICharts/GetCharts\"",
          },
          body,
        },
      }
    },
    parse: instaForexChartsParser,
  }),
] as const

if (SIGNAL_SOURCE_DEFINITIONS.length !== 36) {
  throw new Error(`Signal source registry contract violated: expected 36, got ${SIGNAL_SOURCE_DEFINITIONS.length}`)
}

const SOURCE_BY_ID = new Map(SIGNAL_SOURCE_DEFINITIONS.map((source) => [source.id, source]))

export function getSignalSource(sourceId: string): SignalSourceDefinition | undefined {
  return SOURCE_BY_ID.get(sourceId)
}

export function getSignalSourceDescriptors(): SignalSourceDescriptor[] {
  return SIGNAL_SOURCE_DEFINITIONS.map((source) => ({
    id: source.id,
    name: source.name,
    market: source.market,
    assetClass: source.assetClass || "crypto",
    priority: source.priority,
    timeframeMinutes: source.timeframeMinutes,
    officialDocs: source.officialDocs,
    enabledByDefault: source.enabledByDefault,
  }))
}

export function signalSourceSupportsSymbol(source: SignalSourceDefinition, symbol: string): boolean {
  const forexSymbol = isForexSymbol(symbol)
  if (source.assetClass === "forex") {
    return forexSymbol && (!source.supportedBases || source.supportedBases.includes(pairParts(symbol).base))
  }
  if (forexSymbol) return false
  return !source.supportedBases || source.supportedBases.includes(pairParts(symbol).base)
}

export const __signalSourceTestUtils = {
  normalizeRows,
  pairParts,
  timestampMs,
}
