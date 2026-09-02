#!/usr/bin/env node

import { createHash } from "node:crypto"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"

/**
 * Read-only BingX high-scale/all-symbol stress probe.
 *
 * Safety contract: every request is an unauthenticated GET to /quote/*.
 * The script rejects trade/account paths before fetch and never reads API keys.
 */

const PRIMARY_ORIGIN = process.env.BINGX_PUBLIC_ORIGIN || "https://open-api.bingx.com"
const VERIFIED_PUBLIC_HOSTS = new Set([
  "open-api.bingx.com",
  "open-api.bingx.pro",
  "open-api-vst.bingx.com",
  "open-api-vst.bingx.pro",
])
const configuredFallback = process.env.BINGX_PUBLIC_FALLBACK_ORIGIN || ""
const ORIGINS = [...new Set([PRIMARY_ORIGIN, configuredFallback].filter((origin) => {
  try { return VERIFIED_PUBLIC_HOSTS.has(new URL(origin).hostname) }
  catch { return false }
}))]
const ALL_SYMBOLS = process.env.BINGX_STRESS_ALL_SYMBOLS === "1" ||
  String(process.env.BINGX_STRESS_SYMBOL_COUNT || "").toLowerCase() === "all"
const SYMBOL_COUNT = Math.max(1, Math.min(1_000, Number(process.env.BINGX_STRESS_SYMBOL_COUNT) || 128))
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.BINGX_STRESS_CONCURRENCY) || 8))
const TICKER_ROUNDS = Math.max(2, Math.min(20, Number(process.env.BINGX_STRESS_TICKER_ROUNDS) || 6))
const REQUEST_TIMEOUT_MS = Math.max(5_000, Math.min(60_000, Number(process.env.BINGX_STRESS_TIMEOUT_MS) || 20_000))
const REQUEST_RETRIES = Math.max(0, Math.min(4, Number(process.env.BINGX_STRESS_RETRIES) || 3))
const requestTelemetry = { attempts: 0, retries: 0, timeouts: 0, failures: 0, origins: new Map() }
let preferredOriginIndex = 0

function publicQuoteUrl(pathname, origin = ORIGINS[preferredOriginIndex]) {
  const url = new URL(pathname, origin)
  if (url.protocol !== "https:" || !VERIFIED_PUBLIC_HOSTS.has(url.hostname)) throw new Error(`Refusing unverified BingX public host: ${url.origin}`)
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
      requestTelemetry.failures += 1
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

function percentile(values, ratio) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]
}

