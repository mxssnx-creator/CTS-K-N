import { NextResponse, type NextRequest } from "next/server"
import {
  getAllConnections,
  getConnection,
  getRedisClient,
  initRedis,
} from "@/lib/redis-db"
import { createExchangeConnector } from "@/lib/exchange-connectors"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import { normalizeForexSymbol } from "@/lib/forex-market"
import { calculateObservedSpread } from "@/lib/position-cost"
import { normalizeMarketSymbol, normalizeMarketType, type MarketType } from "@/lib/market-types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const FRESH_MARKET_DATA_MS = 15_000
const MARKET_READ_CONCURRENCY = 8

type MarketSnapshot = {
  symbol: string
  exchange: string
  interval: string
  price: number | null
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  bid: number | null
  ask: number | null
  volume: number
  change24h: number
  timestamp: number
  datetime: string
  last_update: string
  source: string
  available: boolean
  realtime: boolean
  stale: boolean
  synthetic: boolean
  marketType: MarketType
  volumeKind: "base" | "lots"
  spreadPrice: number | null
  spreadPips: number | null
  spreadBps: number | null
  digits: number | null
  error?: string
}

function finiteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function finiteOptional(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function timestampMs(value: unknown): number {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  }
  const parsed = Date.parse(String(value || ""))
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeSymbol(value: unknown): string {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9:_-]/g, "")
}

function normalizeExchange(value: unknown): string {
  return String(value || "bybit").trim().toLowerCase() || "bybit"
}

function normalizeSnapshot(
  raw: Record<string, unknown>,
  symbol: string,
  exchange: string,
  interval: string,
  sourceOverride?: string,
  marketTypeOverride?: MarketType,
): MarketSnapshot {
  const marketType = marketTypeOverride || normalizeMarketType(raw.market_type ?? raw.marketType, exchange)
  const bid = finiteNumber(raw.bid, raw.bidPrice)
  const ask = finiteNumber(raw.ask, raw.askPrice)
  const observedSpread = bid !== null && ask !== null
    ? calculateObservedSpread({ bid, ask, last: finiteNumber(raw.last, raw.lastPrice) || undefined, timestamp: timestampMs(raw.timestamp ?? raw.last_update ?? raw.lastUpdated ?? raw.datetime), marketType }, symbol)
    : null
  const price = finiteNumber(raw.price, raw.last, raw.lastPrice, raw.close, observedSpread?.mid)
  const close = finiteNumber(raw.close, raw.last, raw.lastPrice, raw.price, observedSpread?.mid)
  const observedAt = timestampMs(
    raw.timestamp ?? raw.last_update ?? raw.lastUpdated ?? raw.datetime,
  ) || Date.now()
  const source = String(
    sourceOverride || raw.data_source || raw.source || raw.exchange || "unknown",
  ).toLowerCase()
  const synthetic = source.includes("synthetic") || source.includes("simulat")
  const stale = Date.now() - observedAt > FRESH_MARKET_DATA_MS
  const available = price !== null && price > 0

  return {
    symbol,
    exchange,
    interval,
    price,
    open: finiteNumber(raw.open, price),
    high: finiteNumber(raw.high, raw.high24h, price),
    low: finiteNumber(raw.low, raw.low24h, price),
    close,
    bid,
    ask,
    volume: finiteNumber(
      raw.quoteVolume24h,
      raw.volume24h,
      raw.quoteVolume,
      raw.volume,
    ) || 0,
    change24h: finiteNumber(
      raw.priceChangePercent,
      raw.change24h,
      raw.change_24h,
    ) || 0,
    timestamp: observedAt,
    datetime: new Date(observedAt).toISOString(),
    last_update: new Date(observedAt).toISOString(),
    source,
    available,
    realtime: available && !synthetic && !stale,
    stale,
    synthetic,
    marketType,
    volumeKind: marketType === "forex" ? "lots" : "base",
    spreadPrice: finiteNumber(raw.spread_price, raw.spreadPrice, observedSpread?.spreadPrice),
    spreadPips: finiteNumber(raw.spread_pips, raw.spreadPips, observedSpread?.spreadPips),
    spreadBps: finiteNumber(raw.spread_bps, raw.spreadBps, observedSpread?.spreadBps),
    digits: finiteNumber(raw.digits, raw.decimals),
  }
}

