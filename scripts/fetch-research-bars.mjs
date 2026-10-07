#!/usr/bin/env node
/**
 * Fetch real one-minute bars from BingX's public perpetual-swap endpoint for
 * whole UTC days and cache them as JSON (one file per symbol and day).
 *
 *   node scripts/fetch-research-bars.mjs <cache-dir> <first-day YYYY-MM-DD> <days> SYMBOL[,SYMBOL...]
 *
 * Public market data only: no credentials are read or sent. A day file is
 * written only when it holds all 1,440 bars; gaps are listed in
 * <cache-dir>/gaps.json so a report can show them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const [cacheDir, firstDay, dayCountArg, symbolArg] = process.argv.slice(2)
if (!cacheDir || !firstDay || !dayCountArg || !symbolArg) {
  console.error("usage: fetch-research-bars.mjs <cache-dir> <first-day> <days> SYMBOLS")
  process.exit(2)
}
const DAY_MS = 86_400_000
const MINUTE_MS = 60_000
const symbols = symbolArg.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
const firstMs = Date.parse(`${firstDay}T00:00:00Z`)
const days = Number(dayCountArg)
if (!Number.isFinite(firstMs) || !(days > 0)) throw new Error("invalid day range")
if (firstMs + days * DAY_MS > Math.floor(Date.now() / DAY_MS) * DAY_MS) throw new Error("range includes an incomplete UTC day")
mkdirSync(cacheDir, { recursive: true })

const venueSymbol = (symbol) => symbol.replace(/USDT$/, "-USDT")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchBars(symbol, startMs, endMs) {
  const url = new URL("https://open-api.bingx.com/openApi/swap/v3/quote/klines")
  url.searchParams.set("symbol", venueSymbol(symbol))
  url.searchParams.set("interval", "1m")
  url.searchParams.set("startTime", String(startMs))
  url.searchParams.set("endTime", String(endMs - 1))
  url.searchParams.set("limit", "1440")
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
      const body = await response.json()
      if (body?.code === 0 && Array.isArray(body.data)) return body.data
      throw new Error(`code ${body?.code}: ${body?.msg}`)
    } catch (error) {
      if (attempt === 5) throw error
      await sleep(500 * 2 ** attempt)
    }
  }
  return []
}

const gapsFile = path.join(cacheDir, "gaps.json")
const gaps = existsSync(gapsFile) ? JSON.parse(readFileSync(gapsFile, "utf8")) : {}
for (const symbol of symbols) {
  for (let day = 0; day < days; day++) {
    const startMs = firstMs + day * DAY_MS
    const label = new Date(startMs).toISOString().slice(0, 10)
    const file = path.join(cacheDir, `${symbol}_${label}.json`)
    if (existsSync(file)) continue
    const raw = await fetchBars(symbol, startMs, startMs + DAY_MS)
    const byMinute = new Map()
    for (const bar of raw) {
      const timestamp = Number(bar.time)
      if (timestamp < startMs || timestamp >= startMs + DAY_MS || timestamp % MINUTE_MS !== 0) continue
      byMinute.set(timestamp, {
        timestamp,
        open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close),
        volume: Number(bar.volume),
      })
    }
    const bars = [...byMinute.values()].sort((a, b) => a.timestamp - b.timestamp)
    const missing = 1440 - bars.length
    if (missing > 0) gaps[`${symbol}_${label}`] = missing
    else delete gaps[`${symbol}_${label}`]
    writeFileSync(file, JSON.stringify(bars))
    console.log(`${symbol} ${label}: ${bars.length} bars${missing > 0 ? ` (${missing} missing)` : ""}`)
    await sleep(150)
  }
}
writeFileSync(gapsFile, JSON.stringify(gaps, null, 2))
