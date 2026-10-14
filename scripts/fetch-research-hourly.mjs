#!/usr/bin/env node
/**
 * Fetch real hourly bars from BingX's public perpetual-swap endpoint for a
 * range of whole UTC days and cache them as one JSON file per symbol.
 *
 *   node scripts/fetch-research-hourly.mjs <cache-dir> <first-day YYYY-MM-DD> <last-day YYYY-MM-DD> SYMBOL[,SYMBOL...]
 *
 * Public market data only: no credentials are read or sent. Missing hours are
 * recorded in <cache-dir>/coverage.json (first/last bar, bars, expected) so a
 * report can show the coverage per symbol; a symbol listed later than the
 * first day simply starts later.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const [cacheDir, firstDay, lastDay, symbolArg] = process.argv.slice(2)
if (!cacheDir || !firstDay || !lastDay || !symbolArg) {
  console.error("usage: fetch-research-hourly.mjs <cache-dir> <first-day> <last-day> SYMBOLS")
  process.exit(2)
}
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const startMs = Date.parse(`${firstDay}T00:00:00Z`)
const endMs = Date.parse(`${lastDay}T00:00:00Z`) + DAY_MS
if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("invalid day range")
if (endMs > Math.floor(Date.now() / DAY_MS) * DAY_MS) throw new Error("range includes an incomplete UTC day")
const symbols = symbolArg.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
mkdirSync(cacheDir, { recursive: true })

const venueSymbol = (symbol) => symbol.replace(/USDT$/, "-USDT")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchChunk(symbol, fromMs, toMs) {
  const url = new URL("https://open-api.bingx.com/openApi/swap/v3/quote/klines")
  url.searchParams.set("symbol", venueSymbol(symbol))
  url.searchParams.set("interval", "1h")
  url.searchParams.set("startTime", String(fromMs))
  url.searchParams.set("endTime", String(toMs - 1))
  url.searchParams.set("limit", "1440")
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (body?.code !== 0 && body?.code !== undefined) throw new Error(`code ${body.code}: ${body.msg}`)
      return (Array.isArray(body?.data) ? body.data : []).map((row) => ({
        timestamp: Number(row.time ?? row[0]),
        open: Number(row.open ?? row[1]),
        high: Number(row.high ?? row[2]),
        low: Number(row.low ?? row[3]),
        close: Number(row.close ?? row[4]),
        volume: Number(row.volume ?? row[5]) || 0,
      })).filter((bar) => Number.isFinite(bar.timestamp) && bar.timestamp >= fromMs && bar.timestamp < toMs && bar.close > 0)
    } catch (error) {
      if (attempt === 5) throw error
      await sleep(500 * 2 ** attempt)
    }
  }
  return []
}

const coverageFile = path.join(cacheDir, "coverage.json")
const coverage = existsSync(coverageFile) ? JSON.parse(readFileSync(coverageFile, "utf8")) : {}
for (const symbol of symbols) {
  const file = path.join(cacheDir, `${symbol}.json`)
  if (existsSync(file)) { console.log(`${symbol}: cached`); continue }
  const bars = new Map()
  try {
    for (let from = startMs; from < endMs; from += 1440 * HOUR_MS) {
      const to = Math.min(endMs, from + 1440 * HOUR_MS)
      for (const bar of await fetchChunk(symbol, from, to)) bars.set(bar.timestamp, bar)
      await sleep(150)
    }
  } catch (error) {
    coverage[symbol] = { error: error instanceof Error ? error.message : String(error) }
    console.log(`${symbol}: error ${coverage[symbol].error}`)
    continue
  }
  const sorted = [...bars.values()].sort((a, b) => a.timestamp - b.timestamp)
  writeFileSync(file, JSON.stringify(sorted))
  const first = sorted[0]?.timestamp ?? null
  coverage[symbol] = {
    bars: sorted.length,
    expected: Math.round((endMs - startMs) / HOUR_MS),
    first: first ? new Date(first).toISOString() : null,
    last: sorted.length ? new Date(sorted[sorted.length - 1].timestamp).toISOString() : null,
    // Hours missing after the symbol's first bar (a listing date is not a gap).
    gaps: first ? Math.round((endMs - first) / HOUR_MS) - sorted.length : null,
  }
  console.log(`${symbol}: ${sorted.length} bars from ${coverage[symbol].first}`)
}
writeFileSync(coverageFile, JSON.stringify(coverage, null, 2))