function unavailableSnapshot(
  symbol: string,
  exchange: string,
  interval: string,
  error: unknown,
  marketType: MarketType = "crypto",
): MarketSnapshot {
  const now = Date.now()
  return {
    symbol,
    exchange,
    interval,
    price: null,
    open: null,
    high: null,
    low: null,
    close: null,
    bid: null,
    ask: null,
    volume: 0,
    change24h: 0,
    timestamp: now,
    datetime: new Date(now).toISOString(),
    last_update: new Date(now).toISOString(),
    source: "unavailable",
    available: false,
    realtime: false,
    stale: false,
    synthetic: false,
    marketType,
    volumeKind: marketType === "forex" ? "lots" : "base",
    spreadPrice: null,
    spreadPips: null,
    spreadBps: null,
    digits: null,
    error: error instanceof Error ? error.message : String(error || "Market data unavailable"),
  }
}

async function readEngineSnapshot(
  symbol: string,
  exchange: string,
  interval: string,
  marketType: MarketType,
): Promise<MarketSnapshot | null> {
  const client = getRedisClient()
  const hash = await client.hgetall(`market_data:${symbol}`).catch(() => ({}))
  if (hash && Object.keys(hash).length > 0) {
    const snapshot = normalizeSnapshot(
      hash as Record<string, unknown>,
      symbol,
      exchange,
      interval,
      undefined,
      marketType,
    )
    if (snapshot.available) return snapshot
  }

  for (const suffix of ["1s", interval, "1m"]) {
    const raw = await client.get(`market_data:${symbol}:${suffix}`).catch(() => null)
    if (!raw) continue
    try {
      const envelope = JSON.parse(String(raw)) as Record<string, unknown>
      const candles = Array.isArray(envelope.candles) ? envelope.candles : []
      const latest = candles[candles.length - 1]
      if (!latest || typeof latest !== "object") continue
      const snapshot = normalizeSnapshot(
        {
          ...(latest as Record<string, unknown>),
          timestamp:
            (latest as Record<string, unknown>).timestamp ??
            envelope.lastUpdated,
          source: envelope.source,
        },
        symbol,
        exchange,
        interval,
        undefined,
        marketType,
      )
      if (snapshot.available) return snapshot
    } catch {
      // A malformed cache entry is ignored; the exchange read below remains
      // the truthful fallback.
    }
  }
  return null
}

async function resolveConnection(
  connectionId: string | null,
  exchange: string,
): Promise<Record<string, any> | null> {
  if (connectionId) {
    return (await getConnection(connectionId)) as Record<string, any> | null
  }
  const connections = await getAllConnections()
  return (
    connections.find(
      (connection: any) =>
        normalizeExchange(connection.exchange) === exchange &&
        (connection.is_assigned === "1" ||
          connection.is_assigned === true ||
          connection.is_enabled === "1" ||
          connection.is_enabled === true),
    ) ||
    connections.find(
      (connection: any) => normalizeExchange(connection.exchange) === exchange,
    ) ||
    null
  )
}

async function createReadOnlyConnector(
  connection: Record<string, any> | null,
  requestedExchange: string,
) {
  const exchange = normalizeExchange(connection?.exchange || requestedExchange)
  return createExchangeConnector(exchange, {
    apiKey: String(connection?.api_key || ""),
    apiSecret: String(connection?.api_secret || ""),
    apiPassphrase: String(connection?.api_passphrase || ""),
    accountId: String(connection?.account_id || (exchange === "instaforex" ? connection?.api_key || "" : "")),
    apiBaseUrl: connection?.api_base_url,
    quotesBaseUrl: connection?.quotes_base_url,
    chartsUrl: connection?.charts_url,
    lotSize: finiteOptional(connection?.lot_size ?? connection?.lotSize),
    quantityUnit: exchange === "instaforex" ? "lots" : undefined,
    positionCostPercent: finiteOptional(connection?.position_cost_percent ?? connection?.positionCostPercent),
    spreadBufferPips: finiteOptional(connection?.spread_buffer_pips ?? connection?.spreadBufferPips),
    spreadMultiplier: finiteOptional(connection?.spread_multiplier ?? connection?.spreadMultiplier),
    positionsAverage: finiteOptional(connection?.positions_average ?? connection?.average_count),
    marketType: normalizeMarketType(connection?.market_type || connection?.asset_class, exchange),
    isTestnet: exchange === "instaforex" ? false : isTruthyFlag(connection?.is_testnet),
    apiType: connection?.api_type || (exchange === "instaforex" ? "forex" : "perpetual_futures"),
  })
}

