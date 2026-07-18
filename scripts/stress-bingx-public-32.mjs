#!/usr/bin/env node

/**
 * Read-only BingX 32-symbol stress probe.
 *
 * Safety contract: every request is an unauthenticated GET to /quote/*.
 * The script rejects trade/account paths before fetch and never reads API keys.
 */

const PRIMARY_ORIGIN = process.env.BINGX_PUBLIC_ORIGIN || "https://open-api.bingx.com"
const FALLBACK_ORIGIN = process.env.BINGX_PUBLIC_FALLBACK_ORIGIN || "https://open-api.bingx.pro"
const ORIGINS = [...new Set([PRIMARY_ORIGIN, FALLBACK_ORIGIN])]
const SYMBOL_COUNT = 32
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.BINGX_STRESS_CONCURRENCY) || 6))
const TICKER_ROUNDS = Math.max(2, Math.min(20, Number(process.env.BINGX_STRESS_TICKER_ROUNDS) || 6))
const REQUEST_TIMEOUT_MS = Math.max(5_000, Math.min(60_000, Number(process.env.BINGX_STRESS_TIMEOUT_MS) || 20_000))
const REQUEST_RETRIES = Math.max(0, Math.min(4, Number(process.env.BINGX_STRESS_RETRIES) || 3))
const requestTelemetry = { attempts: 0, retries: 0, timeouts: 0, origins: new Map() }
let preferredOriginIndex = 0

function publicQuoteUrl(pathname, origin = ORIGINS[preferredOriginIndex]) {
  const url = new URL(pathname, origin)
  if (url.protocol !== "https:") throw new Error(`Refusing non-HTTPS endpoint: ${url}`)
  if (!url.pathname.includes("/quote/") || url.pathname.includes("/trade/") || url.pathname.includes("/user/")) {
    throw new Error(`Refusing non-public BingX endpoint: ${url.pathname}`)
  }
  return url
}

async function fetchJson(pathname, retries = REQUEST_RETRIES) {
  let lastError
  let originIndex = preferredOriginIndex
  for (let attempt = 0; attempt <= retries; attempt++) {
    const url = publicQuoteUrl(pathname, ORIGINS[originIndex])
    const startedAt = performance.now()
    requestTelemetry.attempts += 1
    if (attempt > 0) requestTelemetry.retries += 1
    requestTelemetry.origins.set(url.origin, (requestTelemetry.origins.get(url.origin) || 0) + 1)
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      if (json?.code != null && String(json.code) !== "0") {
        throw new Error(`BingX code=${json.code}: ${json.msg || "unknown"}`)
      }
      preferredOriginIndex = originIndex
      return { json, latencyMs: performance.now() - startedAt }
    } catch (error) {
      lastError = new Error(`${url.origin}${url.pathname}: ${error instanceof Error ? error.message : String(error)}`)
      if (error?.name === "TimeoutError" || error?.name === "AbortError") requestTelemetry.timeouts += 1
      if (attempt < retries) {
        originIndex = (originIndex + 1) % ORIGINS.length
        const backoffMs = Math.min(2_000, 250 * (2 ** attempt))
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
      }
    }
  }
  throw lastError
}

async function mapWithConcurrency(values, concurrency, worker) {
  const output = new Array(values.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= values.length) return
      output[index] = await worker(values[index], index)
    }
  })
  await Promise.all(workers)
  return output
}