async function main() {
  const memoryBefore = process.memoryUsage()
  const cpuBefore = process.cpuUsage()
  const resourceBefore = process.resourceUsage()
  const eventLoop = monitorEventLoopDelay({ resolution: 10 })
  eventLoop.enable()
  const tickerSnapshot = await fetchJson("/openApi/swap/v2/quote/ticker")
  const tickers = Array.isArray(tickerSnapshot.json?.data) ? tickerSnapshot.json.data : []
  const active = tickers
    .filter((row) => String(row?.symbol || "").toUpperCase().endsWith("-USDT"))
    .filter((row) => numeric(row?.lastPrice ?? row?.price ?? row?.close) > 0)
    .sort((a, b) => numeric(b?.quoteVolume ?? b?.turnover ?? b?.volume) - numeric(a?.quoteVolume ?? a?.turnover ?? a?.volume))
  const availableSymbols = [...new Set(active.map((row) => String(row.symbol).toUpperCase()))]
  const targetSymbolCount = ALL_SYMBOLS ? availableSymbols.length : SYMBOL_COUNT
  const symbols = availableSymbols.slice(0, targetSymbolCount)
  if (!ALL_SYMBOLS && symbols.length !== targetSymbolCount) {
    throw new Error(`Expected ${targetSymbolCount} active USDT contracts, found ${symbols.length}`)
  }
  if ((ALL_SYMBOLS || SYMBOL_COUNT > 100) && symbols.length <= 100) {
    throw new Error(`High-scale probe requires >100 symbols, found ${symbols.length}`)
  }

  let candlesCompleted = 0
  const progressEvery = Math.max(1, Math.ceil(symbols.length / 20))
  const candles = await mapWithConcurrency(symbols, CONCURRENCY, async (symbol) => {
    const encoded = encodeURIComponent(symbol)
    const result = await fetchJson(`/openApi/swap/v3/quote/klines?symbol=${encoded}&interval=1m&limit=200`)
    const rows = Array.isArray(result.json?.data) ? result.json.data : []
    if (rows.length < 2) throw new Error(`${symbol}: insufficient candle history (${rows.length})`)
    const last = rows[rows.length - 1]
    const close = numeric(last?.close ?? last?.[4])
    if (!(close > 0)) throw new Error(`${symbol}: invalid latest close`)
    candlesCompleted += 1
    if (
      process.env.BINGX_STRESS_PROGRESS !== "0" &&
      (candlesCompleted % progressEvery === 0 || candlesCompleted === symbols.length)
    ) {
      const percent = Math.round((candlesCompleted / symbols.length) * 100)
      console.error(`[stress-bingx-public:progress] ${candlesCompleted}/${symbols.length} (${percent}%)`)
    }
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

  await new Promise((resolve) => setImmediate(resolve))
  eventLoop.disable()

  if (global.gc) global.gc()
  const memoryAfter = process.memoryUsage()
  const cpu = process.cpuUsage(cpuBefore)
  const resourceAfter = process.resourceUsage()
  const heapDeltaMb = (memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024 / 1024
  const rssDeltaMb = (memoryAfter.rss - memoryBefore.rss) / 1024 / 1024
  const klineLatencies = candles.map((item) => item.latencyMs)
  const maxLatencyMs = Math.max(...klineLatencies, ...tickerLatencies)
  const avgLatencyMs = [...klineLatencies, ...tickerLatencies].reduce((sum, value) => sum + value, 0) /
    (klineLatencies.length + tickerLatencies.length)
  const p95LatencyMs = percentile([...klineLatencies, ...tickerLatencies], 0.95)
  const testedSymbolsSha256 = createHash("sha256").update(symbols.join("\n")).digest("hex")

  if (heapDeltaMb > 96) throw new Error(`Heap growth ${heapDeltaMb.toFixed(2)} MB exceeds 96 MB stress ceiling`)
  if (rssDeltaMb > 256) throw new Error(`RSS growth ${rssDeltaMb.toFixed(2)} MB exceeds 256 MB stress ceiling`)
  if (eventLoop.percentile(95) / 1e6 > 100) throw new Error("Event-loop p95 exceeds 100 ms")
  if (p95LatencyMs > 12_000) throw new Error(`Request p95 ${p95LatencyMs.toFixed(1)} ms exceeds 12,000 ms`)
  if (requestTelemetry.failures > Math.max(3, Math.ceil(requestTelemetry.attempts * 0.1))) {
    throw new Error(`Failed/retried attempts ${requestTelemetry.failures}/${requestTelemetry.attempts} exceed 10%`)
  }

  console.log(JSON.stringify({
    success: true,
    mode: "read-only-public-quote-stress",
    orderRequests: 0,
    authenticatedRequests: 0,
    allSymbolsRequested: ALL_SYMBOLS,
    symbols: symbols.length,
    uniqueSymbols: new Set(symbols).size,
    duplicateSymbols: symbols.length - new Set(symbols).size,
    candleRows: candles.reduce((sum, item) => sum + item.rows, 0),
    tickerRounds: TICKER_ROUNDS,
    concurrency: CONCURRENCY,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    requestRetries: REQUEST_RETRIES,
    requestAttempts: requestTelemetry.attempts,
    retriedRequests: requestTelemetry.retries,
    timedOutAttempts: requestTelemetry.timeouts,
    failedAttempts: requestTelemetry.failures,
    activeOrigin: ORIGINS[preferredOriginIndex],
    originAttempts: Object.fromEntries(requestTelemetry.origins),
    averageLatencyMs: Number(avgLatencyMs.toFixed(1)),
    p50LatencyMs: Number(percentile([...klineLatencies, ...tickerLatencies], 0.5).toFixed(1)),
    p95LatencyMs: Number(p95LatencyMs.toFixed(1)),
    maxLatencyMs: Number(maxLatencyMs.toFixed(1)),
    heapDeltaMb: Number(heapDeltaMb.toFixed(2)),
    rssDeltaMb: Number(rssDeltaMb.toFixed(2)),
    rssMb: Number((memoryAfter.rss / 1024 / 1024).toFixed(2)),
    peakRssMb: Number((resourceAfter.maxRSS / 1024).toFixed(2)),
    cpuUserMs: Number((cpu.user / 1_000).toFixed(2)),
    cpuSystemMs: Number((cpu.system / 1_000).toFixed(2)),
    involuntaryContextSwitches: resourceAfter.involuntaryContextSwitches - resourceBefore.involuntaryContextSwitches,
    eventLoopMeanMs: Number((Number(eventLoop.mean) / 1e6 || 0).toFixed(2)),
    eventLoopP95Ms: Number((eventLoop.percentile(95) / 1e6 || 0).toFixed(2)),
    eventLoopMaxMs: Number((Number(eventLoop.max) / 1e6 || 0).toFixed(2)),
    testedSymbolsSha256,
    testedSymbolsPreview: {
      first: symbols.slice(0, 20),
      last: symbols.slice(-5),
      omitted: Math.max(0, symbols.length - 25),
    },
  }, null, 2))
}

main().then(() => {
  // An aborted primary-origin fetch can leave an Undici/proxy socket alive
  // after the fallback has completed successfully. Do not let that transport
  // handle keep this finite CLI probe open indefinitely.
  const exitGuard = setTimeout(() => process.exit(0), 100)
  exitGuard.unref()
}).catch((error) => {
  console.error("[stress-bingx-public] failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