async function fetchSnapshot(
  symbol: string,
  exchange: string,
  interval: string,
  connector: Awaited<ReturnType<typeof createReadOnlyConnector>> | null,
  marketType: MarketType,
): Promise<MarketSnapshot> {
  const cached = await readEngineSnapshot(symbol, exchange, interval, marketType)
  if (cached?.realtime) return cached

  if (connector) {
    try {
      const ticker = await connector.getTicker(symbol)
      const live = normalizeSnapshot(
        ticker as unknown as Record<string, unknown>,
        symbol,
        exchange,
        interval,
        `exchange:${exchange}`,
        marketType,
      )
      if (live.available) return live
    } catch (error) {
      if (!cached) return unavailableSnapshot(symbol, exchange, interval, error, marketType)
    }
  }

  return (
    cached ||
    unavailableSnapshot(
      symbol,
      exchange,
      interval,
      "No exchange or engine market snapshot is available",
      marketType,
    )
  )
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const worker = async () => {
    while (true) {
      const index = nextIndex++
      if (index >= values.length) return
      results[index] = await mapper(values[index])
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)) },
      worker,
    ),
  )
  return results
}

/**
 * Return measured market data from the selected exchange or the engine cache.
 * Synthetic engine data is explicitly labelled and is never represented as
 * live exchange data.
 */
export async function GET(request: NextRequest) {
  try {
    const requestedSymbol = request.nextUrl.searchParams.get("symbol")
    const exchange = normalizeExchange(request.nextUrl.searchParams.get("exchange"))
    const interval = request.nextUrl.searchParams.get("interval") || "1m"
    const connectionId = request.nextUrl.searchParams.get("connectionId")
    await initRedis()
    const connection = await resolveConnection(connectionId, exchange)
    if (connectionId && !connection) {
      return NextResponse.json({ success: false, error: "Connection not found" }, { status: 404 })
    }
    const resolvedExchange = normalizeExchange(connection?.exchange || exchange)
    const marketType = normalizeMarketType(connection?.market_type || connection?.asset_class, resolvedExchange)
    const symbol = marketType === "forex"
      ? normalizeForexSymbol(requestedSymbol || "EURUSD")
      : normalizeMarketSymbol(requestedSymbol || "BTCUSDT", marketType)
    if (!symbol) return NextResponse.json({ success: false, error: "A valid symbol is required" }, { status: 400 })
    const connector = await createReadOnlyConnector(connection, resolvedExchange).catch(() => null)
    const data = await fetchSnapshot(symbol, resolvedExchange, interval, connector, marketType)

    return NextResponse.json({
      success: true,
      available: data.available,
      realtime: data.realtime,
      data,
    })
  } catch (error) {
    console.error("[v0] Market data error:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch market data",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}

/**
 * Fetch multiple symbols through one read-only connector. Work is exhaustive
 * for the submitted symbol list and concurrency is bounded only to protect the
 * exchange/Redis hot path; no configured symbol is sliced or dropped.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const requestedSymbols: string[] = Array.from(
      new Set<string>(
        (Array.isArray(body.symbols) ? body.symbols : [])
          .map((value: unknown) => String(value || "").trim())
          .filter(Boolean),
      ),
    )
    if (requestedSymbols.length === 0) {
      return NextResponse.json(
        { success: false, error: "Symbols array is required" },
        { status: 400 },
      )
    }

    const requestedExchange = normalizeExchange(body.exchange)
    const interval = String(body.interval || "1m")
    const connectionId =
      typeof body.connectionId === "string" && body.connectionId.trim()
        ? body.connectionId.trim()
        : null

    await initRedis()
    const connection = await resolveConnection(connectionId, requestedExchange)
    if (connectionId && !connection) {
      return NextResponse.json({ success: false, error: "Connection not found" }, { status: 404 })
    }
    const exchange = normalizeExchange(connection?.exchange || requestedExchange)
    const marketType = normalizeMarketType(connection?.market_type || connection?.asset_class, exchange)
    const symbols = requestedSymbols.map((symbol) => marketType === "forex"
      ? normalizeForexSymbol(symbol)
      : normalizeMarketSymbol(symbol, marketType)).filter(Boolean)
    const connector = await createReadOnlyConnector(connection, exchange).catch(() => null)
    const snapshots = await mapWithConcurrency(
      symbols,
      MARKET_READ_CONCURRENCY,
      (symbol) => fetchSnapshot(symbol, exchange, interval, connector, marketType),
    )
    const data = Object.fromEntries(snapshots.map((snapshot) => [snapshot.symbol, snapshot]))
    const available = snapshots.filter((snapshot) => snapshot.available).length
    const realtime = snapshots.filter((snapshot) => snapshot.realtime).length
    const synthetic = snapshots.filter((snapshot) => snapshot.synthetic).length

    return NextResponse.json({
      success: true,
      count: snapshots.length,
      available,
      realtime,
      synthetic,
      unavailable: snapshots.length - available,
      data,
    })
  } catch (error) {
    console.error("[v0] Batch market data error:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch batch market data",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
