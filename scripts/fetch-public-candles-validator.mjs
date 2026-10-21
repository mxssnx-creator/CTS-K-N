#!/usr/bin/env node
/**
 * Fetch complete public BingX perpetual candles for the direct-trade history
 * validator (scripts/validate-direct-trade-history.cjs) in its input format.
 *
 *   node scripts/fetch-public-candles-validator.mjs <out.json> <first-day YYYY-MM-DD> <days> SYMBOL[,SYMBOL...]
 *
 * Public market data only: no credentials are read or sent. Every series must
 * be gap-free over the requested UTC days; a series with gaps is written with
 * `missing` entries and fails the validator, so a report cannot hide them.
 */
import { writeFileSync } from "node:fs"

const [outFile, firstDay, dayCountArg, symbolArg] = process.argv.slice(2)
if (!outFile || !firstDay || !dayCountArg || !symbolArg) {
  console.error("usage: fetch-public-candles-validator.mjs <out.json> <first-day> <days> SYMBOLS")
  process.exit(2)
}
const DAY_MS = 86_400_000
const start = Date.parse(`${firstDay}T00:00:00Z`)
const days = Number(dayCountArg)
const endExclusive = start + days * DAY_MS
if (!Number.isFinite(start) || !(days > 0)) throw new Error("invalid day range")
if (endExclusive > Math.floor(Date.now() / DAY_MS) * DAY_MS) throw new Error("range includes an incomplete UTC day")
const symbols = [...new Set(symbolArg.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))]
const INTERVALS = [5, 15, 30]
const PAGE = 1000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// BingX answers code 100410 (frequency limit) inside an HTTP 200 body; back off and retry it like HTTP 429.
const RATE_LIMITED_CODE = 100410

async function getJson(url, attempt = 0) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25_000) })
  if (response.status === 429 || response.status >= 500) {
    if (attempt >= 8) throw new Error(`HTTP ${response.status} after retries: ${url}`)
    await sleep(1000 * 2 ** Math.min(attempt, 5))
    return getJson(url, attempt + 1)
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
  const payload = await response.json()
  if (payload.code === RATE_LIMITED_CODE) {
    if (attempt >= 8) throw new Error(`rate limited after retries: ${url}`)
    await sleep(1000 * 2 ** Math.min(attempt, 5))
    return getJson(url, attempt + 1)
  }
  return payload
}

async function fetchSeries(symbol, minutes) {
  const interval = minutes * 60_000
  const byTime = new Map()
  let pageEnd = endExclusive - 1
  for (let page = 0; page < 40; page++) {
    const params = new URLSearchParams({ symbol, interval: `${minutes}m`, limit: String(PAGE), endTime: String(pageEnd) })
    const payload = await getJson(`https://open-api.bingx.com/openApi/swap/v3/quote/klines?${params}`)
    if (payload.code !== 0 || !Array.isArray(payload.data)) throw new Error(`public klines unavailable: ${symbol} ${minutes}m code=${payload.code}`)
    if (payload.data.length === 0) break
    let earliest = Infinity
    for (const row of payload.data) {
      const time = Number(row.time)
      earliest = Math.min(earliest, time)
      if (time >= start && time + interval <= endExclusive) {
        byTime.set(time, { time, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) })
      }
    }
    if (earliest <= start) break
    if (earliest >= pageEnd) throw new Error(`non-advancing public history page: ${symbol} ${minutes}m`)
    pageEnd = earliest - 1
    await sleep(120)
  }
  const expected = (endExclusive - start) / interval
  const candles = []
  const missing = []
  for (let i = 0; i < expected; i++) {
    const time = start + i * interval
    const candle = byTime.get(time)
    if (candle) candles.push(candle)
    else missing.push(time)
  }
  return { candles, missing }
}

const series = {}
const errors = []
for (const symbol of symbols) {
  for (const minutes of INTERVALS) {
    try {
      series[`${symbol}:${minutes}`] = await fetchSeries(symbol, minutes)
      const entry = series[`${symbol}:${minutes}`]
      console.error(`${symbol} ${minutes}m: ${entry.candles.length} candles, ${entry.missing.length} missing`)
    } catch (error) {
      errors.push({ symbol, minutes, message: String(error.message || error) })
      console.error(`ERROR ${symbol} ${minutes}m: ${error.message || error}`)
    }
  }
}
writeFileSync(outFile, JSON.stringify({ source: "BingX public swap v3 klines", start, endExclusive, symbols, errors, series }), { mode: 0o600 })
console.error(`wrote ${outFile}: ${symbols.length} symbols, ${errors.length} errors`)
if (errors.length > 0) process.exitCode = 1