function numeric(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function main() {
  const heapBefore = process.memoryUsage().heapUsed
  const tickerSnapshot = await fetchJson("/openApi/swap/v2/quote/ticker")
  const tickers = Array.isArray(tickerSnapshot.json?.data) ? tickerSnapshot.json.data : []
  const active = tickers
    .filter((row) => String(row?.symbol || "").toUpperCase().endsWith("-USDT"))
    .filter((row) => numeric(row?.lastPrice ?? row?.price ?? row?.close) > 0)
    .sort((a, b) => numeric(b?.quoteVolume ?? b?.turnover ?? b?.volume) - numeric(a?.quoteVolume ?? a?.turnover ?? a?.volume))
  const symbols = [...new Set(active.map((row) => String(row.symbol).toUpperCase()))].slice(0, SYMBOL_COUNT)
  if (symbols.length !== SYMBOL_COUNT) throw new Error(`Expected ${SYMBOL_COUNT} active USDT contracts, found ${symbols.length}`)

  const candles = await mapWithConcurrency(symbols, CONCURRENCY, async (symbol) => {
    const encoded = encodeURIComponent(symbol)
    const result = await fetchJson(`/openApi/swap/v3/quote/klines?symbol=${encoded}&interval=1m&limit=200`)
    const rows = Array.isArray(result.json?.data) ? result.json.data : []
    if (rows.length < 2) throw new Error(`${symbol}: insufficient candle history (${rows.length})`)
    const last = rows[rows.length - 1]
    const close = numeric(last?.close ?? last?.[4])
    if (!(close > 0)) throw new Error(`${symbol}: invalid latest close`)
    return { symbol, rows: rows.length, close, latencyMs: result.latencyMs }
  })

  const tickerLatencies = []
  for (let round = 0; round < TICKER_ROUNDS; round++) {
    const snapshot = await fetchJson("/openApi/swap/v2/quote/ticker")
    const rows = Array.isArray(snapshot.json?.data) ? snapshot.json.data : []
    const present = new Set(rows.map((row) => String(row?.symbol || "").toUpperCase()))
    const missing = symbols.filter((symbol) => !present.has(symbol))
    if (missing.length > 0) throw new Error(`Ticker round ${round + 1} missing: ${missing.join(", ")}`)
    tickerLatencies.push(snapshot.latencyMs)
  }

  if (global.gc) global.gc()
  const heapAfter = process.memoryUsage().heapUsed
  const heapDeltaMb = (heapAfter - heapBefore) / 1024 / 1024
  const klineLatencies = candles.map((item) => item.latencyMs)
  const maxLatencyMs = Math.max(...klineLatencies, ...tickerLatencies)
  const avgLatencyMs = [...klineLatencies, ...tickerLatencies].reduce((sum, value) => sum + value, 0) /
    (klineLatencies.length + tickerLatencies.length)

  console.log(JSON.stringify({
    success: true,
    mode: "read-only-public-quote-stress",
    orderRequests: 0,
    authenticatedRequests: 0,
    symbols: symbols.length,
    candleRows: candles.reduce((sum, item) => sum + item.rows, 0),
    tickerRounds: TICKER_ROUNDS,
    concurrency: CONCURRENCY,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    requestRetries: REQUEST_RETRIES,
    requestAttempts: requestTelemetry.attempts,
    retriedRequests: requestTelemetry.retries,
    timedOutAttempts: requestTelemetry.timeouts,
    activeOrigin: ORIGINS[preferredOriginIndex],
    originAttempts: Object.fromEntries(requestTelemetry.origins),
    averageLatencyMs: Number(avgLatencyMs.toFixed(1)),
    maxLatencyMs: Number(maxLatencyMs.toFixed(1)),
    heapDeltaMb: Number(heapDeltaMb.toFixed(2)),
    testedSymbols: symbols,
  }, null, 2))

  if (heapDeltaMb > 96) throw new Error(`Heap growth ${heapDeltaMb.toFixed(2)} MB exceeds 96 MB stress ceiling`)
}

main().then(() => {
  // An aborted primary-origin fetch can leave an Undici/proxy socket alive
  // after the fallback has completed successfully. Do not let that transport
  // handle keep this finite CLI probe open indefinitely.
  const exitGuard = setTimeout(() => process.exit(0), 100)
  exitGuard.unref()
}).catch((error) => {
  console.error("[stress-bingx-public-32] failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
